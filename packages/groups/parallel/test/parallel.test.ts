import assert from "node:assert/strict";
import test from "node:test";
import {
  planGroupUserTurn,
  type GroupTurnSpeaker,
} from "@locallab/groups-turns";
import type { GroupRoomDraft } from "@locallab/groups-config";
import {
  ModelLeaseRegistry,
  runGroupTurnParallel,
  type GroupParallelChunk,
  type GroupParallelPort,
} from "../src/index.js";

const seat = (displayName: string) => ({
  personaId: null,
  providerConnectionId: "0195c000-0000-7000-8000-0000000000f1",
  modelId: `model-${displayName.toLocaleLowerCase()}`,
  displayName,
  accentColor: "#111111",
  systemPrompt: "",
  voice: null,
  toolsEnabled: false,
});

const room: GroupRoomDraft = {
  id: null,
  name: "Room",
  scenario: "",
  userDisplayName: "Me",
  conversationId: "0195c000-0000-7000-8000-0000000000f2",
  participants: [seat("Ada"), seat("Grace"), seat("Alan")],
};

const plan = planGroupUserTurn(room, {
  userText: "go",
  mode: "round-robin",
});

const delay = (ms: number, signal?: AbortSignal) => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      reject(new Error("canceled"));
    },
    { once: true },
  );
  return promise;
};

test("interleaved streams stay attributed to the right speaker", async () => {
  const chunks: GroupParallelChunk[] = [];
  const firstDelay = (speaker: GroupTurnSpeaker) =>
    speaker.displayName === "Ada"
      ? 5
      : speaker.displayName === "Grace"
        ? 1
        : 3;
  const port: GroupParallelPort = {
    generate: async ({ speaker, onChunk }) => {
      await delay(firstDelay(speaker));
      onChunk?.(`${speaker.displayName}-one`);
      await delay(10);
      onChunk?.(`${speaker.displayName}-two`);
      return `${speaker.displayName}-done`;
    },
  };
  const results = await runGroupTurnParallel(plan, port, {
    localBinding: () => null,
    onChunk: (chunk) => chunks.push(chunk),
  });
  assert.equal(results.length, 3);
  assert.deepEqual(
    chunks.map((chunk) => `${chunk.speaker.displayName}:${chunk.text}`),
    [
      "Grace:Grace-one",
      "Alan:Alan-one",
      "Ada:Ada-one",
      "Grace:Grace-two",
      "Alan:Alan-two",
      "Ada:Ada-two",
    ],
  );
});

test("one failing participant keeps the others' successes", async () => {
  const port: GroupParallelPort = {
    generate: async ({ speaker }) => {
      if (speaker.displayName === "Grace")
        throw new Error("model refused the context");
      return `${speaker.displayName} answer`;
    },
  };
  const results = await runGroupTurnParallel(plan, port, {
    localBinding: () => null,
  });
  const byName = new Map(results.map((r) => [r.speaker.displayName, r]));
  assert.equal(byName.get("Ada")?.status, "ok");
  assert.equal(byName.get("Alan")?.status, "ok");
  assert.equal(byName.get("Grace")?.status, "failed");
  assert.equal(byName.get("Grace")?.message, "model refused the context");
});

test("constrained host serializes same-device loads without deadlock", async () => {
  const leases = new ModelLeaseRegistry();
  leases.setHostCapacity("phone", 1);
  let concurrent = 0;
  let maxConcurrent = 0;
  const port: GroupParallelPort = {
    generate: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(5);
      concurrent -= 1;
      return "done";
    },
  };
  const results = await runGroupTurnParallel(plan, port, {
    leases,
    localBinding: (speaker: GroupTurnSpeaker) => ({
      modelKey: speaker.modelId ?? speaker.displayName,
      hostKey: "phone",
    }),
  });
  assert.deepEqual(
    results.map((r) => r.status),
    ["ok", "ok", "ok"],
  );
  assert.equal(maxConcurrent, 1, "same-device contexts serialize");
  assert.deepEqual(leases.loadedModels(), [], "leased models unloaded");
  assert.equal(leases.activeContexts("phone"), 0);
});

test("cancellation releases every lease and loads nothing else", async () => {
  const leases = new ModelLeaseRegistry();
  leases.setHostCapacity("phone", 1);
  const controller = new AbortController();
  const port: GroupParallelPort = {
    generate: async ({ signal }) => {
      setTimeout(() => controller.abort(), 10);
      await delay(50, signal);
      return "done";
    },
  };
  const results = await runGroupTurnParallel(plan, port, {
    leases,
    signal: controller.signal,
    localBinding: (speaker) => ({
      modelKey: speaker.modelId ?? "m",
      hostKey: "phone",
    }),
  });
  assert.equal(results.filter((r) => r.status === "failed").length, 3);
  assert.deepEqual(leases.loadedModels(), []);
  assert.equal(leases.activeContexts("phone"), 0);
});
