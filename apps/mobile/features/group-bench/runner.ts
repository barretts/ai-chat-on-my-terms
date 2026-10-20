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

/**
 * T180 dev-only runner: the REAL group runtime (route bootstrap mirrored
 * verbatim) driving the benchmark matrix, so on-device manifests are valid
 * T179 row-3 evidence. Dev builds only — the settings section mount is gated
 * by EXPO_PUBLIC_DEV_BENCH, and store builds fail on any EXPO_PUBLIC_DEV_*
 * var (app.config.js guard).
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

export function devBenchEnabled(): boolean {
  return process.env.EXPO_PUBLIC_DEV_BENCH === "1";
}

export interface BenchSession {
  ports: BenchPorts;
  run(options: BenchRunOptions): Promise<BenchRunOutcome>;
  manifestFor(
    outcome: BenchRunOutcome,
    input: { roundsPerScenario: number; responseLimitTokens: number },
  ): BenchManifest;
  writeAndShareManifest(
    manifest: BenchManifest,
  ): Promise<{ fileName: string; uri: string }>;
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

  // Stable bench personas: reused across runs, deleted at session teardown.
  const personaIds = new Map<string, string>();
  const keyByPersonaId = new Map<string, string>();
  for (const spec of BENCH_PERSONAS) {
    const existing = (await library.list()).find(
      (persona) => persona.name === spec.name,
    );
    const record =
      existing ??
      (await library.create({ name: spec.name, prompt: spec.prompt }));
    personaIds.set(spec.key, record.id);
    keyByPersonaId.set(record.id, spec.key);
  }

  const capacity = readDeviceCapacity();

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
        scenarios: outcome.scenarios,
        notes: outcome.stopped
          ? ["Run stopped early; partial matrix.", ...defaultNotes()]
          : defaultNotes(),
      }),
    writeAndShareManifest: async (manifest) => {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
      const directory = new Directory(Paths.document, "locallab", "bench");
      directory.create({ intermediates: true, idempotent: true });
      const fileName = `group-bench-${stamp}.json`;
      const file = new File(directory, fileName);
      file.create({ overwrite: true });
      file.write(JSON.stringify(manifest, null, 2));
      if (await isAvailableAsync()) await shareAsync(file.uri);
      return { fileName, uri: file.uri };
    },
    dispose: async () => {
      for (const id of personaIds.values()) {
        await library.delete(id).catch(() => {});
      }
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
    "Peak RSS is not observable from the app; thermal state and device memory are recorded instead.",
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
  await db.runAsync("DELETE FROM conversations WHERE id=?", conversationId);
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
