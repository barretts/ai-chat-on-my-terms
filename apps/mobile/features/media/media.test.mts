import { describe, expect, it } from "vitest";
import { JobScheduler } from "@locallab/jobs";
import { MemoryJobStore } from "@locallab/jobs/memory-store";
import {
  MediaBackendError,
  MediaJobService,
  type MediaBackendPort,
  type MediaRequestOutcome,
  type MediaReviewDraft,
} from "@locallab/media-engine";
import {
  galleryAssets,
  mediaJobViews,
  outcomeNote,
  reviewRows,
} from ".";

const CONVERSATION_A = "0198f2a3-0000-7000-8000-00000000000a";
const CONVERSATION_B = "0198f2a3-0000-7000-8000-00000000000b";
const DEVICE = "0198f2a3-0000-7000-8000-0000000000ff";

const memorySettings = (promptReview = false) => ({
  async load() {
    return { enabled: true, promptReview, autoGenerate: true };
  },
  async save() {},
});


const memoryReviews = () => {
  const rows = new Map<string, MediaReviewDraft>();
  return {
    async save(draft: MediaReviewDraft) {
      rows.set(draft.id, draft);
    },
    async get(id: string) {
      return rows.get(id);
    },
    async findByIdempotencyKey(key: string) {
      return [...rows.values()].find((d) => d.idempotencyKey === key);
    },
    async delete(id: string) {
      rows.delete(id);
    },
    async list() {
      return [...rows.values()];
    },
  };
};


function build(backend: MediaBackendPort, promptReview = false) {
  const store = new MemoryJobStore();
  const scheduler = new JobScheduler(store, { deviceId: DEVICE });
  const reviews = memoryReviews();
  const service = new MediaJobService(
    scheduler,
    memorySettings(promptReview),
    backend,
    reviews,
  );
  return { store, scheduler, service, reviews };
}

async function until(
  fn: () => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const request = (conversationId: string, prompt: string) => ({
  conversationId,
  prompt,
  requestedBy: "button" as const,
  workflow: { name: "comfy-default", definition: {} },
});

describe("media job views", () => {
  it("surfaces prompt, outputs, and typed failure messages", async () => {
    const backend: MediaBackendPort = {
      async generate(context) {
        if (context.snapshot.prompt === "boom")
          throw new MediaBackendError({
            code: "offline",
            message: "The image server is not reachable.",
            recoverable: true,
          });
        return { outputRefs: ["media/blob-1.png"] };
      },
    };
    const built = build(backend);
    const ok = await built.service.requestGeneration(
      request(CONVERSATION_A, "a red fox"),
    );
    const bad = await built.service.requestGeneration(
      request(CONVERSATION_A, "boom"),
    );
    if (ok.kind !== "job" || bad.kind !== "job")
      throw new Error("expected queued jobs");
    await until(
      async () =>
        (await built.scheduler.get(ok.job.id))?.state === "completed" &&
        (await built.scheduler.get(bad.job.id))?.state === "failed",
      "both jobs to settle",
    );
    const views = mediaJobViews(await built.scheduler.list());
    const done = views.find((view) => view.jobId === ok.job.id);
    const failed = views.find((view) => view.jobId === bad.job.id);
    expect(done?.prompt).toBe("a red fox");
    expect(done?.conversationId).toBe(CONVERSATION_A);
    expect(done?.outputRefs).toEqual(["media/blob-1.png"]);
    expect(failed?.errorMessage).toBe(
      "The image server is not reachable.",
    );
  });

  it("ignores non-media jobs and malformed snapshots", async () => {
    const built = build({
      async generate() {
        return { outputRefs: [] };
      },
    });
    await built.scheduler.start({
      kind: "model-download",
      category: "download",
      idempotencyKey: "dl-1",
      input: { modelId: "x" },
    });
    const views = mediaJobViews(await built.scheduler.list());
    expect(views.filter((view) => view.jobId.length > 0)).toHaveLength(0);
  });
});

describe("gallery scopes and persistence", () => {
  it("scopes gallery to the conversation and rebuilds after reopen", async () => {
    const backend: MediaBackendPort = {
      async generate(context) {
        return {
          outputRefs: [
            `media/blob-${context.snapshot.prompt.length}.png`,
            "media/clip.mp4",
          ],
        };
      },
    };
    const built = build(backend);
    const first = await built.service.requestGeneration(
      request(CONVERSATION_A, "fox"),
    );
    const second = await built.service.requestGeneration(
      request(CONVERSATION_B, "owl in a very long prompt"),
    );
    if (first.kind !== "job" || second.kind !== "job")
      throw new Error("expected queued jobs");
    await until(
      async () =>
        (await built.scheduler.get(first.job.id))?.state === "completed" &&
        (await built.scheduler.get(second.job.id))?.state === "completed",
      "both jobs to complete",
    );
    const scoped = galleryAssets(
      mediaJobViews(await built.scheduler.list()),
      { kind: "conversation", conversationId: CONVERSATION_A },
    );
    expect(scoped).toHaveLength(2);
    expect(scoped.every((asset) => asset.conversationId === CONVERSATION_A)).toBe(
      true,
    );
    expect(scoped.map((asset) => asset.artifact.kind)).toEqual([
      "image",
      "video",
    ]);

    // Reopen path: a fresh scheduler over the same durable store sees the
    // same assets, including playable metadata for .mp4 refs.
    const reopened = new JobScheduler(built.store, { deviceId: DEVICE });
    const globalAssets = galleryAssets(
      mediaJobViews(await reopened.list()),
      { kind: "global" },
    );
    expect(globalAssets).toHaveLength(4);
    const clip = globalAssets.find((asset) => asset.ref === "media/clip.mp4");
    expect(clip?.artifact).toEqual({
      kind: "video",
      mimeType: "video/mp4",
    });
  });

  it("hides pending and failed jobs from the gallery", async () => {
    const gate = Promise.withResolvers<{ outputRefs: string[] }>();
    const backend: MediaBackendPort = {
      generate() {
        return gate.promise;
      },
    };
    const built = build(backend);
    const outcome = await built.service.requestGeneration(
      request(CONVERSATION_A, "pending one"),
    );
    if (outcome.kind !== "job") throw new Error("expected queued job");
    await until(
      async () => (await built.scheduler.get(outcome.job.id))?.state === "running",
      "job to start running",
    );
    const assets = galleryAssets(await built.scheduler.list().then(mediaJobViews), {
      kind: "global",
    });
    expect(assets).toHaveLength(0);
    gate.resolve({ outputRefs: ["media/blob-9.png"] });
  });
});

describe("review rows and outcome notes", () => {
  it("maps pending drafts into review rows", async () => {
    const built = build(
      {
        async generate() {
          return { outputRefs: [] };
        },
      },
      true,
    );
    const outcome = await built.service.requestGeneration(
      request(CONVERSATION_A, "a blue owl"),
    );
    const rows = reviewRows(await built.reviews.list());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prompt).toBe("a blue owl");
    expect(rows[0]?.conversationId).toBe(CONVERSATION_A);
    expect(outcome.kind).toBe("review");
  });

  it("explains every request outcome to the user", () => {
    const jobOutcome: MediaRequestOutcome = {
      kind: "job",
      job: {
        id: "0198f2a3-0000-7000-8000-00000000000c",
        kind: "image-generate",
        state: "queued",
        progress: null,
        startedAt: null,
        finishedAt: null,
        category: "media",
        idempotencyKey: "k",
        input: {},
        attempt: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        revision: 1,
      },
    };
    expect(outcomeNote(jobOutcome)).toMatch(/queue/i);
    expect(
      outcomeNote({ kind: "suppressed", reason: "Image generation is off." }),
    ).toBe("Image generation is off.");
  });
});
