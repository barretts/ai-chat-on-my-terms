import assert from "node:assert/strict";
import test from "node:test";
import { JobScheduler } from "@locallab/jobs";
import { MemoryJobStore } from "@locallab/jobs/memory-store";
import {
  MediaJobService,
  type MediaBackendPort,
  type MediaReviewDraft,
} from "@locallab/media-engine";
import {
  imagePromptFrom,
  onChatTurnCompleted,
  type ChatMediaTurn,
} from "../src/index.ts";

const CONVERSATION = "0198f2a3-0000-7000-8000-00000000000a";

function build(
  backend: MediaBackendPort,
  settings = { enabled: true, promptReview: false, autoGenerate: true },
) {
  const store = new MemoryJobStore();
  const scheduler = new JobScheduler(store, {
    deviceId: "0198f2a3-0000-7000-8000-0000000000ff",
  });
  const drafts = new Map<string, MediaReviewDraft>();
  const service = new MediaJobService(
    scheduler,
    {
      async load() {
        return settings;
      },
      async save() {},
    },
    backend,
    {
      async save(draft: MediaReviewDraft) {
        drafts.set(draft.id, draft);
      },
      async get(id: string) {
        return drafts.get(id);
      },
      async findByIdempotencyKey(key: string) {
        return [...drafts.values()].find((d) => d.idempotencyKey === key);
      },
      async delete(id: string) {
        drafts.delete(id);
      },
      async list() {
        return [...drafts.values()];
      },
    },
  );
  return { store, scheduler, service, drafts };
}

const turn = (over: Partial<ChatMediaTurn> = {}): ChatMediaTurn => ({
  conversationId: CONVERSATION,
  assistantText: "A fox reading a book in neon rain.\n\nMore prose here.",
  finalState: "completed",
  ...over,
});

test("completed turns queue an image with the derived first-line prompt", async () => {
  const built = build({
    async generate() {
      return { outputRefs: [] };
    },
  });
  const result = await onChatTurnCompleted(turn(), {
    service: built.service,
    defaultWorkflow: { name: "comfy-default", definition: {} },
    findWorkflow: () => undefined,
  });
  assert.equal(result.kind, "job");
  if (result.kind !== "job") return;
  assert.equal(result.job.input instanceof Object, true);
  const snapshot = result.job.input as { prompt: string; conversationId: string };
  assert.equal(snapshot.prompt, "A fox reading a book in neon rain.");
  assert.equal(snapshot.conversationId, CONVERSATION);
});

test("stopping text before completion prevents automatic image work", async () => {
  let calls = 0;
  const built = build({
    async generate() {
      calls++;
      return { outputRefs: [] };
    },
  });
  for (const finalState of ["canceled", "failed"] as const) {
    const result = await onChatTurnCompleted(turn({ finalState }), {
      service: built.service,
      defaultWorkflow: { name: "comfy-default", definition: {} },
      findWorkflow: () => undefined,
    });
    assert.equal(result.kind, "skipped", finalState);
  }
  assert.equal(calls, 0);
  assert.equal((await built.scheduler.list()).length, 0);
});

test("persona-bound workflow wins over the global default", async () => {
  const seen: string[] = [];
  const built = build({
    async generate(context) {
      seen.push(context.snapshot.workflowSnapshot.name);
      return { outputRefs: [] };
    },
  });
  const result = await onChatTurnCompleted(
    turn({ personaProfile: { media: { workflowIds: ["cyberpunk-pack"] } } }),
    {
      service: built.service,
      defaultWorkflow: { name: "comfy-default", definition: {} },
      findWorkflow: (id) =>
        id === "cyberpunk-pack"
          ? { name: "cyberpunk-pack", definition: { ckpt: "cy.safetensors" } }
          : undefined,
    },
  );
  assert.equal(result.kind, "job");
  assert.deepEqual(seen, ["cyberpunk-pack"]);
});

test("removed persona binding skips instead of substituting the global workflow", async () => {
  const built = build({
    async generate() {
      return { outputRefs: [] };
    },
  });
  const result = await onChatTurnCompleted(
    turn({ personaProfile: { media: { workflowIds: ["deleted-pack"] } } }),
    {
      service: built.service,
      defaultWorkflow: { name: "comfy-default", definition: {} },
      findWorkflow: () => undefined,
    },
  );
  assert.equal(result.kind, "skipped");
  if (result.kind === "skipped")
    assert.match(result.reason, /no other workflow was used/i);
  assert.equal((await built.scheduler.list()).length, 0);
});

test("engine settings still gate chat requests: auto-generate off suppresses", async () => {
  const built = build(
    {
      async generate() {
        return { outputRefs: [] };
      },
    },
    { enabled: true, promptReview: false, autoGenerate: false },
  );
  const result = await onChatTurnCompleted(turn(), {
    service: built.service,
    defaultWorkflow: { name: "comfy-default", definition: {} },
    findWorkflow: () => undefined,
  });
  assert.equal(result.kind, "suppressed");
});

test("prompt review stores a draft, never touching chat history", async () => {
  const built = build(
    {
      async generate() {
        return { outputRefs: [] };
      },
    },
    { enabled: true, promptReview: true, autoGenerate: true },
  );
  const source = turn();
  const result = await onChatTurnCompleted(source, {
    service: built.service,
    defaultWorkflow: { name: "comfy-default", definition: {} },
    findWorkflow: () => undefined,
  });
  assert.equal(result.kind, "review");
  assert.equal(built.drafts.size, 1);
  assert.equal(source.assistantText.includes("\n\nMore prose here."), true);
  assert.equal(imagePromptFrom(source), "A fox reading a book in neon rain.");
});
