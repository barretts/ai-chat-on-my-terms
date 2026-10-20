import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Text } from "react-native-paper";
import { AdvancedChatEngine } from "@locallab/chat-engine-advanced";
import { SQLiteGroupConfigStore } from "@locallab/groups-config";
import type {
  GroupParticipantDraft,
  GroupRoomDraft,
} from "@locallab/groups-config";
import { SQLitePersonaLibrary } from "@locallab/personas-library";
import type { AudioResult, SpeechOutputPort } from "@locallab/audio-session";
import { ModelLeaseRegistry } from "@locallab/groups-parallel";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { ErrorNotice } from "../../features/diagnostics/error-notice";
import { GroupChatScreen } from "../../features/group-chat/screen";
import type {
  GroupSeatLive,
  GroupChatController,
} from "../../features/group-chat/screen";
import type { ChatBinding } from "@locallab/chat-engine-core";
import type { GroupTranscriptEntry } from "../../features/group-chat";
import { openMobileDatabase } from "../../platform/database-open";
import {
  createGenerationSession,
  type GenerationSession,
} from "../../platform/generation-session";
import { openMobileBlobStore } from "../../platform/files";
import { listInstalledModels } from "../../platform/model-download";
import { createLocalChatPort } from "../../platform/local-chat-provider";
import { createId as createChatId } from "../../platform/crypto";
import { mobileSpeech } from "../../platform/speech";
import { createProviderBinding } from "../first-run-chat";
import {
  DRUNK_STYLE,
  GroupTurnDriver,
  type GroupTurnPresenter,
} from "./group-driver";
import {
  GroupModelRuntime,
  groupModelKey,
  resolveSharedRoomBinding,
  type RoomModelBinding,
} from "./group-runtime";

/**
 * Room screen (`/group-chat?roomId=…`, T175). Loads the saved room, its
 * dedicated group conversation and the room's ONE shared model, then runs
 * Send/Pass/Ask rounds through GroupTurnDriver. Reopen after a crash shows
 * the saved transcript plus a "Start a new round" notice — a never-finished
 * round is NEVER auto-resumed.
 */

const LOCAL_GGUF_PROVIDER_ID = "00000000-0000-7000-8000-000000000026";

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  parts_json: string;
  selected_parts_json: string | null;
  participant_id: string | null;
}

function partsText(json: string): string {
  const parts = JSON.parse(json) as Array<{ type?: string; text?: string }>;
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

async function roomTranscript(
  db: SQLiteDatabasePort,
  room: GroupRoomDraft,
): Promise<GroupTranscriptEntry[]> {
  const rows = await db.getAllAsync<MessageRow>(
    `SELECT m.id,m.role,m.parts_json,m.participant_id,
       v.content_json AS selected_parts_json
     FROM messages m
     LEFT JOIN response_variants v ON v.message_id=m.id AND v.selected=1
     WHERE m.conversation_id=? ORDER BY m.sequence`,
    room.conversationId,
  );
  const seatByParticipant = new Map<string, GroupParticipantDraft>();
  for (const seat of room.participants) {
    if (seat.id) seatByParticipant.set(seat.id, seat);
  }
  const entries: GroupTranscriptEntry[] = [];
  for (const row of rows) {
    if (row.role === "assistant" && row.participant_id === null) {
      // The topic-interest selector's JSON reply is an unattributed
      // assistant row: NEVER part of the room transcript (GR-06).
      continue;
    }
    const json = row.selected_parts_json ?? row.parts_json;
    if (row.role === "user") {
      entries.push({
        id: row.id,
        speakerSeat: -1,
        speakerName:
          room.userDisplayName.trim() === "" ? "You" : room.userDisplayName,
        accentColor: "",
        text: partsText(json),
      });
      continue;
    }
    const seat = seatByParticipant.get(row.participant_id ?? "");
    entries.push({
      id: row.id,
      ...(seat
        ? {
            speakerSeat: room.participants.indexOf(seat),
            speakerName:
              seat.displayName.trim() === "" ? "Participant" : seat.displayName,
            accentColor: seat.accentColor,
          }
        : {
            speakerSeat: -2,
            speakerName: "Participant",
            accentColor: "",
          }),
      text: partsText(json),
    });
  }
  return entries;
}

/** Reuse (or insert) the provider/model rows for one installed GGUF. */
async function ensureRoomModel(
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

/** Offline TTS adapted to the transcript-playback port. */
const roomSpeech: SpeechOutputPort = {
  getAvailability: async (): Promise<
    AudioResult<"ready" | "permission" | "unavailable">
  > => ({ ok: true, value: "ready" }),
  isSpeaking: () => false,
  speak: async (text, options) => {
    try {
      await mobileSpeech.speak(text, options.voiceId, options.rate);
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
          recoverable: true,
        },
      };
    }
  },
  stop: async () => {
    try {
      await mobileSpeech.stop();
    } catch {
      // Idempotent: stopping already-idle playback must succeed.
    }
    return { ok: true, value: undefined };
  },
};

export default function GroupChatRoute() {
  const params = useLocalSearchParams<{ roomId?: string | string[] }>();
  const roomId = Array.isArray(params.roomId)
    ? params.roomId[0]
    : params.roomId;

  const [room, setRoom] = useState<GroupRoomDraft | null>(null);
  const [entries, setEntries] = useState<GroupTranscriptEntry[]>([]);
  const [live, setLive] = useState<GroupSeatLive | null>(null);
  const [running, setRunning] = useState(false);
  const [staleRoundId, setStaleRoundId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modelProblem, setModelProblem] = useState("");

  const driverRef = useRef<GroupTurnDriver | null>(null);
  const configRef = useRef<SQLiteGroupConfigStore | null>(null);
  const bindingRef = useRef<ChatBinding | null>(null);
  const modelRuntimeRef = useRef<GroupModelRuntime | null>(null);
  const personaPromptRef = useRef<Map<string, string>>(new Map());
  const entriesRef = useRef<GroupTranscriptEntry[]>([]);
  const liveRef = useRef<GroupSeatLive | null>(null);

  useEffect(() => {
    if (!roomId) {
      setError("Open this screen from a saved group room.");
      setLoading(false);
      return;
    }
    let mounted = true;
    let generationSession: GenerationSession | null = null;
    void openMobileDatabase()
      .then(async (database) => {
        generationSession = await createGenerationSession();
        await SQLiteGroupConfigStore.initialize(database);
        const config = new SQLiteGroupConfigStore(database);
        configRef.current = config;
        const saved = await config.loadRoom(roomId);
        if (!saved || !saved.conversationId) {
          throw new Error(
            "This group room no longer exists. Save it again from the Groups panel.",
          );
        }
        const blobs = await openMobileBlobStore(database);
        await blobs.recoverImports();
        const engine = new AdvancedChatEngine({
          db: database,
          createId: createChatId,
          generationOwner: generationSession.owner,
          context: {
            tokenBudget: 4096,
            reservedOutputTokens: saved.settings.responseLimitTokens ?? 512,
            policy: "roll",
          },
        });
        const installed = await listInstalledModels();
        const roomModels: RoomModelBinding[] = [];
        for (const model of installed) {
          const modelId = `blob:${model.blobId}`;
          roomModels.push({
            providerConnectionId: LOCAL_GGUF_PROVIDER_ID,
            modelRecordId: await ensureRoomModel(database, modelId),
            modelId,
          });
        }
        const shared = resolveSharedRoomBinding(
          saved.settings.sharedModelId,
          roomModels,
        );
        if (mounted) {
          if (shared === null) {
            setModelProblem(
              saved.settings.sharedModelId === null
                ? "This room has no shared model yet. Pick an installed GGUF as the room's shared model in its settings, then return here."
                : "The room's shared model is not installed on this device anymore. Install it from Models or pick another shared model in room settings.",
            );
          } else {
            bindingRef.current = createProviderBinding({
              connectionId: LOCAL_GGUF_PROVIDER_ID,
              providerId: LOCAL_GGUF_PROVIDER_ID,
              modelRecordId: shared.modelRecordId,
              modelId: shared.modelId,
              port: createLocalChatPort(blobs),
            });
            const modelRuntime = new GroupModelRuntime({
              registry: new ModelLeaseRegistry(),
              hostKey: "phone-local",
              modelKey: groupModelKey(shared),
            });
            modelRuntimeRef.current = modelRuntime;
            driverRef.current = new GroupTurnDriver({
              engine,
              config,
              runtime: modelRuntime,
              createId: createChatId,
            });
          }
        }
        const library = new SQLitePersonaLibrary(database, {
          createId: createChatId,
        });
        await library.initialize();
        personaPromptRef.current = new Map(
          (await library.list()).map((persona) => [persona.id, persona.prompt]),
        );
        // A round left "active" by a crash is stale: mark it stopped so the
        // conversation guard is free, but keep every saved reply. Completed
        // replies are never re-generated and the round never auto-resumes.
        const latest =
          saved.id === null ? null : await config.latestRound(saved.id);
        if (mounted && latest && latest.round.status === "active") {
          await config.setRoundStatus(
            latest.round.id,
            "stopped",
            latest.round.seatCursor,
          );
          setStaleRoundId(latest.round.id);
        }
        const history = await roomTranscript(database, saved);
        if (!mounted) return;
        entriesRef.current = history;
        setEntries(history);
        setRoom(saved);
      })
      .catch((cause: unknown) => {
        if (mounted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      void modelRuntimeRef.current?.release();
      modelRuntimeRef.current = null;
      void generationSession?.dispose();
    };
  }, [roomId]);

  // Release triggers (T174): backgrounding and leaving the room screen.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") void modelRuntimeRef.current?.release();
    });
    return () => subscription.remove();
  }, []);

  const clearLive = () => {
    liveRef.current = null;
    setLive(null);
  };
  const startRound = async (input: {
    trigger: "send" | "pass" | "ask";
    userText?: string;
    askSeatIndex?: number;
  }) => {
    const driver = driverRef.current;
    const binding = bindingRef.current;
    if (!driver || !room || !binding) return;
    if (room.id === null) return;
    setRunning(true);
    setError("");
    clearLive();
    try {
      const result = await driver.startTurn({
        room,
        trigger: input.trigger,
        ...(input.userText === undefined || input.userText === ""
          ? {}
          : { userText: input.userText }),
        ...(input.askSeatIndex === undefined
          ? {}
          : { askSeatIndex: input.askSeatIndex }),
        history: entriesRef.current,
        binding,
        seatInstruction: (seat, draft) =>
          [
            draft.scenario.trim() === ""
              ? ""
              : `Room scenario: ${draft.scenario.trim()}`,
            seat.personaId
              ? (personaPromptRef.current.get(seat.personaId) ?? "")
              : "",
            seat.systemPrompt.trim(),
            ...(seat.drunk ? [DRUNK_STYLE] : []),
          ]
            .filter((line) => line !== "")
            .join("\n\n"),
        presenter: {
          onStatus: (seatIndex, status) => {
            if (status === "thinking") {
              const seat = room.participants[seatIndex];
              const next: GroupSeatLive = {
                seatIndex,
                displayName:
                  seat && seat.displayName.trim() !== ""
                    ? seat.displayName
                    : `Participant ${seatIndex + 1}`,
                accentColor: seat?.accentColor ?? "",
                text: "",
              };
              liveRef.current = next;
              setLive(next);
              return;
            }
            liveRef.current = null;
            setLive(null);
          },
          onEntry: (entry) => {
            entriesRef.current = [...entriesRef.current, entry];
            setEntries(entriesRef.current);
          },
          onDelta: (seatIndex, fullText) => {
            const current = liveRef.current;
            if (!current || current.seatIndex !== seatIndex) return;
            const next = { ...current, text: fullText };
            liveRef.current = next;
            setLive(next);
          },
        },
      });
      // Live mode marks the stopped seat's streamed text as interrupted.
      const interrupted: GroupSeatLive | null = liveRef.current;
      if (
        result.status === "stopped" &&
        room.settings.replyDisplay === "live" &&
        interrupted !== null &&
        interrupted.text !== ""
      ) {
        const entry: GroupTranscriptEntry = {
          id: `stopped-${result.round.id}-${interrupted.seatIndex}`,
          speakerSeat: interrupted.seatIndex,
          speakerName: interrupted.displayName,
          accentColor: interrupted.accentColor,
          text: `${interrupted.text} (interrupted)`,
        };
        entriesRef.current = [...entriesRef.current, entry];
        setEntries(entriesRef.current);
      }
      if (result.status === "failed") {
        setError(
          "The round could not start completely. Saved replies stay in this chat.",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      clearLive();
      setRunning(false);
    }
  };

  const controller: GroupChatController = {
    running,
    hasConversation: entries.length > 0,
    staleRound: staleRoundId !== null,
    replyDisplay: room?.settings.replyDisplay ?? "complete",
    onSend: (text) => void startRound({ trigger: "send", userText: text }),
    onPass: () => void startRound({ trigger: "pass" }),
    onStop: () => {
      void driverRef.current?.stopCurrent("Stopped by user");
    },
    onStartNewRound: () => {
      if (staleRoundId === null || !configRef.current) return;
      // The stale round is already marked stopped; clear the notice only.
      setStaleRoundId(null);
    },
  };

  if (loading) {
    return <Text style={{ padding: 24 }}>Opening the group room…</Text>;
  }
  if (!room) {
    return (
      <ErrorNotice message={error || "This group room could not be opened."} />
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: room.name || "Group chat" }} />
      {error ? <ErrorNotice message={error} /> : null}
      {modelProblem ? <ErrorNotice message={modelProblem} /> : null}
      <GroupChatScreen
        room={room}
        entries={entries}
        speech={roomSpeech}
        controller={controller}
        live={live}
        onAsk={(seatIndex, text) =>
          void startRound({
            trigger: "ask",
            askSeatIndex: seatIndex,
            ...(text === "" ? {} : { userText: text }),
          })
        }
        onToolsToggle={(participants) => setRoom({ ...room, participants })}
      />
    </>
  );
}
