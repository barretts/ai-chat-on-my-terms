import assert from "node:assert/strict";
import test from "node:test";
import { JobScheduler, type JobRecord } from "@locallab/jobs";
import { MemoryJobStore } from "@locallab/jobs/memory-store";
import {
  MediaBackendError,
  MediaJobService,
  type MediaBackendPort,
  type MediaGenerationRequest,
  type MediaRequestOutcome,
  type MediaReviewDraft,
  type MediaReviewStore,
  type MediaSettings,
  type MediaSettingsStore,
} from "../src/index.js";

const deviceId = "0198f2a3-7b6c-7d4e-8f0a-1b2c3d4e5f60";

function expectJob(outcome: MediaRequestOutcome): JobRecord {
  if (outcome.kind !== "job") throw new Error(`expected job, got ${outcome.kind}`);
  return outcome.job;
}
function expectReview(outcome: MediaRequestOutcome): MediaReviewDraft {
  if (outcome.kind !== "review")
    throw new Error(`expected review, got ${outcome.kind}`);
  return outcome.draft;
}
function expectSuppressed(outcome: MediaRequestOutcome): string {
  if (outcome.kind !== "suppressed")
    throw new Error(`expected suppressed, got ${outcome.kind}`);
  return outcome.reason;
}

class MemorySettingsStore implements MediaSettingsStore {
  constructor(public value: MediaSettings) {}
  async load(): Promise<MediaSettings> {
    return { ...this.value };
  }
  async save(next: MediaSettings): Promise<void> {
    this.value = next;
  }
}

class MemoryReviewStore implements MediaReviewStore {
  private rows = new Map<string, MediaReviewDraft>();
  async save(draft: MediaReviewDraft): Promise<void> {
    this.rows.set(draft.id, draft);
  }
  async get(id: string): Promise<MediaReviewDraft | undefined> {
    return this.rows.get(id);
  }
  async findByIdempotencyKey(
    key: string,
  ): Promise<MediaReviewDraft | undefined> {
    return [...this.rows.values()].find((d) => d.idempotencyKey === key);
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async list(): Promise<MediaReviewDraft[]> {
    return [...this.rows.values()];
  }
}

const request = (over: Partial<MediaGenerationRequest> = {}) => ({
  conversationId: "0198f2a3-0000-7000-8000-000000000001",
  prompt: "a red fox",
  requestedBy: "button" as const,
  workflow: { name: "flux", definition: { steps: 20 } },
  ...over,
});

async function until(fn: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function build(
  backend: MediaBackendPort,
  settings = new MemorySettingsStore({
    enabled: true,
    promptReview: false,
    autoGenerate: true,
  }),
) {
  const store = new MemoryJobStore();
  const scheduler = new JobScheduler(store, { deviceId });
  const reviews = new MemoryReviewStore();
  const service = new MediaJobService(scheduler, settings, backend, reviews);
  return { store, scheduler, service, settings, reviews };
}

test("duplicate enqueue returns one job", async () => {
  let calls = 0;
  const built = build({
    async generate() {
      calls++;
      return { outputRefs: ["blob-1"] };
    },
  });
  const first = await built.service.requestGeneration(request());
  const second = await built.service.requestGeneration(request());
  const a = expectJob(first);
  const b = expectJob(second);
  assert.equal(a.id, b.id);
  await until(
    async () => calls === 1,
    "handler to run exactly once",
  );
  assert.equal(calls, 1);
  assert.equal((await built.scheduler.list()).length, 1);
});

test("auto-generation obeys the user toggle", async () => {
  let calls = 0;
  const settings = new MemorySettingsStore({
    enabled: true,
    promptReview: false,
    autoGenerate: false,
  });
  const built = build(
    {
      async generate() {
        calls++;
        return { outputRefs: [] };
      },
    },
    settings,
  );
  const chat = await built.service.requestGeneration(
    request({ requestedBy: "chat" }),
  );
  assert.match(expectSuppressed(chat), /Automatic image generation is off/);
  settings.value = { enabled: false, promptReview: false, autoGenerate: true };
  const off = await built.service.requestGeneration(
    request({ requestedBy: "button" }),
  );
  assert.match(expectSuppressed(off), /turned off in Settings/);
  assert.equal(calls, 0);
  assert.equal((await built.scheduler.list()).length, 0);
});

test("prompt review freezes the snapshot until approved", async () => {
  let calls = 0;
  const built = build(
    {
      async generate() {
        calls++;
        return { outputRefs: ["blob-2"] };
      },
    },
    new MemorySettingsStore({
      enabled: true,
      promptReview: true,
      autoGenerate: true,
    }),
  );
  const first = await built.service.requestGeneration(request());
  const again = await built.service.requestGeneration(request());
  const draft = expectReview(first);
  assert.equal(expectReview(again).id, draft.id, "duplicate review returns one draft");
  assert.equal(
    (await built.reviews.list()).length,
    1,
    "review queue lists one pending draft",
  );
  assert.equal(draft.snapshot.prompt, "a red fox");
  assert.equal(calls, 0);
  const job = await built.service.approveReview(draft.id);
  assert.ok(job);
  await until(async () => {
    const current = await built.scheduler.get(job.id);
    return current?.state === "completed";
  }, "approved job to complete");
  assert.equal(calls, 1);
  assert.equal(await built.reviews.get(draft.id), undefined);

  const other = await built.service.requestGeneration(
    request({ prompt: "a blue owl" }),
  );
  const otherDraft = expectReview(other);
  await built.service.cancelReview(otherDraft.id);
  assert.equal(await built.reviews.get(otherDraft.id), undefined);
  assert.equal(
    (await built.reviews.list()).length,
    0,
    "review queue empties after approve and cancel",
  );
});

test("canceled output is not marked complete", async () => {
  const gate = Promise.withResolvers<{ outputRefs: string[] }>();
  const built = build({
    generate() {
      return gate.promise;
    },
  });
  const job = expectJob(await built.service.requestGeneration(request()));
  await until(async () => {
    const current = await built.scheduler.get(job.id);
    return current?.state === "running";
  }, "job to start");
  await built.service.cancelJob(job.id);
  gate.resolve({ outputRefs: ["late-output"] });
  await new Promise((r) => setTimeout(r, 30));
  const final = await built.scheduler.get(job.id);
  assert.equal(final?.state, "canceled");
  assert.equal(final?.result, undefined);
  assert.equal(final?.finishedAt !== null, true);
});

test("server-unreachable and checkpoint failures surface typed errors", async () => {
  const built = build({
    async generate({ snapshot }) {
      if (snapshot.workflowSnapshot.name === "checkpointed")
        throw new MediaBackendError({
          code: "missing-model",
          message: "Checkpoint sdxv1.5.ckpt is missing on the server.",
          recoverable: true,
          backend: "a1111",
        });
      throw new MediaBackendError({
        code: "offline",
        message: "Image server is not reachable.",
        recoverable: true,
        backend: "a1111",
      });
    },
  });
  const job1 = expectJob(
    await built.service.requestGeneration(request({ prompt: "p1" })),
  );
  await until(async () => {
    const current = await built.scheduler.get(job1.id);
    return current?.state === "failed";
  }, "unreachable job to fail");
  const typed1 = JSON.parse((await built.scheduler.get(job1.id))?.error ?? "");
  assert.equal(typed1.code, "offline");
  assert.equal(typed1.backend, "a1111");

  const job2 = expectJob(
    await built.service.requestGeneration(
      request({
        prompt: "p2",
        workflow: { name: "checkpointed", definition: {} },
      }),
    ),
  );
  await until(async () => {
    const current = await built.scheduler.get(job2.id);
    return current?.state === "failed";
  }, "checkpoint job to fail");
  const typed2 = JSON.parse(
    (await built.scheduler.get(job2.id))?.error ?? "",
  );
  assert.equal(typed2.code, "missing-model");
});
