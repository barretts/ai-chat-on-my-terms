import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultGroupRoomSettings,
  type GroupRoomDraft,
} from "@locallab/groups-config";
import {
  diceOrder,
  GROUP_AUTONOMOUS_ROUND_CAP,
  GroupTurnError,
  mentionedSeatIndices,
  parseTopicInterestOrder,
  planGroupUserTurn,
  planTopicInterestOrder,
  roundRobinOrder,
  runGroupUserTurn,
  topicInterestPrompt,
  type GroupSelectorPort,
  type GroupTurnEntry,
  type GroupTurnPort,
  type GroupTurnSpeaker,
} from "../src/index.js";

const seat = (displayName: string) => ({
  id: null,
  personaId: null,
  providerConnectionId: "0195c000-0000-7000-8000-0000000000e1",
  modelId: "llama",
  displayName,
  accentColor: `#${displayName.length.toString(16).padStart(6, "0")}`,
  systemPrompt: `role:${displayName}`,
  voice: null,
  toolsEnabled: false,
  drunk: false,
});

const room: GroupRoomDraft = {
  id: null,
  name: "Study room",
  scenario: "Interview practice",
  userDisplayName: "Me",
  conversationId: "0195c000-0000-7000-8000-0000000000e2",
  settings: defaultGroupRoomSettings(),
  participants: [seat("Ada"), seat("Grace"), seat("Alan")],
};

function countingPort(onCall?: (speaker: GroupTurnSpeaker) => void): {
  port: GroupTurnPort;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    port: {
      generate: async ({ speaker, instruction }) => {
        calls.push(speaker.displayName);
        onCall?.(speaker);
        return `${speaker.displayName} replies to: ${
          instruction.split("\n")[0]
        }`;
      },
    },
  };
}

test("round-robin freezes every seat in seating order for one round", () => {
  const plan = planGroupUserTurn(room, {
    userText: "let's start",
    mode: "round-robin",
  });
  assert.deepEqual(
    plan.speakers.map((speaker) => speaker.displayName),
    ["Ada", "Grace", "Alan"],
  );
  assert.equal(plan.rounds, 1);
  assert.equal(plan.scenario, "Interview practice");
});

test("autonomous mode follows mentions; unmentioned seats never run", async () => {
  const plan = planGroupUserTurn(room, {
    userText: "what do you think @grace?",
    mode: "autonomous",
    autonomousRounds: 9,
  });
  assert.deepEqual(
    plan.speakers.map((speaker) => speaker.displayName),
    ["Grace"],
  );
  assert.equal(
    plan.rounds,
    GROUP_AUTONOMOUS_ROUND_CAP,
    "autonomous rounds are capped to five",
  );
  const fake = countingPort();
  const entries = await runGroupUserTurn(plan, fake.port, "question");
  assert.equal(fake.calls.length, GROUP_AUTONOMOUS_ROUND_CAP);
  assert.equal(new Set(fake.calls).size, 1);
  assert.deepEqual(
    [...new Set(entries.map((entry) => entry.speaker.displayName))],
    ["Grace"],
  );
});

test("manual mode runs only the Ask-chip seat", async () => {
  const plan = planGroupUserTurn(room, {
    userText: "next",
    mode: "manual",
    askSeatIndex: 2,
  });
  const fake = countingPort();
  const entries = await runGroupUserTurn(plan, fake.port, "next question");
  assert.deepEqual(fake.calls, ["Alan"]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.speaker.displayName, "Alan");
});

test("manual mode without a selected seat refuses the turn", () => {
  assert.throws(
    () =>
      planGroupUserTurn(room, {
        userText: "next",
        mode: "manual",
      }),
    GroupTurnError,
  );
});

test("reply-to-user-only ends after replying once", async () => {
  const plan = planGroupUserTurn(room, {
    userText: "@ada quick answer",
    mode: "autonomous",
    autonomousRounds: 5,
    replyToUserOnly: true,
  });
  assert.equal(plan.rounds, 1);
  const fake = countingPort();
  const entries = await runGroupUserTurn(plan, fake.port, "quick answer");
  assert.deepEqual(fake.calls, ["Ada"]);
  assert.equal(entries.length, 1);
});

test("stopping the signal terminates the whole user turn", async () => {
  const plan = planGroupUserTurn(room, {
    userText: "go",
    mode: "round-robin",
  });
  const controller = new AbortController();
  const fake = countingPort(() => controller.abort());
  const entries = await runGroupUserTurn(
    plan,
    fake.port,
    "go",
    controller.signal,
  );
  assert.equal(fake.calls.length, 1, "later seats never start");
  assert.equal(entries.length, 1, "produced entries are preserved");
});

test("mention matching uses display names case-insensitively", () => {
  assert.deepEqual(
    mentionedSeatIndices("hey @ALAN and @Ada", room.participants),
    [0, 2],
  );
});

test("round-robin order rotates the start after each completed round", () => {
  assert.deepEqual(roundRobinOrder(3, 0), [0, 1, 2]);
  assert.deepEqual(roundRobinOrder(3, 1), [1, 2, 0]);
  assert.deepEqual(roundRobinOrder(3, 3), [0, 1, 2]);
  assert.deepEqual(roundRobinOrder(3, -1), [2, 0, 1]);
  assert.throws(() => roundRobinOrder(0, 0), GroupTurnError);
});

test("dice order is a seeded permutation that replays exactly", () => {
  const a = diceOrder(5, 0xc0ffee);
  assert.deepEqual(
    [...a].sort((x, y) => x - y),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(diceOrder(5, 0xc0ffee), a, "same seed replays");
  assert.notDeepEqual(diceOrder(5, 0xc0ffee), diceOrder(5, 0xfeedface));
  assert.deepEqual(diceOrder(1, 7), [0]);
});

test("topic-interest scores sort descending with seating tie-break", () => {
  const order = parseTopicInterestOrder(
    '{"scores":[{"seat":"s2","score":90},{"seat":"s1","score":50},{"seat":"s3","score":50}]}',
    ["s1", "s2", "s3"],
  );
  assert.deepEqual(order, [1, 0, 2]);
});

test("topic-interest validation rejects every malformed reply", () => {
  const ids = ["s1", "s2", "s3"];
  assert.equal(parseTopicInterestOrder("sure, Ada!", ids), null);
  assert.equal(
    parseTopicInterestOrder('{"scores":[{"seat":"s9","score":9}]}', ids),
    null,
    "invented seat id",
  );
  assert.equal(
    parseTopicInterestOrder(
      '{"scores":[{"seat":"s1","score":9},{"seat":"s1","score":8},{"seat":"s2","score":7},{"seat":"s3","score":6}]}',
      ids,
    ),
    null,
    "duplicate seat",
  );
  assert.equal(
    parseTopicInterestOrder(
      '{"scores":[{"seat":"s1","score":9},{"seat":"s2","score":8}]}',
      ids,
    ),
    null,
    "omitted seat",
  );
  assert.equal(
    parseTopicInterestOrder(
      '{"scores":[{"seat":"s1","score":"nine"},{"seat":"s2","score":8},{"seat":"s3","score":7}]}',
      ids,
    ),
    null,
    "non-numeric score",
  );
  assert.equal(
    parseTopicInterestOrder(
      '{"scores":[{"seat":"s1","score":null},{"seat":"s2","score":8},{"seat":"s3","score":7}]}',
      ids,
    ),
    null,
    "null score",
  );
});

test("topic-interest ordering calls the selector once and falls back without retrying", async () => {
  const selectorSeats = [
    { id: "s1", displayName: "Ada", scenario: "hardware" },
    { id: "s2", displayName: "Grace", scenario: "navy" },
    { id: "s3", displayName: "Alan", scenario: "" },
  ];
  let calls = 0;
  const responding: GroupSelectorPort = {
    generateSelector: async ({ prompt }) => {
      calls += 1;
      assert.ok(prompt.includes("seat id s1: Ada"));
      assert.ok(prompt.includes("scenario: hardware"));
      assert.ok(prompt.includes("User's latest message: build me a compiler"));
      return '{"scores":[{"seat":"s3","score":99},{"seat":"s1","score":20},{"seat":"s2","score":10}]}';
    },
  };
  assert.deepEqual(
    await planTopicInterestOrder(
      selectorSeats,
      "build me a compiler",
      responding,
    ),
    [2, 0, 1],
  );
  calls = 0;
  const broken: GroupSelectorPort = {
    generateSelector: async () => {
      calls += 1;
      return "Ada should answer.";
    },
  };
  assert.deepEqual(
    await planTopicInterestOrder(selectorSeats, "hi", broken),
    [0, 1, 2],
  );
  assert.equal(calls, 1, "invalid reply must never trigger a retry call");
  calls = 0;
  const failing: GroupSelectorPort = {
    generateSelector: async () => {
      calls += 1;
      throw new Error("model down");
    },
  };
  assert.deepEqual(
    await planTopicInterestOrder(selectorSeats, "hi", failing),
    [0, 1, 2],
  );
  assert.equal(calls, 1, "selector failure must never trigger a retry call");
});

test("pass runs the frozen seats with no user message", async () => {
  const plan = planGroupUserTurn(room, { mode: "round-robin" });
  const instructions: string[] = [];
  const port: GroupTurnPort = {
    generate: async ({ instruction }) => {
      instructions.push(instruction);
      return "go on";
    },
  };
  const entries = await runGroupUserTurn(plan, port);
  assert.equal(entries.length, 3);
  assert.equal(instructions.filter((text) => !text.includes("Ada")).length, 3);
  for (const instruction of instructions)
    assert.ok(instruction.includes("passed without adding a message"));
});

test("independent context mode gives every speaker the same frozen transcript", async () => {
  const plan = planGroupUserTurn(room, {
    userText: "go",
    mode: "round-robin",
    contextMode: "independent",
  });
  const transcripts: number[] = [];
  const port: GroupTurnPort = {
    generate: async ({ transcript }) => {
      transcripts.push(transcript.length);
      return "fresh reply";
    },
  };
  const prior: GroupTurnEntry[] = [
    { round: 0, speaker: plan.speakers[0]!, text: "older reply" },
  ];
  await runGroupUserTurn(plan, port, "go", undefined, prior);
  assert.deepEqual(transcripts, [1, 1, 1], "fresh replies stay invisible");
});

test("discussion context mode shows later speakers earlier replies", async () => {
  const plan = planGroupUserTurn(room, { userText: "go", mode: "round-robin" });
  assert.equal(plan.contextMode, "discussion");
  const transcripts: number[] = [];
  const port: GroupTurnPort = {
    generate: async ({ transcript }) => {
      transcripts.push(transcript.length);
      return "reply";
    },
  };
  await runGroupUserTurn(plan, port, "go");
  assert.deepEqual(transcripts, [0, 1, 2]);
});

test("persona edits after planning never leak into a running round", async () => {
  const mutable = seat("Ada");
  const editRoom: GroupRoomDraft = {
    ...room,
    participants: [mutable, seat("Grace")],
  };
  const plan = planGroupUserTurn(editRoom, {
    userText: "go",
    mode: "round-robin",
  });
  mutable.displayName = "Ada Renamed";
  mutable.systemPrompt = "role:totally-changed";
  const speakers: GroupTurnSpeaker[] = [];
  const port: GroupTurnPort = {
    generate: async ({ speaker }) => {
      speakers.push(speaker);
      return "ok";
    },
  };
  await runGroupUserTurn(plan, port, "go");
  assert.equal(speakers[0]?.displayName, "Ada");
  assert.equal(speakers[0]?.systemPrompt, "role:Ada");
});
