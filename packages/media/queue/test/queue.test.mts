import assert from "node:assert/strict";
import test from "node:test";
import { JobScheduler, type JobRecord } from "@locallab/jobs";
import { MemoryJobStore } from "@locallab/jobs/memory-store";
import {
  MediaJobService,
  type MediaBackendPort,
  type MediaRequestOutcome,
  type MediaSnapshot,
} from "@locallab/media-engine";
import {
  mediaQueueRows,
  MemoryServerJobLedger,
  RecoveringMediaBackend,
  SqliteServerJobLedger,
} from "../src/index.js";

const deviceId = "0198f2a3-7b6c-7d4e-8f0a-1b2c3d4e5f60";

async function expectJob(
  outcome: Promise<MediaRequestOutcome>,
): Promise<JobRecord> {
  const value = await outcome;
  if (value.kind !== "job")
    throw new Error(`expected job, got ${value.kind}`);
  return value.job;
}

const snapshot: MediaSnapshot = {
  conversationId: "0198f2a3-0000-7000-8000-000000000001",
  prompt: "a red fox",
  inputRefs: [],
  workflowSnapshot: { name: "flux", definition: { steps: 20 } },
  capturedAt: new Date().toISOString(),
};

const request = (prompt: string) => ({
  conversationId: snapshot.conversationId,
  prompt,
  requestedBy: "button" as const,
  workflow: snapshot.workflowSnapshot,
});

const settingsStore = {
  async load() {
    return { enabled: true, promptReview: false, autoGenerate: true };
  },
  async save() {},
};
const noReviews = {
  async save() {},
  async get() {
    return undefined;
  },
  async findByIdempotencyKey() {
    return undefined;
  },
  async delete() {},
  async list() {
    return [];
  },
};

async function until(
  fn: () => Promise<boolean>,
  what: string,
): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("remote submissions are bounded", async () => {
  const gate = Promise.withResolvers<{ outputRefs: string[] }>();
  let calls = 0;
  const inner: MediaBackendPort = {
    generate(context) {
      calls++;
      if (calls === 1) {
        context.reportServerJob("p-1");
        return gate.promise;
      }
      return Promise.resolve({ outputRefs: ["late"] });
    },
  };
  const backend = new RecoveringMediaBackend(
    inner,
    new MemoryServerJobLedger(),
    "comfyui",
    1,
  );
  const scheduler = new JobScheduler(new MemoryJobStore(), {
    deviceId,
    limits: { media: 2 },
  });
  const service = new MediaJobService(
    scheduler,
    settingsStore,
    backend,
    noReviews,
  );
  const first = await expectJob(
    service.requestGeneration(request("first")),
  );
  const second = await expectJob(
    service.requestGeneration(request("second")),
  );
  await until(async () => {
    const j2 = await scheduler.get(second.id);
    return j2?.state === "failed";
  }, "second job to be rejected by the remote bound");
  const failed = await scheduler.get(second.id);
  assert.equal(JSON.parse(failed?.error ?? "").code, "quota");
  gate.resolve({ outputRefs: ["blob-1"] });
  await until(async () => {
    const j1 = await scheduler.get(first.id);
    return j1?.state === "completed";
  }, "first job to complete");
  assert.equal(backend.remoteInFlight, 0);
  // the over-limit job never reached the remote server at all
  assert.equal(calls, 1);
});

test("reconnect re-attaches to the server job without resubmitting", async () => {
  const store = new MemoryJobStore();
  const ledger = new MemoryServerJobLedger();
  const neverResolve = Promise.withResolvers<{ outputRefs: string[] }>();
  let submits = 0;
  let resumes = 0;
  const inner: MediaBackendPort & {
    resume: NonNullable<MediaBackendPort["resume"]>;
  } = {
    generate(context) {
      submits++;
      context.reportServerJob("p-42");
      return neverResolve.promise;
    },
    resume(context) {
      resumes++;
      assert.equal(context.serverJobId, "p-42");
      return Promise.resolve({ outputRefs: ["recovered-blob"] });
    },
  };
  const backend = new RecoveringMediaBackend(inner, ledger, "comfyui", 2);
  const scheduler1 = new JobScheduler(store, { deviceId });
  new MediaJobService(scheduler1, settingsStore, backend, noReviews);
  const job = await scheduler1.start({
    kind: "image-generate",
    category: "media",
    input: snapshot,
    idempotencyKey: "k1",
  });
  await until(async () => {
    const current = await scheduler1.get(job.id);
    return current?.state === "running";
  }, "first attempt to start");

  // Simulate process restart: a fresh scheduler over the same durable store.
  const scheduler2 = new JobScheduler(store, { deviceId });
  new MediaJobService(scheduler2, settingsStore, backend, noReviews);
  await scheduler2.recover();
  await until(async () => {
    const current = await scheduler2.get(job.id);
    return current?.state === "completed";
  }, "recovered job to complete");
  assert.equal(submits, 1, "no resubmission after reconnect");
  assert.equal(resumes, 1, "resume used the recorded server job id");
  const completed = await scheduler2.get(job.id);
  assert.deepEqual(completed?.result, { outputRefs: ["recovered-blob"] });
  assert.equal(await ledger.lookup(job.id), undefined, "ledger row cleared");
  const rows = await mediaQueueRows(scheduler2, ledger);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.state, "completed");
  assert.equal(rows[0]?.attempt, 2);
  neverResolve.resolve({ outputRefs: ["stale"] });
});

test("sqlite ledger persists server job ids", async () => {
  const rows = new Map<string, string>();
  const statements: string[] = [];
  const db = {
    async execAsync(sql: string) {
      statements.push(sql);
    },
    async runAsync(sql: string, ...params: unknown[]) {
      statements.push(sql);
      const jobId = String(params[0]);
      if (sql.startsWith("INSERT")) rows.set(jobId, String(params[1]));
      else rows.delete(jobId);
    },
    async getFirstAsync<T>(sql: string, ...params: unknown[]) {
      const hit = rows.get(String(params[0]));
      return (hit ? { server_job_id: hit } : null) as T | null;
    },
  };
  const ledger = new SqliteServerJobLedger(db);
  await ledger.initialize();
  await ledger.record("job-1", "p-9", "comfyui");
  assert.equal(await ledger.lookup("job-1"), "p-9");
  await ledger.clear("job-1");
  assert.equal(await ledger.lookup("job-1"), undefined);
  assert.ok(statements.some((s) => s.includes("media_server_jobs")));
});

test("cancelling a running job surfaces canceled state with its server job id", async () => {
  const gate = Promise.withResolvers<{ outputRefs: string[] }>();
  const inner: MediaBackendPort = {
    generate(context) {
      context.reportServerJob("p-5");
      return gate.promise;
    },
  };
  const ledger = new MemoryServerJobLedger();
  const backend = new RecoveringMediaBackend(inner, ledger, "comfyui", 1);
  const scheduler = new JobScheduler(new MemoryJobStore(), { deviceId });
  const service = new MediaJobService(
    scheduler,
    settingsStore,
    backend,
    noReviews,
  );
  const job = await expectJob(
    service.requestGeneration(request("cancel me")),
  );
  await until(
    async () => (await ledger.lookup(job.id)) === "p-5",
    "server job id to be recorded",
  );
  const during = await mediaQueueRows(scheduler, ledger);
  assert.equal(during[0]?.state, "running");
  assert.equal(during[0]?.serverJobId, "p-5");
  await scheduler.cancel(job.id);
  const rows = await mediaQueueRows(scheduler, ledger);
  assert.equal(rows[0]?.state, "canceled");
  gate.resolve({ outputRefs: [] });
});
