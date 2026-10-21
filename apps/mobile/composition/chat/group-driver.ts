import type { ChatBinding } from "@locallab/chat-engine-core";
import type { ContextMessage } from "@locallab/context";
import type { RunEvent } from "@locallab/contracts/run-events";
import type {
  GroupParticipantDraft,
  GroupRoomDraft,
  GroupRoundRecord,
  GroupRoundStatus,
  GroupRoundTrigger,
  GroupRunStatus,
  GroupRoomSettings,
  GroupSpeakerRun,
} from "@locallab/groups-config";
import {
  diceOrder,
  planTopicInterestOrder,
  roundRobinOrder,
  type GroupSelectorPort,
  type GroupSelectorSeat,
} from "@locallab/groups-turns";
import type { GroupTranscriptEntry } from "../../features/group-chat";
import { applyDrunkWindow, type GroupContextItem } from "./group-context";
import type { GroupModelRuntime } from "./group-runtime";

/** Engine surface the driver needs; matches AdvancedChatEngine's group API. */
export interface GroupDriverEngine {
  isGroupRoundActive(conversationId: string): boolean;
  beginGroupRound(conversationId: string, roundId: string): void;
  endGroupRound(conversationId: string, roundId: string): void;
  appendUserMessage(input: {
    conversationId: string;
    text: string;
  }): Promise<string>;
  beginAssistantTurn(input: {
    conversationId: string;
    participantId?: string;
    binding: ChatBinding;
    parameters?: Readonly<Record<string, unknown>>;
    preparedMessages: readonly ContextMessage[];
    requiredMessageIds?: readonly string[];
    json?: boolean;
  }): Promise<GroupAssistantHandle>;
}

export interface GroupAssistantHandle {
  readonly runId: string;
  readonly assistantMessageId: string;
  readonly events: AsyncIterable<RunEvent>;
  stop(reason?: string): Promise<void>;
}

/** Group-config surface the driver needs; matches SQLiteGroupConfigStore. */
export interface GroupDriverConfig {
  beginRound(
    roomId: string,
    conversationId: string,
    start: {
      trigger: GroupRoundTrigger;
      frozenOrder: readonly number[];
      settings: GroupRoomSettings;
    },
    createId: () => string,
  ): Promise<GroupRoundRecord>;
  setRoundStatus(
    roundId: string,
    status: GroupRoundStatus,
    seatCursor: number,
  ): Promise<void>;
  beginSpeakerRun(
    roundId: string,
    seatIndex: number,
    participantId: string | null,
    modelId: string | null,
    createId: () => string,
  ): Promise<string>;
  finishSpeakerRun(runId: string, status: GroupRunStatus): Promise<void>;
  latestRound(roomId: string): Promise<{
    round: GroupRoundRecord;
    runs: GroupSpeakerRun[];
  } | null>;
}

/** UI-facing progress feed for one round. */
export interface GroupTurnPresenter {
  /** Seat-level status; "failed" means that seat's run errored. */
  onStatus(seatIndex: number, status: "thinking" | "done" | "failed"): void;
  /** One finished user or participant row, published as it completes. */
  onEntry(entry: GroupTranscriptEntry): void;
  /** Cumulative in-progress text for the live presentation mode. */
  onDelta?(seatIndex: number, fullText: string): void;
}

export interface GroupTurnOptions {
  room: GroupRoomDraft;
  trigger: GroupRoundTrigger;
  /** Composer text for Send and, when present, for Ask. */
  userText?: string;
  askSeatIndex?: number;
  /** Completed transcript at round start (route projection). */
  history: readonly GroupTranscriptEntry[];
  /** Shared-model binding resolved from room settings (T174 resolver). */
  binding: ChatBinding;
  presenter: GroupTurnPresenter;
  signal?: AbortSignal;
  /** Seat system prompt override; defaults to scenario + persona + Drunk. */
  seatInstruction?: (
    seat: GroupParticipantDraft,
    room: GroupRoomDraft,
  ) => string;
  /** Dice seed; random when omitted (a saved seed replays a round). */
  seed?: number;
}

export interface GroupTurnResult {
  round: GroupRoundRecord;
  status: Exclude<GroupRoundStatus, "active">;
  entries: GroupTranscriptEntry[];
}

export interface GroupTurnDriverDeps {
  engine: GroupDriverEngine;
  config: GroupDriverConfig;
  /** Room runtime serializes every generation onto the one shared model. */
  runtime: Pick<GroupModelRuntime, "schedule">;
  createId: () => string;
}

/** Room-level Drunk persona style line; seatInstruction overrides reuse it. */
export const DRUNK_STYLE =
  "You feel a little drunk: be looser, funnier and more impulsive, and keep replies short.";
const PASS_NOTE =
  "The user passed without adding a message; continue the conversation as your participant.";
const ASK_NOTE =
  "The user directed this message to you specifically. Answer as your participant now.";
/** Room labels must never render blank; matches the route's transcript fallback. */
function seatLabel(seat: GroupParticipantDraft): string {
  return seat.displayName.trim() === "" ? "Participant" : seat.displayName;
}

/**
 * The note MUST name which speaker label is "yourself": every seat's line is
 * role `assistant` carrying only an in-band "<name>: " prefix, so without an
 * explicit binding a model cannot tell its own lines from other seats' — the
 * parroting / no-personal-continuity defect (T179 row 3 device runs).
 */
function transcriptNote(name: string): string {
  return (
    `Earlier room lines are prefixed with their speaker name. ` +
    `Your name in this room is "${name}": lines prefixed "${name}:" are your ` +
    `own earlier messages. Reply only as yourself, with no name prefix.`
  );
}

/**
 * Removes a speaker's own transcript prefix echoed at the start of its reply
 * or at line starts; re-labelling would otherwise compound it every round
 * (device evidence: doubled "Bench Pirate:" prefixes).
 */
export function stripSpeakerPrefix(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const leading = new RegExp(`^[ \\t]*${escaped}[ \\t]*:[ \\t]*`, "i");
  const lineStart = new RegExp(
    `(\\n)[ \\t]*${escaped}[ \\t]*:[ \\t]*`,
    "gi",
  );
  let out = text;
  for (let guard = 0; guard < 4; guard += 1) {
    const next = out.replace(leading, "");
    if (next === out) break;
    out = next;
  }
  return out.replace(lineStart, "\n").trimStart();
}

/**
 * Runs one group round end to end: exactly one user row per Send/Ask, a
 * frozen seat order, and seat replies attributed and published as they
 * land. Stop (aborting the signal) cancels the in-flight seat and prevents
 * later seats from starting; completed replies stay. A provider failure
 * marks that seat's run failed and the round continues (GR-09).
 */
export class GroupTurnDriver {
  private currentStop: ((reason?: string) => Promise<void>) | undefined;
  /** Set when Stop was requested; cancels now and blocks later seats. */
  private stopping = false;

  constructor(private readonly deps: GroupTurnDriverDeps) {}

  /** Mid-round Stop: cancel the in-flight seat; later seats never start. */
  async stopCurrent(reason?: string): Promise<boolean> {
    this.stopping = true;
    if (!this.currentStop) return false;
    await this.currentStop(reason);
    return true;
  }

  async startTurn(options: GroupTurnOptions): Promise<GroupTurnResult> {
    const { engine, config, createId } = this.deps;
    const room = options.room;
    if (!room.id) throw new Error("Save the room before starting a round.");
    if (room.participants.length === 0)
      throw new Error("The room has no participants.");
    if (engine.isGroupRoundActive(room.conversationId))
      throw new Error("A round is already running in this conversation.");

    const latest = await config.latestRound(room.id);
    const cursor = latest?.round.seatCursor ?? 0;
    this.stopping = false;
    this.currentStop = undefined;
    const roundId = createId();
    // The topic-interest selector is an assistant-only run, so the
    // conversation guard must already be held; beginRound reuses this id.
    engine.beginGroupRound(room.conversationId, roundId);
    const entries: GroupTranscriptEntry[] = [];
    let round: GroupRoundRecord | undefined;
    let status: Exclude<GroupRoundStatus, "active"> = "completed";
    let seatCursor = cursor;
    try {
      const frozenOrder = await this.frozenOrder(options, cursor);
      round = await config.beginRound(
        room.id,
        room.conversationId,
        { trigger: options.trigger, frozenOrder, settings: room.settings },
        () => roundId,
      );
      if (options.userText !== undefined) {
        const userMessageId = await engine.appendUserMessage({
          conversationId: room.conversationId,
          text: options.userText,
        });
        const userEntry: GroupTranscriptEntry = {
          id: userMessageId,
          speakerSeat: -1,
          speakerName: room.userDisplayName || "You",
          accentColor: "",
          text: options.userText,
        };
        entries.push(userEntry);
        options.presenter.onEntry(userEntry);
      }
      const seats = await this.runSeats(
        options,
        round.id,
        frozenOrder,
        entries,
      );
      status = seats.status;
      seatCursor = seats.cursor;
    } catch (error) {
      status = "failed";
      throw error;
    } finally {
      engine.endGroupRound(room.conversationId, roundId);
      this.currentStop = undefined;
      if (round) await config.setRoundStatus(round.id, status, seatCursor);
    }
    if (!round) throw new Error("Round could not be started.");
    return { round, status, entries };
  }

  private async frozenOrder(
    options: GroupTurnOptions,
    cursor: number,
  ): Promise<number[]> {
    const count = options.room.participants.length;
    if (options.trigger === "ask") {
      const seat = options.askSeatIndex;
      if (
        seat === undefined ||
        !Number.isInteger(seat) ||
        seat < 0 ||
        seat >= count
      )
        throw new Error("Ask needs a seat in this room.");
      return [seat];
    }
    switch (options.room.settings.speakerOrder) {
      case "dice":
        return diceOrder(
          count,
          options.seed ?? Math.floor(Math.random() * 0x1_0000_0000),
        );
      case "topic-interest": {
        const text =
          options.userText ??
          [...options.history]
            .reverse()
            .find((entry) => entry.speakerSeat === -1)?.text;
        if (text === undefined) return roundRobinOrder(count, cursor);
        const seats: GroupSelectorSeat[] = options.room.participants.map(
          (seat, index) => ({
            // Unsaved rooms never run a selector round; seat rows exist
            // once a room is saved, which startTurn already required.
            id: seat.id ?? `missing-seat-${index}`,
            displayName: seat.displayName,
            scenario: seat.systemPrompt,
          }),
        );
        return planTopicInterestOrder(
          seats,
          text,
          this.selectorPort(options),
          options.signal,
        );
      }
      default:
        return roundRobinOrder(count, cursor);
    }
  }

  /**
   * Topic-interest selector: one assistant-only JSON call inside the round
   * guard, serialized through the room runtime like every other generation.
   * Its reply row is unattributed; the route hides unattributed assistant
   * rows from the room transcript.
   */
  private selectorPort(options: GroupTurnOptions): GroupSelectorPort {
    const { engine, runtime, createId } = this.deps;
    return {
      generateSelector: async ({ prompt, signal }) => {
        const promptId = createId();
        const handle = await runtime.schedule(
          () =>
            engine.beginAssistantTurn({
              conversationId: options.room.conversationId,
              binding: options.binding,
              json: true,
              preparedMessages: [
                {
                  id: promptId,
                  role: "user",
                  parts: [{ type: "text", text: prompt }],
                },
              ],
              requiredMessageIds: [promptId],
            }),
          signal,
        );
        return consumeRun(handle, signal);
      },
    };
  }

  private async runSeats(
    options: GroupTurnOptions,
    roundId: string,
    frozenOrder: readonly number[],
    entries: GroupTranscriptEntry[],
  ): Promise<{
    status: Exclude<GroupRoundStatus, "active">;
    cursor: number;
  }> {
    const { engine, config, runtime, createId } = this.deps;
    const room = options.room;
    const count = room.participants.length;
    let stopped = false;
    let lastSpoke = -1;
    let stoppedAt: number | undefined;
    for (const seatIndex of frozenOrder) {
      if (this.stopping || options.signal?.aborted) {
        stopped = true;
        stoppedAt = seatIndex;
        break;
      }
      const seat = room.participants[seatIndex];
      if (!seat) throw new Error(`Seat ${seatIndex} is missing.`);
      const speakerRunId = await config.beginSpeakerRun(
        roundId,
        seatIndex,
        seat.id,
        options.binding.modelId,
        createId,
      );
      options.presenter.onStatus(seatIndex, "thinking");
      try {
        const prepared = this.buildPrepared(options, seat, entries);
        const handle = await runtime.schedule(async () => {
          const started = await engine.beginAssistantTurn({
            conversationId: room.conversationId,
            ...(seat.id ? { participantId: seat.id } : {}),
            binding: options.binding,
            ...(room.settings.responseLimitTokens === undefined
              ? {}
              : {
                  parameters: {
                    max_tokens: room.settings.responseLimitTokens,
                  },
                }),
            preparedMessages: prepared.messages,
            requiredMessageIds: prepared.requiredMessageIds,
          });
          // Stop pressed while this seat was starting: cancel it now.
          if (this.stopping || options.signal?.aborted) {
            await started.stop("Stopped by user").catch(() => undefined);
          }
          this.currentStop = started.stop;
          return started;
        }, options.signal);
        const text = await consumeRun(
          handle,
          options.signal,
          room.settings.replyDisplay === "live" && options.presenter.onDelta
            ? (full) => options.presenter.onDelta?.(seatIndex, full)
            : undefined,
        );
        await config.finishSpeakerRun(speakerRunId, "completed");
        options.presenter.onStatus(seatIndex, "done");
        const entry: GroupTranscriptEntry = {
          id: handle.assistantMessageId,
          speakerSeat: seatIndex,
          speakerName: seatLabel(seat),
          accentColor: seat.accentColor,
          text: stripSpeakerPrefix(text, seatLabel(seat)),
        };
        entries.push(entry);
        options.presenter.onEntry(entry);
        lastSpoke = seatIndex;
      } catch {
        if (this.stopping || options.signal?.aborted) {
          await config.finishSpeakerRun(speakerRunId, "interrupted");
          stopped = true;
          stoppedAt = seatIndex;
          break;
        }
        await config.finishSpeakerRun(speakerRunId, "failed");
        options.presenter.onStatus(seatIndex, "failed");
        // One seat's provider failure never strands the round (GR-09);
        // the seat still had its turn, so the rotation moves past it.
        lastSpoke = seatIndex;
        continue;
      } finally {
        this.currentStop = undefined;
      }
    }
    const cursor =
      stopped && stoppedAt !== undefined
        ? ((stoppedAt % count) + count) % count
        : lastSpoke < 0
          ? 0
          : (lastSpoke + 1) % count;
    return { status: stopped ? "stopped" : "completed", cursor };
  }

  /** Per-seat context: system instruction + windowed transcript (GR-12/13). */
  private buildPrepared(
    options: GroupTurnOptions,
    seat: GroupParticipantDraft,
    roundEntries: readonly GroupTranscriptEntry[],
  ): { messages: ContextMessage[]; requiredMessageIds: string[] } {
    const { createId } = this.deps;
    const room = options.room;
    const instructionId = createId();
    const instruction = options.seatInstruction
      ? options.seatInstruction(seat, room)
      : [
          room.scenario.trim() === ""
            ? ""
            : `Room scenario: ${room.scenario.trim()}`,
          seat.systemPrompt.trim(),
          ...(seat.drunk ? [DRUNK_STYLE] : []),
        ]
          .filter((line) => line !== "")
          .join("\n\n");
    const notes = [
      transcriptNote(seatLabel(seat)),
      options.trigger === "ask" ? ASK_NOTE : "",
      options.trigger === "pass" ? PASS_NOTE : "",
    ].filter((line) => line !== "");
    const byId = new Map<string, GroupTranscriptEntry>();
    for (const entry of options.history) byId.set(entry.id, entry);
    for (const entry of roundEntries) byId.set(entry.id, entry);
    const roundUser = roundEntries.filter((entry) => entry.speakerSeat === -1);
    const roundReplies =
      room.settings.conversationMode === "independent"
        ? []
        : roundEntries.filter((entry) => entry.speakerSeat !== -1);
    const items: GroupContextItem[] = [
      ...options.history,
      ...roundUser,
      ...roundReplies,
    ].map((entry) => ({
      id: entry.id,
      kind: "history" as const,
      text:
        entry.speakerSeat === -1
          ? entry.text
          : `${entry.speakerName}: ${entry.text}`,
    }));
    const visible = seat.drunk ? applyDrunkWindow(items) : items;
    const messages: ContextMessage[] = visible.map((item) => {
      const entry = byId.get(item.id)!;
      return {
        id: entry.id,
        role:
          entry.speakerSeat === -1 ? ("user" as const) : ("assistant" as const),
        parts: [{ type: "text" as const, text: item.text }],
        ...(entry.speakerSeat >= 0 &&
        entry.speakerSeat < room.participants.length
          ? room.participants[entry.speakerSeat]!.id
            ? { participantId: room.participants[entry.speakerSeat]!.id! }
            : {}
          : {}),
      };
    });
    messages.unshift({
      id: instructionId,
      role: "system",
      parts: [
        {
          type: "text",
          text: [instruction, ...notes]
            .filter((line) => line !== "")
            .join("\n\n"),
        },
      ],
    });
    const newest = messages.at(-1);
    return {
      messages,
      requiredMessageIds: [instructionId, ...(newest ? [newest.id] : [])],
    };
  }
}

/** Collapse events to final text; live mode gets cumulative previews. */
async function consumeRun(
  handle: Pick<GroupAssistantHandle, "events">,
  signal: AbortSignal | undefined,
  onPreview?: (full: string) => void,
): Promise<string> {
  let full = "";
  let terminal: RunEvent | undefined;
  for await (const event of handle.events) {
    if (event.type === "TextDelta") {
      full += event.text;
      onPreview?.(full);
    } else if (
      event.type === "RunCompleted" ||
      event.type === "RunCanceled" ||
      event.type === "RunFailed"
    ) {
      terminal = event;
    }
  }
  if (terminal?.type === "RunCanceled")
    throw new Error(signal?.aborted ? "stopped" : "The reply was canceled.");
  if (terminal?.type === "RunFailed") throw new Error(terminal.error.message);
  return full;
}
