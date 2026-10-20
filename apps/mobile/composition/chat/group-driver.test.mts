import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatBinding } from "@locallab/chat-engine-core";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent } from "@locallab/contracts/run-events";
import type {
  GroupParticipantDraft,
  GroupRoomDraft,
  GroupRoomSettings,
  GroupRoundRecord,
  GroupSpeakerRun,
} from "@locallab/groups-config";
import type { GroupTranscriptEntry } from "../../features/group-chat";
import {
  GroupTurnDriver,
  type GroupAssistantHandle,
  type GroupDriverConfig,
  type GroupDriverEngine,
} from "./group-driver";

const conversationId = "018f0000-0000-7000-8000-000000000400";
const roomId = "018f0000-0000-7000-8000-000000000401";
const seatIds = [
  "018f0000-0000-7000-8000-000000000411",
  "018f0000-0000-7000-8000-000000000412",
  "018f0000-0000-7000-8000-000000000413",
];
const otherUserId = "018f0000-0000-7000-8000-000000000420";
const assistantIdBase = "018f0000-0000-7000-8000-00000000043";

let idCounter = 0;
function createId(): string {
  idCounter += 1;
  return `018f0000-0000-7000-8000-000000009${String(idCounter).padStart(3, "0")}`;
}

const port: ProviderPort = {
  listModels: async () => ({
    ok: false,
    error: { code: "unsupported", message: "unused", recoverable: false },
  }),
  getCapabilities: async () => ({
    ok: false,
    error: { code: "unsupported", message: "unused", recoverable: false },
  }),
  startRun: async function* () {},
};
const binding: ChatBinding = {
  providerConnectionId: "018f0000-0000-7000-8000-000000000301",
  providerId: "018f0000-0000-7000-8000-000000000301",
  modelRecordId: "018f0000-0000-7000-8000-000000000302",
  modelId: "liquid/lfm2.5-2.6b-q4_k_m",
  port,
};

function seat(index: number, drunk = false): GroupParticipantDraft {
  return {
    id: seatIds[index]!,
    personaId: null,
    providerConnectionId: null,
    modelId: null,
    displayName: `Seat ${index}`,
    accentColor: `#0${index}00000`,
    systemPrompt: `Play seat ${index}.`,
    voice: null,
    toolsEnabled: false,
    drunk,
  };
}

function room(settings: Partial<GroupRoomSettings> = {}): GroupRoomDraft {
  return {
    id: roomId,
    name: "Test room",
    scenario: "A lighthouse at night.",
    userDisplayName: "Sam",
    conversationId,
    settings: {
      conversationMode: "discussion",
      speakerOrder: "round-robin",
      replyDisplay: "complete",
      sharedModelId: binding.modelId,
      responseLimitTokens: 256,
      ...settings,
    },
    participants: [seat(0), seat(1), seat(2)],
  };
}

interface FakeOptions {
  /** Seat whose stream blocks until its handle stop() is called. */
  blockedSeatIndex?: number;
  onSeatBegan?: (seatIndex: number) => void;
  failSeatIndex?: number;
}

interface Fake {
  engine: GroupDriverEngine;
  config: GroupDriverConfig;
  runtime: {
    schedule<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  };
  appended: { conversationId: string; text: string }[];
  seatTurns: {
    participantId?: string;
    preparedTexts: string[];
    required: readonly string[];
  }[];
  selectorTurns: number;
  speakerRuns: {
    runId: string;
    seatIndex: number;
    participantId: string | null;
  }[];
  finishes: { runId: string; status: string }[];
  roundStarts: { trigger: string; frozenOrder: number[] }[];
  statuses: { roundId: string; status: string; cursor: number }[];
  guards: { begin: number; end: number };
}

function fake(options: FakeOptions = {}): Fake {
  const fakeState: Fake = {
    engine: null as never,
    config: null as never,
    runtime: { schedule: (run) => run() },
    appended: [],
    seatTurns: [],
    selectorTurns: 0,
    speakerRuns: [],
    finishes: [],
    roundStarts: [],
    statuses: [],
    guards: { begin: 0, end: 0 },
  };
  let guardActive = false;
  let turnNumber = 0;
  let blockedUsed = false;
  let stored: { round: GroupRoundRecord; runs: GroupSpeakerRun[] } | null =
    null;
  fakeState.engine = {
    isGroupRoundActive: () => guardActive,
    beginGroupRound: () => {
      if (guardActive) throw new Error("group-round-active");
      guardActive = true;
      fakeState.guards.begin += 1;
    },
    endGroupRound: () => {
      guardActive = false;
      fakeState.guards.end += 1;
    },
    appendUserMessage: async (input) => {
      fakeState.appended.push(input);
      return otherUserId;
    },
    beginAssistantTurn: async (input) => {
      const preparedTexts = input.preparedMessages.flatMap((message) =>
        message.parts.map((part) => part.text ?? ""),
      );
      if (input.json === true) {
        fakeState.selectorTurns += 1;
        const handle: GroupAssistantHandle = {
          runId: createId(),
          assistantMessageId: createId(),
          events: (async function* () {
            yield textDelta(seatIds[2]!, "invalid selector output not json");
            yield terminal("RunCompleted", seatIds[2]!);
          })(),
          stop: async () => {},
        };
        return handle;
      }
      fakeState.seatTurns.push({
        ...(input.participantId ? { participantId: input.participantId } : {}),
        preparedTexts,
        required: input.requiredMessageIds ?? [],
      });
      turnNumber += 1;
      const assistantMessageId = `${assistantIdBase}${turnNumber}`;
      const seatIndex = input.participantId
        ? seatIds.indexOf(input.participantId)
        : -1;
      const gate = Promise.withResolvers<void>();
      if (options.onSeatBegan && seatIndex >= 0) {
        // Deferred so the driver has bound its stop handle first, like a
        // real Stop button pressed mid-generation.
        setTimeout(() => options.onSeatBegan?.(seatIndex), 0);
      }
      const events = (async function* (): AsyncGenerator<RunEvent> {
        if (options.blockedSeatIndex === seatIndex && !blockedUsed) {
          blockedUsed = true;
          await gate.promise;
          yield terminal("RunCanceled", input.participantId);
          return;
        }
        if (options.failSeatIndex === seatIndex) {
          yield {
            ...terminal("RunFailed", input.participantId),
            error: { code: "offline", message: "boom", recoverable: false },
          };
          return;
        }
        const name = seatIds.indexOf(input.participantId ?? "");
        yield textDelta(input.participantId, `Hi from Seat ${name}`);
        yield terminal("RunCompleted", input.participantId);
      })();
      return {
        runId: createId(),
        assistantMessageId,
        events,
        stop: async () => {
          gate.resolve();
        },
      };
    },
  };
  fakeState.config = {
    beginRound: async (_roomId, _conversationId, start) => {
      fakeState.roundStarts.push({
        trigger: start.trigger,
        frozenOrder: [...start.frozenOrder],
      });
      const round: GroupRoundRecord = {
        id: createId(),
        roomId: _roomId,
        conversationId: _conversationId,
        trigger: start.trigger,
        frozenOrder: [...start.frozenOrder],
        settings: start.settings,
        status: "active",
        seatCursor: 0,
      };
      stored = { round, runs: [] };
      return round;
    },
    setRoundStatus: async (roundId, status, cursor) => {
      fakeState.statuses.push({ roundId, status, cursor });
      if (stored && stored.round.id === roundId) {
        stored = {
          round: { ...stored.round, status, seatCursor: cursor },
          runs: stored.runs,
        };
      }
    },
    beginSpeakerRun: async (_roundId, seatIndex, participantId) => {
      const runId = `run-${seatIndex}`;
      fakeState.speakerRuns.push({ runId, seatIndex, participantId });
      return runId;
    },
    finishSpeakerRun: async (runId, status) => {
      fakeState.finishes.push({ runId, status });
    },
    latestRound: async () => stored,
  };
  return fakeState;
}

function textDelta(participantId: string | undefined, text: string): RunEvent {
  return {
    type: "TextDelta",
    runId: createId(),
    sequence: 0,
    timestamp: new Date().toISOString(),
    ...(participantId ? { participantId } : {}),
    text,
  };
}

function terminal(
  type: "RunCompleted" | "RunCanceled" | "RunFailed",
  participantId: string | undefined,
): RunEvent {
  return {
    type,
    runId: createId(),
    sequence: 1,
    timestamp: new Date().toISOString(),
    ...(participantId ? { participantId } : {}),
  };
}

function collect() {
  const entries: GroupTranscriptEntry[] = [];
  const statuses: { seatIndex: number; status: string }[] = [];
  const deltas: { seatIndex: number; full: string }[] = [];
  return {
    entries,
    statuses,
    deltas,
    presenter: presenter(entries, statuses, deltas),
  };
}

function presenter(
  entries: GroupTranscriptEntry[],
  statuses: { seatIndex: number; status: string }[],
  deltas?: { seatIndex: number; full: string }[],
) {
  return {
    onStatus: (seatIndex: number, status: "thinking" | "done" | "failed") => {
      statuses.push({ seatIndex, status });
    },
    onEntry: (entry: GroupTranscriptEntry) => {
      entries.push(entry);
    },
    ...(deltas
      ? {
          onDelta: (seatIndex: number, full: string) => {
            deltas.push({ seatIndex, full });
          },
        }
      : {}),
  };
}

test("Send inserts one user message and one attributed reply per seat", async () => {
  const state = fake();
  const collected = collect();
  const driver = new GroupTurnDriver({ ...state, createId });
  const history: GroupTranscriptEntry[] = [
    {
      id: otherUserId,
      speakerSeat: -1,
      speakerName: "Sam",
      accentColor: "",
      text: "Earlier question",
    },
  ];
  const result = await driver.startTurn({
    room: room(),
    trigger: "send",
    userText: "What does the fog sound like?",
    history,
    binding,
    presenter: collected.presenter,
  });
  assert.equal(state.appended.length, 1, "exactly one user row");
  assert.deepEqual(
    state.seatTurns.map((turn) => turn.participantId),
    seatIds,
    "every seat answers once in frozen order",
  );
  assert.deepEqual(state.roundStarts[0], {
    trigger: "send",
    frozenOrder: [0, 1, 2],
  });
  assert.deepEqual(
    collected.entries.map((entry) => entry.speakerSeat),
    [-1, 0, 1, 2],
  );
  assert.deepEqual(
    state.finishes.map((finish) => finish.status),
    ["completed", "completed", "completed"],
  );
  assert.deepEqual(
    state.statuses.map((status) => status.status),
    ["completed"],
  );
  assert.equal(state.statuses[0]?.cursor, 0, "rotation wraps past seat 2");
  assert.equal(result.status, "completed");
  assert.equal(state.guards.begin, 1);
  assert.equal(state.guards.end, 1);
  // Discussion mode: the third seat sees the first seat's fresh reply.
  const third = state.seatTurns[2]!;
  assert.ok(
    third.preparedTexts.some((text) => text.includes("Seat 0: Hi from Seat 0")),
    "discussion shows earlier replies with the speaker prefix",
  );
  assert.ok(
    third.preparedTexts.some(
      (text) =>
        text.includes("Play seat 2.\n\nRoom scenario") ||
        text.includes("Room scenario") ||
        text.includes("Play seat 2."),
    ),
    "seat instruction carries persona and scenario",
  );
  assert.ok(
    third.required.length >= 2,
    "instruction and newest row survive packing",
  );
});

test("Pass adds zero user messages and seats keep answering", async () => {
  const state = fake();
  const collected = collect();
  const driver = new GroupTurnDriver({ ...state, createId });
  await driver.startTurn({
    room: room(),
    trigger: "pass",
    history: [
      {
        id: `${assistantIdBase}0`,
        speakerSeat: 0,
        speakerName: "Seat 0",
        accentColor: "#000000",
        text: "A story so far.",
      },
    ],
    binding,
    presenter: collected.presenter,
  });
  assert.equal(state.appended.length, 0, "Pass never inserts a user row");
  assert.equal(state.seatTurns.length, 3);
  assert.deepEqual(state.roundStarts[0], {
    trigger: "pass",
    frozenOrder: [0, 1, 2],
  });
  assert.ok(
    state.seatTurns[0]!.preparedTexts.some((text) =>
      text.includes("passed without adding a message"),
    ),
    "seats are told the user passed",
  );
});

test("Ask produces exactly one attributed reply for that seat", async () => {
  const state = fake();
  const collected = collect();
  const driver = new GroupTurnDriver({ ...state, createId });
  await driver.startTurn({
    room: room(),
    trigger: "ask",
    userText: "Seat 2, your turn.",
    askSeatIndex: 2,
    history: [],
    binding,
    presenter: collected.presenter,
  });
  assert.equal(state.appended.length, 1);
  assert.deepEqual(
    state.seatTurns.map((turn) => turn.participantId),
    [seatIds[2]],
  );
  assert.deepEqual(state.roundStarts[0], { trigger: "ask", frozenOrder: [2] });
  assert.equal(collected.entries.length, 2, "user row + one reply");
  assert.equal(collected.entries[1]?.speakerSeat, 2);
  assert.ok(
    state.seatTurns[0]!.preparedTexts.some((text) =>
      text.includes("directed this message to you specifically"),
    ),
  );
});

test("Stop keeps completed replies, marks the partial seat and blocks later seats", async () => {
  let signalSeatBegan!: (seatIndex: number) => void;
  const began = new Promise<number>((resolve) => {
    signalSeatBegan = resolve;
  });
  const state = fake({
    blockedSeatIndex: 1,
    onSeatBegan: (seatIndex) => {
      if (seatIndex === 1) signalSeatBegan(seatIndex);
    },
  });
  const collected = collect();
  const driver = new GroupTurnDriver({ ...state, createId });
  const running = driver.startTurn({
    room: room(),
    trigger: "send",
    userText: "talk",
    history: [],
    binding,
    presenter: collected.presenter,
  });
  assert.equal(await began, 1, "second seat started");
  assert.equal(await driver.stopCurrent("Stopped by user"), true);
  const result = await running;
  assert.equal(result.status, "stopped");
  assert.deepEqual(
    collected.entries.map((entry) => [entry.speakerSeat, entry.text]),
    [
      [-1, "talk"],
      [0, "Hi from Seat 0"],
    ],
    "completed replies stay published",
  );
  assert.deepEqual(
    state.speakerRuns.map((run) => run.seatIndex),
    [0, 1],
    "the seat after the stop never starts",
  );
  assert.deepEqual(
    state.finishes.map((finish) => [finish.runId, finish.status]),
    [
      ["run-0", "completed"],
      ["run-1", "interrupted"],
    ],
    "the partial seat is marked interrupted",
  );
  assert.deepEqual(
    state.statuses.map((status) => [status.status, status.cursor]),
    [["stopped", 1]],
    "rotation resumes at the interrupted seat",
  );
  assert.equal(state.guards.end, 1, "guard released even on stop");
});

test("a stopped round leaves the driver ready for the next round", async () => {
  let signalSeatBegan!: (seatIndex: number) => void;
  const began = new Promise<number>((resolve) => {
    signalSeatBegan = resolve;
  });
  const state = fake({
    blockedSeatIndex: 1,
    onSeatBegan: (seatIndex) => {
      if (seatIndex === 1) signalSeatBegan(seatIndex);
    },
  });
  const collected = collect();
  const driver = new GroupTurnDriver({ ...state, createId });
  const first = driver.startTurn({
    room: room(),
    trigger: "send",
    userText: "talk",
    history: [],
    binding,
    presenter: collected.presenter,
  });
  assert.equal(await began, 1);
  await driver.stopCurrent("Stopped by user");
  assert.equal((await first).status, "stopped");
  const second = await driver.startTurn({
    room: room(),
    trigger: "pass",
    history: collected.entries,
    binding,
    presenter: collected.presenter,
  });
  assert.equal(second.status, "completed", "the next round is not poisoned");
  assert.deepEqual(
    state.roundStarts[1]?.frozenOrder,
    [1, 2, 0],
    "rotation resumes at the interrupted seat",
  );
  assert.equal(second.entries.length, 3, "every seat answers the new round");
});

test("one seat provider failure marks it failed and the round continues", async () => {
  const state = fake({ failSeatIndex: 1 });
  const collected = collect();
  const driver = new GroupTurnDriver({ ...state, createId });
  const result = await driver.startTurn({
    room: room(),
    trigger: "send",
    userText: "talk",
    history: [],
    binding,
    presenter: collected.presenter,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(
    state.finishes.map((finish) => finish.status),
    ["completed", "failed", "completed"],
  );
  assert.deepEqual(
    collected.statuses
      .filter((status) => status.status === "failed")
      .map((status) => status.seatIndex),
    [1],
  );
  assert.deepEqual(
    collected.entries.map((entry) => entry.speakerSeat),
    [-1, 0, 2],
    "failed seat contributes no entry",
  );
});

test("live reply display streams cumulative deltas for the current seat", async () => {
  const state = fake();
  const collected = collect();
  const driver = new GroupTurnDriver({ ...state, createId });
  await driver.startTurn({
    room: room({ replyDisplay: "live" }),
    trigger: "send",
    userText: "talk",
    history: [],
    binding,
    presenter: collected.presenter,
  });
  assert.deepEqual(
    collected.deltas,
    [
      { seatIndex: 0, full: "Hi from Seat 0" },
      { seatIndex: 1, full: "Hi from Seat 1" },
      { seatIndex: 2, full: "Hi from Seat 2" },
    ],
    "live mode previews every seat",
  );
});

test("independent conversation mode hides this round's fresh replies from later seats", async () => {
  const state = fake();
  const collected = collect();
  const driver = new GroupTurnDriver({ ...state, createId });
  await driver.startTurn({
    room: room({ conversationMode: "independent" }),
    trigger: "send",
    userText: "talk",
    history: [],
    binding,
    presenter: collected.presenter,
  });
  const third = state.seatTurns[2]!;
  assert.ok(
    !third.preparedTexts.some((text) => text.includes("Hi from Seat")),
    "independent seats see only the frozen transcript",
  );
  assert.ok(
    third.preparedTexts.includes("talk"),
    "the current user message still reaches every seat",
  );
});
