import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EntityIdSchema, compareRevision } from "../src/identity.js";
import { JobSchema, SyncRecordSchema } from "../src/entities.js";
import { RunEventBatchSchema } from "../src/run-events.js";
import {
  localFailureCause,
  retainLocalFailureCause,
} from "../src/local-failure-details.js";

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(
    await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;

test("UUIDv7 identity validation rejects malformed and non-v7 identifiers", () => {
  assert.equal(
    EntityIdSchema.safeParse("018f1f1e-7b4a-7c12-8a10-000000000001").success,
    true,
  );
  assert.equal(
    EntityIdSchema.safeParse("018f1f1e-7b4a-4c12-8a10-000000000001").success,
    false,
  );
  assert.equal(EntityIdSchema.safeParse("not-an-id").success, false);
});

test("text, tool, voice job and sync fixtures conform to their frozen schemas", async () => {
  assert.equal(
    RunEventBatchSchema.safeParse(await fixture("text-run.json")).success,
    true,
  );
  assert.equal(
    RunEventBatchSchema.safeParse(await fixture("tool-run.json")).success,
    true,
  );
  assert.equal(
    JobSchema.safeParse(await fixture("voice-job.json")).success,
    true,
  );
  assert.equal(
    SyncRecordSchema.safeParse(await fixture("sync-record.json")).success,
    true,
  );
});

test("run event batches reject duplicate sequence, mixed runs and events after terminal", () => {
  const runId = "018f1f1e-7b4a-7c12-8a10-000000000001";
  const base = { runId, timestamp: "2025-01-01T00:00:00.000Z" };
  const start = { ...base, type: "RunStarted", sequence: 0 };
  const text = { ...base, type: "TextDelta", sequence: 1, text: "reply" };
  const complete = { ...base, type: "RunCompleted", sequence: 2 };
  assert.equal(
    RunEventBatchSchema.safeParse([start, text, complete]).success,
    true,
  );
  assert.equal(
    RunEventBatchSchema.safeParse([start, { ...text, sequence: 0 }]).success,
    false,
  );
  assert.equal(
    RunEventBatchSchema.safeParse([
      start,
      { ...text, runId: "018f1f1e-7b4a-7c12-8a10-000000000002" },
    ]).success,
    false,
  );
  assert.equal(
    RunEventBatchSchema.safeParse([start, complete, text]).success,
    false,
  );
});

test("revision ordering uses wall time, counter, then device ID", () => {
  const first = {
    wallMs: 100,
    counter: 0,
    deviceId: "018f1f1e-7b4a-7c12-8a10-000000000001",
  };
  const laterCounter = { ...first, counter: 1 };
  const laterDevice = {
    ...first,
    deviceId: "018f1f1e-7b4a-7c12-8a10-000000000002",
  };
  assert.equal(compareRevision(first, laterCounter), -1);
  assert.equal(compareRevision(first, laterDevice), -1);
});

test("local failure mappings unwrap chains without changing serializable public errors", () => {
  const original = new Error(
    "HTTP503 original response body with private fixture data",
  );
  const first = Object.freeze({
    code: "offline",
    message: "Provider unavailable",
    recoverable: true,
  });
  const second = Object.freeze({
    code: "network",
    message: "Check the connection",
    recoverable: true,
  });
  retainLocalFailureCause(first, original);
  retainLocalFailureCause(second, first);
  assert.equal(localFailureCause(second), original);
  assert.deepEqual(Reflect.ownKeys(second), ["code", "message", "recoverable"]);
  assert.equal(JSON.stringify(second).includes(original.message), false);
  const restored = JSON.parse(JSON.stringify(second)) as object;
  assert.equal(localFailureCause(restored), restored);
});

test("local failure mappings stop on cycles and do not traverse arbitrary Error.cause properties", () => {
  const first = {};
  const second = {};
  retainLocalFailureCause(first, second);
  retainLocalFailureCause(second, first);
  assert.equal(localFailureCause(first), first);
  const unrelated = new Error("Public wrapper", {
    cause: new Error("Unmapped detail"),
  });
  assert.equal(localFailureCause(unrelated), unrelated);
  const empty = {};
  retainLocalFailureCause(empty, undefined);
  assert.equal(localFailureCause(empty), undefined);
});
