import { NativeModules, Platform } from "react-native";
import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { AdvancedChatEngine } from "@locallab/chat-engine-advanced";
import { SQLiteChatHistory } from "@locallab/chat-history";
import { SQLitePersonaLibrary } from "@locallab/personas-library";
import {
  SQLiteGroupConfigStore,
  defaultGroupRoomSettings,
  emptyGroupParticipant,
  type GroupRoomDraft,
} from "@locallab/groups-config";
import { ModelLeaseRegistry } from "@locallab/groups-parallel";
import type { BlobStore } from "@locallab/storage-blobs";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { openMobileDatabase } from "../../platform/database-open";
import {
  createGenerationSession,
  type GenerationSession,
} from "../../platform/generation-session";
import { openMobileBlobStore } from "../../platform/files";
import { createLocalChatPort } from "../../platform/local-chat-provider";
import { getGrammarGuard } from "../../platform/grammar-guard";
import { readDeviceCapacity } from "../../platform/device-capacity";
import { createId as createChatId } from "../../platform/crypto";
import { GroupTurnDriver } from "../../composition/chat/group-driver";
import {
  GroupModelRuntime,
  groupModelKey,
  resolveSharedRoomBinding,
} from "../../composition/chat/group-runtime";
import { createProviderBinding } from "../../composition/first-run-chat";
import {
  runBenchMatrix,
  type BenchPorts,
  type BenchRunOptions,
  type BenchRunOutcome,
  type BenchScenarioHandle,
} from "./core";
import {
  BENCH_PERSONAS,
  assembleManifest,
  type BenchManifest,
  type BenchPlan,
  type BenchRunRecord,
} from "./matrix";
import { createRecordingPort } from "./recorder";
import {
  createExpoChatAttachmentExtraction,
  createMobileChatAttachmentIntake,
} from "../../composition/chat/attachments";
import {
  deleteConversation,
  runConversationCleanups,
  type ConversationCleanupPorts,
} from "../../composition/chat/conversation-lifecycle";
import { createStarterAvatarAttacher } from "../../platform/starter-avatars";
/**
 * T180 dev runner: the REAL group runtime (route bootstrap mirrored
 * verbatim) driving the benchmark matrix, so on-device manifests are valid
 * T179 row-3 evidence. T181: mounted unconditionally in Settings (owner
 * request); no env gate.
 */

const LOCAL_GGUF_PROVIDER_ID = "00000000-0000-7000-8000-000000000026";

/** Mirror of the route's module-local ensureRoomModel (providers/models rows). */
async function ensureBenchRoomModel(
  db: SQLiteDatabasePort,
  modelId: string,
): Promise<string> {
  await db.runAsync(
    "INSERT INTO providers(id,kind,name,config_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    LOCAL_GGUF_PROVIDER_ID,
    "local-gguf",
    "local-gguf",
    "{}",
    new Date().toISOString(),
  );
  const existing = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM models WHERE provider_id=? AND name=?",
    LOCAL_GGUF_PROVIDER_ID,
    modelId,
  );
  if (existing) return existing.id;
  const id = createChatId();
  await db.runAsync(
    "INSERT INTO models(id,provider_id,name,runtime,format,capabilities_json,created_at) VALUES(?,?,?,?,?,?,?)",
    id,
    LOCAL_GGUF_PROVIDER_ID,
    modelId,
    "llama.rn",
    "gguf",
    JSON.stringify({ streaming: true }),
    new Date().toISOString(),
  );
  return id;
}
export interface BenchSession {
  ports: BenchPorts;
  run(options: BenchRunOptions): Promise<BenchRunOutcome>;
  manifestFor(
    outcome: BenchRunOutcome,
    input: {
      roundsPerScenario: number;
      responseLimitTokens: number;
      modelNames?: Record<string, string>;
    },
  ): BenchManifest;
  writeAndShareManifest(
    manifest: BenchManifest,
  ): Promise<{ fileName: string; uri: string }>;
  /** Crash-safe manifest rewritten after every completed scenario so a
   * device crash never loses finished rows (T181). */
  writeCheckpoint(manifest: BenchManifest): { fileName: string; uri: string };
  dispose(): Promise<void>;
}

/** Opens the real services; one session per Run press. */
export async function createBenchSession(): Promise<BenchSession> {
  const database = await openMobileDatabase();
  const generationSession: GenerationSession = await createGenerationSession();
  await SQLiteGroupConfigStore.initialize(database);
  const config = new SQLiteGroupConfigStore(database);
  const blobs: BlobStore = await openMobileBlobStore(database);
  const history = new SQLiteChatHistory(database);
  const library = new SQLitePersonaLibrary(database, {
    createId: createChatId,
  });
  await library.initialize();

  const intake = await createMobileChatAttachmentIntake({
    db: database,
    blobs,
    createId: createChatId,
  });
  const cleanupPorts: ConversationCleanupPorts = {
    releaseAttachment: (ownerId, attachmentId) =>
      intake.attachments.release(ownerId, attachmentId),
    removeBlobReference: (blobId, owner) =>
      blobs.removeReference(blobId, owner),
  };
  // T181 self-heal: a crashed or stopped session can leave bench rooms,
  // conversations and allocation keys behind; reruns died on "Allocated
  // conversation is missing". Sweep everything bench-shaped first, then
  // finish any queued file cleanups.
  await sweepStaleBenchSessions(database);
  await runConversationCleanups(database, cleanupPorts).catch(() => {});

  // Stable bench personas: reused across runs, deleted at session teardown.
  // Older installs (and crashed sessions, which skip teardown) left "Bench X"
  // rows behind; adopt one by legacy name and rename it instead of creating a
  // duplicate. Each persona gets its bundled bust as an avatar through the
  // managed attachment path (owner feedback: the bench rows were unnamed,
  // avatar-less clutter in the persona picker).
  const personaIds = new Map<string, string>();
  const keyByPersonaId = new Map<string, string>();
  const attachAvatar = createStarterAvatarAttacher({
    attachments: intake.attachments,
    extraction: createExpoChatAttachmentExtraction(),
  });
  for (const spec of BENCH_PERSONAS) {
    const records = await library.list();
    const existing =
      records.find((persona) => persona.name === spec.name) ??
      (spec.legacyNames ?? [])
        .map((legacy) => records.find((persona) => persona.name === legacy))
        .find((persona) => persona !== undefined);
    let record = existing;
    if (record) {
      const patch: Parameters<typeof library.update>[1] = {};
      if (record.name !== spec.name) patch.name = spec.name;
      if (record.prompt !== spec.prompt) patch.prompt = spec.prompt;
      if (record.photoAttachmentId === null) {
        const avatarId = await attachAvatar({
          key: `bench-${spec.key}`,
          id: record.id,
        });
        if (avatarId !== null) patch.photoAttachmentId = avatarId;
      }
      if (Object.keys(patch).length > 0) {
        record = await library.update(record.id, patch);
      }
    } else {
      record = await library.create({ name: spec.name, prompt: spec.prompt });
      const avatarId = await attachAvatar({
        key: `bench-${spec.key}`,
        id: record.id,
      });
      if (avatarId !== null) {
        record = await library.update(record.id, {
          photoAttachmentId: avatarId,
        });
      }
    }
    personaIds.set(spec.key, record.id);
    keyByPersonaId.set(record.id, spec.key);
  }
  const capacity = readDeviceCapacity();
  // Surface grammar-quarantine state (T183) in manifests; crash-harvest runs at boot anyway.
  void getGrammarGuard().ready();

  const runStamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const benchDirectory = () => {
    const directory = new Directory(Paths.document, "locallab", "bench");
    directory.create({ intermediates: true, idempotent: true });
    return directory;
  };
  const writeManifestFile = (suffix: string, manifest: BenchManifest) => {
    const fileName = `group-bench-${runStamp}${suffix}.json`;
    const file = new File(benchDirectory(), fileName);
    file.create({ overwrite: true });
    file.write(JSON.stringify(manifest, null, 2));
    return { fileName, uri: file.uri };
  };

  const ports: BenchPorts = {
    personaKeyFor: (personaId) =>
      personaId === null ? null : (keyByPersonaId.get(personaId) ?? null),
    probe: async () => ({
      thermal: processThermalState(),
      memoryBytes: capacity.availableMemoryBytes,
    }),
    now: () => Date.now(),
    openScenario: async (plan, scenarioOptions) => {
      const allocated = await history.allocateConversation({
        allocationKey: `dev-bench-${plan.index}-${plan.modelId}`,
        id: createChatId(),
        now: new Date().toISOString(),
        title: `DEV BENCH ${plan.index}`,
      });
      const conversationId = allocated.conversation.id;
      const draft = benchRoomDraft(
        plan,
        personaIds,
        conversationId,
        scenarioOptions.responseLimitTokens,
      );
      const roomId = await config.saveRoom(draft, createChatId);
      const room = await config.loadRoom(roomId);
      if (!room) throw new Error(`Bench room ${roomId} vanished.`);
      const modelId = `blob:${plan.modelId.replace(/^blob:/, "")}`;
      const modelRecordId = await ensureBenchRoomModel(database, modelId);
      const shared = resolveSharedRoomBinding(modelId, [
        {
          providerConnectionId: LOCAL_GGUF_PROVIDER_ID,
          modelRecordId,
          modelId,
        },
      ]);
      if (shared === null) throw new Error(`Model ${modelId} not resolvable.`);
      const records: BenchRunRecord[] = [];
      const engine = new AdvancedChatEngine({
        db: database,
        createId: createChatId,
        generationOwner: generationSession.owner,
        context: {
          tokenBudget: 4096,
          reservedOutputTokens: scenarioOptions.responseLimitTokens,
          policy: "roll",
        },
      });
      const binding = createProviderBinding({
        connectionId: LOCAL_GGUF_PROVIDER_ID,
        providerId: LOCAL_GGUF_PROVIDER_ID,
        modelRecordId: shared.modelRecordId,
        modelId: shared.modelId,
        port: createRecordingPort(createLocalChatPort(blobs), records),
      });
      const runtime = new GroupModelRuntime({
        registry: new ModelLeaseRegistry(),
        hostKey: "dev-bench",
        modelKey: groupModelKey(shared),
      });
      const driver = new GroupTurnDriver({
        engine,
        config,
        runtime,
        createId: createChatId,
      });
      const handle: BenchScenarioHandle = {
        room,
        binding,
        records,
        startTurn: (options) => driver.startTurn(options),
        stop: async () => {
          await driver.stopCurrent("Stopped by user");
        },
        dispose: async () => {
          await runtime.release(); // unload the GGUF between scenarios
          await deleteBenchRoom(database, roomId, room.conversationId);
        },
      };
      return handle;
    },
  };

  return {
    ports,
    run: (options) => runBenchMatrix(ports, options),
    manifestFor: (outcome, input) =>
      assembleManifest({
        generatedAt: new Date().toISOString(),
        device: Constants.deviceName ?? Platform.OS,
        iosVersion:
          Platform.OS === "ios"
            ? String(Platform.constants?.osVersion ?? "unknown")
            : Platform.OS,
        appVersion: Constants.expoConfig?.version ?? "unknown",
        buildNumber: Constants.expoConfig?.ios?.buildNumber ?? "unknown",
        roundsPerScenario: input.roundsPerScenario,
        responseLimitTokens: input.responseLimitTokens,
        deviceMemoryBytes: capacity.availableMemoryBytes,
        ...(input.modelNames ? { modelNames: input.modelNames } : {}),
        scenarios: outcome.scenarios,
        notes: [
          ...getGrammarGuard()
            .quarantined()
            .map(
              (entry) =>
                `json mode quarantined for ${entry.modelId} — topic selection ran in text mode (${entry.reason})`,
            ),
          ...(outcome.stopped ? ["Run stopped early; partial matrix."] : []),
          ...defaultNotes(),
        ],
      }),
    writeAndShareManifest: async (manifest) => {
      const saved = writeManifestFile("", manifest);
      if (await isAvailableAsync()) await shareAsync(saved.uri);
      return saved;
    },
    writeCheckpoint: (manifest) => writeManifestFile("-partial", manifest),
    dispose: async () => {
      for (const id of personaIds.values()) {
        await library.delete(id).catch(() => {});
      }
      // Release blob owners queued by the scenario deletes before closing.
      await runConversationCleanups(database, cleanupPorts).catch(() => {});
      await generationSession.dispose();
    },
  };
}

/** RN exposes the process thermal state as a native module on iOS 15.4+; the
 * untyped guarded access keeps us off a second native dependency. */
function processThermalState(): string {
  const thermal = (NativeModules as Record<string, unknown>)
    .ProcessThermalState as
    | { getProcessThermalState?: () => string }
    | undefined;
  return thermal?.getProcessThermalState?.() ?? "unknown";
}

function defaultNotes(): string[] {
  return [
    "Latencies are wall-clock per run at the provider port.",
    "Peak RSS is not observable from the app; thermal state is recorded live.",
    "memoryBytes fields repeat the static onboarding fit estimate (55% of Device.totalMemory), not free RAM.",
  ];
}

async function deleteBenchRoom(
  db: SQLiteDatabasePort,
  roomId: string,
  conversationId: string,
): Promise<void> {
  // group_participants has no cascade; everything else chains (T180 card).
  await db.runAsync(
    "DELETE FROM group_participants WHERE group_room_id=?",
    roomId,
  );
  await db.runAsync("DELETE FROM group_rooms WHERE id=?", roomId);
  // T181: production delete — messages, messages owners, allocations, metadata and
  // lifecycle rows chain here. The hand-rolled DELETE left allocation keys
  // behind and broke reruns with "Allocated conversation is missing".
  await deleteConversation(db, conversationId);
}

/** T181 self-heal: remove rooms, conversations and allocation keys left by
 * a crashed or stopped session so the next run starts from a clean slate. */
async function sweepStaleBenchSessions(db: SQLiteDatabasePort): Promise<void> {
  const rooms = await db.getAllAsync<{ id: string; conversation_id: string }>(
    "SELECT id,conversation_id FROM group_rooms WHERE name LIKE 'DEV BENCH %'",
  );
  for (const room of rooms) {
    await db.runAsync(
      "DELETE FROM group_participants WHERE group_room_id=?",
      room.id,
    );
    await db.runAsync("DELETE FROM group_rooms WHERE id=?", room.id);
    await deleteConversation(db, room.conversation_id);
  }
  const allocated = await db.getAllAsync<{ conversation_id: string }>(
    "SELECT conversation_id FROM chat_history_allocations WHERE allocation_key LIKE 'dev-bench-%'",
  );
  for (const row of allocated)
    await deleteConversation(db, row.conversation_id);
  const titled = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM conversations WHERE title LIKE 'DEV BENCH %'",
  );
  for (const row of titled) await deleteConversation(db, row.id);
}

function benchRoomDraft(
  plan: BenchPlan,
  personaIds: Map<string, string>,
  conversationId: string,
  responseLimitTokens: number,
): GroupRoomDraft {
  return {
    id: null,
    name: `DEV BENCH ${plan.index} ${plan.seats}x${plan.policy}`,
    scenario: "",
    userDisplayName: "Bench",
    conversationId,
    settings: {
      ...defaultGroupRoomSettings(),
      speakerOrder: plan.policy,
      sharedModelId: `blob:${plan.modelId.replace(/^blob:/, "")}`,
      responseLimitTokens,
    },
    participants: plan.personaKeys.map((key) => ({
      ...emptyGroupParticipant(),
      personaId: personaIds.get(key) ?? null,
      displayName:
        BENCH_PERSONAS.find((persona) => persona.key === key)?.name ?? key,
      accentColor: "#888888",
      systemPrompt:
        BENCH_PERSONAS.find((persona) => persona.key === key)?.prompt ?? "",
    })),
  };
}

/** Already-written manifest files (the "-partial" checkpoints survive an
 * app crash); newest name first — the run stamp is embedded and sortable. */
export function listBenchManifests(): { fileName: string; uri: string }[] {
  const directory = new Directory(Paths.document, "locallab", "bench");
  if (!directory.exists) return [];
  return directory
    .list()
    .filter(
      (entry): entry is File =>
        entry instanceof File &&
        entry.name.startsWith("group-bench-") &&
        entry.name.endsWith(".json"),
    )
    .map((file) => ({ fileName: file.name, uri: file.uri }))
    .sort((a, b) => b.fileName.localeCompare(a.fileName));
}
