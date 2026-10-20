import { describe, expect, it } from "vitest";
import {
  defaultGroupRoomSettings,
  emptyGroupParticipant,
} from "@locallab/groups-config";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import type {
  GroupTurnOptions,
  GroupTurnResult,
} from "../../composition/chat/group-driver";
import {
  collectReplies,
  runBenchMatrix,
  scenarioLabel,
  type BenchPorts,
  type BenchScenarioHandle,
} from "./core";
import {
  BENCH_KICKOFF,
  BENCH_POLICIES,
  BENCH_SEAT_COUNTS,
  assembleManifest,
  buildBenchMatrix,
  tokensPerSec,
  type BenchPlan,
  type BenchRunRecord,
  type BenchScenarioRecord,
} from "./matrix";
import { manifestJson } from "./core";
import { createRecordingPort } from "./recorder";

function plan(overrides: Partial<BenchPlan> & { index: number }): BenchPlan {
  return {
    modelId: "blob:aaaa",
    seats: 2,
    policy: "round-robin",
    diceSeed: 0,
    personaKeys: ["pirate", "poet"],
    ...overrides,
  };
}

describe("buildBenchMatrix", () => {
  it("builds 18 scenarios per model in model/seats/policy order", () => {
    const plans = buildBenchMatrix(["blob:one", "blob:two"]);
    expect(plans).toHaveLength(
      2 * BENCH_SEAT_COUNTS.length * BENCH_POLICIES.length,
    );
    expect(plans[0]?.modelId).toBe("blob:one");
    expect(plans[15]?.modelId).toBe("blob:two");
    expect(plans.map((p) => p.index)).toEqual([...Array(18).keys()]);
    for (const p of plans) {
      expect(p.personaKeys).toHaveLength(p.seats);
      expect(p.personaKeys[0]).toBe("pirate");
      if (p.policy === "dice") expect(p.diceSeed).toBe(1000 + p.index);
      else expect(p.diceSeed).toBe(0);
    }
  });
});

describe("tokensPerSec", () => {
  it("rounds to 2 decimals and guards null/zero", () => {
    expect(tokensPerSec(10, 500)).toBe(20);
    expect(tokensPerSec(1, 300)).toBe(3.33);
    expect(tokensPerSec(null, 500)).toBeNull();
    expect(tokensPerSec(5, 0)).toBeNull();
  });
});

/* --------------------------------- recorder -------------------------------- */

function fakeInnerPort(events: RunEvent[]): {
  port: ProviderPort;
  seen: RunRequest[];
} {
  const seen: RunRequest[] = [];
  return {
    seen,
    port: {
      listModels: async () => [],
      getCapabilities: async () => undefined,
      startRun: async function* (request) {
        seen.push(request);
        for (const event of events) yield event;
      },
    },
  };
}

function requestFor(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: "run-1",
    messageId: "msg-1",
    modelId: "blob:aaaa",
    json: false,
    ...overrides,
  } as RunRequest;
}

describe("createRecordingPort", () => {
  it("passes events through untouched and records usage/finish/duration", async () => {
    const events: RunEvent[] = [
      { type: "RunStarted", runId: "run-1" } as RunEvent,
      { type: "TextDelta", runId: "run-1", text: "hi" },
      { type: "Usage", runId: "run-1", inputTokens: 11, outputTokens: 5 },
      { type: "RunCompleted", runId: "run-1", finishReason: "length" },
    ];
    const inner = fakeInnerPort(events);
    const sink: BenchRunRecord[] = [];
    let clock = 1000;
    const port = createRecordingPort(inner.port, sink, () => clock++);
    const streamed: RunEvent[] = [];
    for await (const event of port.startRun(
      requestFor(),
      new AbortController().signal,
    )) {
      streamed.push(event);
    }
    expect(streamed).toEqual(events);
    expect(sink).toHaveLength(1);
    const record = sink[0]!;
    expect(record).toMatchObject({
      runId: "run-1",
      messageId: "msg-1",
      inputTokens: 11,
      outputTokens: 5,
      finishReason: "length",
      canceled: false,
      jsonSelector: false,
      durationMs: 1,
    });
  });

  it("tags selector runs and marks cancellations/failures", async () => {
    const cases: {
      events: RunEvent[];
      expectFinish: string;
      canceled: boolean;
    }[] = [
      {
        events: [{ type: "RunCanceled", runId: "run-1" }],
        expectFinish: "canceled",
        canceled: true,
      },
      {
        events: [
          {
            type: "RunFailed",
            runId: "run-1",
            error: { code: "x", message: "boom", recoverable: false },
          },
        ],
        expectFinish: "failed: boom",
        canceled: false,
      },
    ];
    for (const testCase of cases) {
      const inner = fakeInnerPort(testCase.events);
      const sink: BenchRunRecord[] = [];
      const port = createRecordingPort(inner.port, sink);
      for await (const _ of port.startRun(
        requestFor({ json: true }),
        new AbortController().signal,
      )) {
        // drain
      }
      expect(sink[0]).toMatchObject({
        finishReason: testCase.expectFinish,
        canceled: testCase.canceled,
        jsonSelector: true,
      });
    }
  });
});

/* ------------------------------ bench core flow ----------------------------- */

function fakeScenario(options: {
  failOnRound?: number;
  roundStatus?: "completed" | "stopped";
}): {
  handle: BenchScenarioHandle;
  calls: GroupTurnOptions[];
  disposed: () => boolean;
  stopped: () => boolean;
} {
  const calls: GroupTurnOptions[] = [];
  let disposed = false;
  let stopped = false;
  const records: BenchRunRecord[] = [];
  const handle: BenchScenarioHandle = {
    room: {
      id: "room-1",
      name: "DEV BENCH",
      scenario: "",
      userDisplayName: "Bench",
      conversationId: "conv-1",
      settings: {
        ...defaultGroupRoomSettings(),
        responseLimitTokens: 128,
        sharedModelId: "blob:aaaa",
      },
      participants: [
        { ...emptyGroupParticipant(), personaId: "persona-pirate" },
        { ...emptyGroupParticipant(), personaId: "persona-poet" },
      ],
    },
    binding: {
      providerConnectionId: "conn",
      providerId: "conn",
      modelRecordId: "model-1",
      modelId: "blob:aaaa",
      port: {} as ProviderPort,
    },
    records,
    startTurn: async (turnOptions) => {
      calls.push(turnOptions);
      const round = calls.length;
      if (options.failOnRound === round)
        throw new Error(`round ${round} exploded`);
      const replyId = `reply-${round}`;
      records.push({
        runId: `run-${round}`,
        messageId: replyId,
        modelId: "blob:aaaa",
        jsonSelector: false,
        startedAtMs: 0,
        endedAtMs: 0,
        durationMs: 500,
        inputTokens: 20,
        outputTokens: 25,
        finishReason: "stop",
        canceled: false,
      });
      const entries = [
        ...(turnOptions.userText !== undefined
          ? [
              {
                id: `user-${round}`,
                speakerSeat: -1,
                speakerName: "Bench",
                accentColor: "",
                text: turnOptions.userText,
              },
            ]
          : []),
        {
          id: replyId,
          speakerSeat: 0,
          speakerName: "Bench Pirate",
          accentColor: "#888888",
          text: `reply ${round}`,
        },
      ];
      for (const entry of entries) turnOptions.presenter.onEntry(entry);
      return {
        round: {
          id: `round-${round}`,
          roomId: "room-1",
          conversationId: "conv-1",
          trigger: turnOptions.trigger,
          frozenOrder: [0, 1],
          settings: handle.room.settings,
          status: options.roundStatus ?? "completed",
          seatCursor: 2,
        },
        status: options.roundStatus ?? "completed",
        entries,
      } satisfies GroupTurnResult;
    },
    stop: async () => {
      stopped = true;
    },
    dispose: async () => {
      disposed = true;
    },
  };
  return {
    handle,
    calls,
    disposed: () => disposed,
    stopped: () => stopped,
  };
}

function fakePorts(
  scenario: {
    handle: BenchScenarioHandle;
    calls: GroupTurnOptions[];
    disposed: () => boolean;
  },
  options: { personaKeys?: Map<string, string> } = {},
): { ports: BenchPorts; probes: number; opened: BenchPlan[] } {
  let probes = 0;
  const opened: BenchPlan[] = [];
  const personaKeys =
    options.personaKeys ?? new Map([["persona-pirate", "pirate"]]);
  const ports: BenchPorts = {
    personaKeyFor: (personaId) =>
      personaId === null ? null : (personaKeys.get(personaId) ?? null),
    openScenario: async (p) => {
      opened.push(p);
      return scenario.handle;
    },
    probe: async () => {
      probes += 1;
      return {
        thermal: probes <= 1 ? "nominal" : "fair",
        memoryBytes: 2_000_000_000,
      };
    },
    now: () => 5_000_000 + probes,
  };
  return { ports, probes, opened };
}

describe("runBenchMatrix", () => {
  it("runs rounds with fixed kickoff, dice seed, and persona mapping", async () => {
    const scenario = fakeScenario({});
    const { ports, opened } = fakePorts(scenario);
    const done: BenchScenarioRecord[] = [];
    const outcome = await runBenchMatrix(ports, {
      plans: [plan({ index: 3, policy: "dice", diceSeed: 1003 })],
      roundsPerScenario: 2,
      responseLimitTokens: 128,
      signal: new AbortController().signal,
      onProgress: () => {},
      onScenarioDone: (record) => done.push(record),
    });
    expect(opened[0]?.policy).toBe("dice");
    expect(scenario.calls).toHaveLength(2);
    expect(scenario.calls[0]?.userText).toBe(BENCH_KICKOFF);
    expect(scenario.calls[0]?.seed).toBe(1003);
    expect(scenario.calls[1]?.userText).toBeUndefined();
    expect(scenario.calls[1]?.seed).toBe(1003);
    expect(scenario.disposed()).toBe(true);
    expect(outcome.stopped).toBe(false);
    expect(done).toHaveLength(1);
    const record = done[0]!;
    expect(record.thermalBefore).toBe("nominal");
    expect(record.thermalAfter).toBe("fair");
    expect(record.rounds).toHaveLength(2);
    expect(record.rounds[0]?.frozenOrder).toEqual([0, 1]);
    const reply = record.rounds[0]?.replies[0];
    expect(reply).toMatchObject({
      seatIndex: 0,
      personaKey: "pirate",
      replyMessageId: "reply-1",
      durationMs: 500,
      inputTokens: 20,
      outputTokens: 25,
      tokensPerSec: 50,
      finishReason: "stop",
    });
  });

  it("marks stopped rounds and disposes even when a scenario throws", async () => {
    const failing = fakeScenario({ failOnRound: 1 });
    const portsA = fakePorts(failing);
    const outcomeA = await runBenchMatrix(portsA.ports, {
      plans: [plan({ index: 0 })],
      roundsPerScenario: 2,
      responseLimitTokens: 64,
      signal: new AbortController().signal,
      onProgress: () => {},
      onScenarioDone: () => {},
    });
    expect(outcomeA.stopped).toBe(true);
    expect(outcomeA.scenarios[0]?.rounds[0]?.status).toBe("failed");
    expect(outcomeA.scenarios[0]?.rounds[0]?.replies[0]?.finishReason).toBe(
      "round 1 exploded",
    );
    expect(failing.disposed()).toBe(true);

    const halting = fakeScenario({ roundStatus: "stopped" });
    const portsB = fakePorts(halting);
    const outcomeB = await runBenchMatrix(portsB.ports, {
      plans: [plan({ index: 0 }), plan({ index: 1 })],
      roundsPerScenario: 5,
      responseLimitTokens: 64,
      signal: new AbortController().signal,
      onProgress: () => {},
      onScenarioDone: () => {},
    });
    expect(outcomeB.stopped).toBe(true);
    expect(outcomeB.scenarios).toHaveLength(1); // matrix aborts after a stopped scenario
    expect(outcomeB.scenarios[0]?.rounds).toHaveLength(1);
  });

  it("skips everything when the signal is already aborted", async () => {
    const scenario = fakeScenario({});
    const { ports } = fakePorts(scenario);
    const controller = new AbortController();
    controller.abort();
    const outcome = await runBenchMatrix(ports, {
      plans: [plan({ index: 0 })],
      roundsPerScenario: 2,
      responseLimitTokens: 64,
      signal: controller.signal,
      onProgress: () => {},
      onScenarioDone: () => {},
    });
    expect(outcome.scenarios).toHaveLength(0);
    expect(outcome.stopped).toBe(true);
    expect(scenario.calls).toHaveLength(0);
  });

  it("labels scenarios with a compact model id", () => {
    expect(
      scenarioLabel(
        plan({ index: 0, modelId: "blob:0195c000-dead", seats: 5 }),
      ),
    ).toBe("0195c000 x 5 seats round-robin");
  });
});

describe("collectReplies", () => {
  it("skips user rows and unmapped seats keep null persona keys", () => {
    const replies = collectReplies(
      {
        entries: [
          {
            id: "u1",
            speakerSeat: -1,
            speakerName: "Bench",
            accentColor: "",
            text: "q",
          },
          {
            id: "r1",
            speakerSeat: 1,
            speakerName: "Poet",
            accentColor: "",
            text: "a",
          },
        ],
      },
      [
        {
          runId: "run-1",
          messageId: "r1",
          modelId: "blob:aaaa",
          jsonSelector: false,
          startedAtMs: 0,
          endedAtMs: 250,
          durationMs: 250,
          inputTokens: null,
          outputTokens: null,
          finishReason: null,
          canceled: false,
        },
      ],
      () => null,
      {
        id: "room",
        name: "n",
        scenario: "",
        userDisplayName: "",
        conversationId: "c",
        settings: {
          ...defaultGroupRoomSettings(),
          sharedModelId: null,
        },
        participants: [],
      },
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      seatIndex: 1,
      personaKey: null,
      tokensPerSec: null,
    });
  });
});

describe("manifest", () => {
  it("assembles versioned manifest and round-trips through JSON", () => {
    const manifest = assembleManifest({
      generatedAt: "2026-10-20T12:00:00.000Z",
      device: "iPhone",
      iosVersion: "26.1",
      appVersion: "0.1.0",
      buildNumber: "25",
      roundsPerScenario: 2,
      responseLimitTokens: 128,
      deviceMemoryBytes: 4_000_000_000,
      scenarios: [],
    });
    expect(manifest.version).toBe(1);
    expect(manifest.notes.some((note) => note.includes("Peak RSS"))).toBe(true);
    const parsed = JSON.parse(manifestJson(manifest));
    expect(parsed).toEqual(manifest);
  });
});
