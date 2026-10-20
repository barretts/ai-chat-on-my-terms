import assert from "node:assert/strict";
import { test } from "vitest";
import { ModelLeaseRegistry } from "@locallab/groups-parallel";
import {
  groupModelKey,
  GroupModelRuntime,
  resolveSharedRoomBinding,
  type RoomModelBinding,
} from "./group-runtime";

const installed: RoomModelBinding[] = [
  {
    providerConnectionId: "018f0000-0000-7000-8000-000000000301",
    modelRecordId: "rec-liquid",
    modelId: "liquid/lfm2.5-2.6b-q4_k_m",
  },
];

test("shared binding resolves only the installed room model", () => {
  assert.deepEqual(
    resolveSharedRoomBinding("liquid/lfm2.5-2.6b-q4_k_m", installed),
    installed[0],
  );
  assert.equal(resolveSharedRoomBinding(null, installed), null);
  assert.equal(resolveSharedRoomBinding("qwen/other", installed), null);
  assert.notEqual(
    groupModelKey(installed[0]!),
    groupModelKey({ ...installed[0]!, modelId: "other" }),
  );
});

test("runtime funnels every request through one context and keeps it loaded", async () => {
  const registry = new ModelLeaseRegistry();
  const key = groupModelKey(installed[0]!);
  let unloads = 0;
  const runtime = new GroupModelRuntime({
    registry,
    hostKey: "phone",
    modelKey: key,
    unload: () => {
      unloads += 1;
    },
  });
  let inFlight = 0;
  let peak = 0;
  const seat = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return "reply";
  };
  await Promise.all([
    runtime.schedule(seat),
    runtime.schedule(seat),
    runtime.schedule(seat),
  ]);
  assert.equal(peak, 1, "one shared model context at any instant");
  assert.equal(unloads, 0, "model stays loaded between replies");
  assert.equal(registry.activeContexts("phone"), 0);
});

test("release waits for in-flight work, blocks new turns, unloads once", async () => {
  const registry = new ModelLeaseRegistry();
  let unloads = 0;
  let release!: () => void;
  const gate = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const runtime = new GroupModelRuntime({
    registry,
    hostKey: "phone",
    modelKey: "room-model",
    unload: () => {
      unloads += 1;
    },
  });
  const inFlight = runtime.schedule(async () => {
    await gate.promise;
    return "late reply";
  });
  const releasing = Promise.all([runtime.release(), runtime.release()]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(unloads, 0, "unload must not fire while a run is in flight");
  await assert.rejects(() => runtime.schedule(async () => "nope"), /releasing/);
  release();
  assert.equal(await inFlight, "late reply");
  await releasing;
  assert.equal(unloads, 1, "concurrent releases must unload exactly once");
  assert.equal(registry.activeContexts("phone"), 0);
  assert.equal(await runtime.schedule(async () => "after"), "after");
});
