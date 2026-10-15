import assert from "node:assert/strict";
import test from "node:test";
import type { GroupRoomDraft } from "@locallab/groups-config";
import {
  GROUP_AUTONOMOUS_ROUND_CAP,
  GroupTurnError,
  mentionedSeatIndices,
  planGroupUserTurn,
  runGroupUserTurn,
  type GroupTurnPort,
  type GroupTurnSpeaker,
} from "../src/index.js";

const seat = (displayName: string) => ({
  personaId: null,
  providerConnectionId: "0195c000-0000-7000-8000-0000000000e1",
  modelId: "llama",
  displayName,
  accentColor: `#${displayName.length.toString(16).padStart(6, "0")}`,
  systemPrompt: `role:${displayName}`,
  voice: null,
  toolsEnabled: false,
});

const room: GroupRoomDraft = {
  id: null,
  name: "Study room",
  scenario: "Interview practice",
  userDisplayName: "Me",
  conversationId: "0195c000-0000-7000-8000-0000000000e2",
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
        return `${speaker.displayName} replies to: ${instruction.split(
          "\n",
        )[0]}`;
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
  assert.deepEqual(mentionedSeatIndices("hey @ALAN and @Ada", room.participants), [0, 2]);
});
