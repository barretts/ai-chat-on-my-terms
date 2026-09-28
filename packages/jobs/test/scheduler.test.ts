import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryJobStore } from "../src/memory-store.js";
import { JobScheduler } from "../src/scheduler.js";

function setup(limits?: {
  streaming?: number;
  download?: number;
  media?: number;
}) {
  const store = new MemoryJobStore();
  let sequence = 0;
  const scheduler = new JobScheduler(store, {
    ...(limits ? { limits } : {}),
    deviceId: "00000000-0000-7000-8000-000000000099",
    createId: () =>
      `00000000-0000-7000-8000-${String(++sequence).padStart(12, "0")}`,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  return { store, scheduler };
}

const input = (
  key: string,
  kind = "work",
  category: "streaming" | "download" | "media" = "streaming",
) => ({
  kind,
  category,
  idempotencyKey: key,
  input: { value: key },
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 1000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs)
      throw new Error("Timed out waiting for job state");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("duplicate starts with one idempotency key produce one durable job and one execution", async () => {
  const { scheduler } = setup();
  let calls = 0;
  scheduler.register("work", async (value) => {
    calls++;
    return value;
  });
  const [first, second] = await Promise.all([
    scheduler.start(input("same")),
    scheduler.start(input("same")),
  ]);
  assert.equal(first.id, second.id);
  assert.match(
    first.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(first.revision.deviceId, "00000000-0000-7000-8000-000000000099");
  await waitUntil(
    async () => (await scheduler.get(first.id))?.state === "completed",
  );
  assert.equal(calls, 1);
  assert.equal((await scheduler.list()).length, 1);
});

test("cancel is terminal even when worker ignores abort; thrown worker errors fail terminally", async () => {
  const { scheduler } = setup();
  let release!: () => void;
  scheduler.register(
    "slow",
    async () =>
      new Promise((resolve) => {
        release = () => resolve("late");
      }),
  );
  scheduler.register("broken", async () => {
    throw new Error("worker crashed");
  });
  const slow = await scheduler.start(input("cancel", "slow"));
  await waitUntil(
    async () => (await scheduler.get(slow.id))?.state === "running",
  );
  assert.equal((await scheduler.cancel(slow.id))?.state, "canceled");
  release();
  const broken = await scheduler.start(input("crash", "broken"));
  await waitUntil(
    async () => (await scheduler.get(broken.id))?.state === "failed",
  );
  assert.equal((await scheduler.get(slow.id))?.state, "canceled");
  assert.match((await scheduler.get(broken.id))?.error ?? "", /worker crashed/);
});

test("recovery requeues interrupted work in stable order and never reruns completed records", async () => {
  const { store, scheduler } = setup({ streaming: 1 });
  const done = await store.create(
    input("done"),
    "2026-01-01T00:00:00.000Z",
    "00000000-0000-7000-8000-000000000001",
    {
      wallMs: 1767225600000,
      counter: 0,
      deviceId: "00000000-0000-7000-8000-000000000099",
    },
  );
  await store.transition(done.job.id, ["queued"], {
    state: "completed",
    finishedAt: "2026-01-01T00:00:01.000Z",
  });
  const interrupted = await store.create(
    input("interrupted"),
    "2026-01-01T00:00:00.000Z",
    "00000000-0000-7000-8000-000000000002",
    {
      wallMs: 1767225600000,
      counter: 0,
      deviceId: "00000000-0000-7000-8000-000000000099",
    },
  );
  await store.transition(interrupted.job.id, ["queued"], {
    state: "running",
    attempt: 1,
    startedAt: "2026-01-01T00:00:01.000Z",
  });
  const queued = await store.create(
    input("queued"),
    "2026-01-01T00:00:00.000Z",
    "00000000-0000-7000-8000-000000000003",
    {
      wallMs: 1767225600000,
      counter: 0,
      deviceId: "00000000-0000-7000-8000-000000000099",
    },
  );

  const executions: string[] = [];
  scheduler.register("work", async (_value, context) => {
    executions.push(context.job.idempotencyKey);
    return context.job.idempotencyKey;
  });
  await scheduler.recover();
  await waitUntil(
    async () =>
      (await scheduler.list()).filter((job) => job.state === "completed")
        .length === 3,
  );
  assert.deepEqual(executions, ["interrupted", "queued"]);
  assert.equal((await scheduler.get(done.job.id))?.attempt, 0);
  assert.equal((await scheduler.get(interrupted.job.id))?.attempt, 2);
  assert.ok(
    (await scheduler.get(interrupted.job.id))!.revision.counter >
      interrupted.job.revision.counter,
  );
});

test("category limits are independent", async () => {
  const { scheduler } = setup({ streaming: 1, download: 1, media: 1 });
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  scheduler.register("work", async (value: unknown) => {
    const key = (value as { value: string }).value;
    starts.push(key);
    await new Promise<void>((resolve) => releases.set(key, resolve));
    return key;
  });
  const a = await scheduler.start(input("s1"));
  const b = await scheduler.start(input("s2"));
  const c = await scheduler.start(input("d1", "work", "download"));
  await waitUntil(async () => starts.length === 2);
  assert.deepEqual(starts.sort(), ["d1", "s1"]);
  releases.get("s1")?.();
  await waitUntil(async () => starts.includes("s2"));
  releases.get("s2")?.();
  releases.get("d1")?.();
  await Promise.all([a, b, c]);
});
