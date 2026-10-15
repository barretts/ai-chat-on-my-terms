import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import type { BlobStore } from "@locallab/storage-blobs";
import { createMediaRuntime } from "./providers";

test("composition media runtime drives an offline comfyui job to a typed failure and survives reopen", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
CREATE TABLE scheduled_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  state TEXT NOT NULL,
  progress REAL,
  started_at TEXT,
  finished_at TEXT,
  attempt INTEGER NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision_wall_ms INTEGER NOT NULL,
  revision_counter INTEGER NOT NULL,
  revision_device_id TEXT NOT NULL
);`);
  const db = {
    async execAsync(sql: string) {
      raw.exec(sql);
    },
    async runAsync(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).run(...(params as never[]));
    },
    async getFirstAsync<T>(sql: string, ...params: unknown[]) {
      return (raw.prepare(sql).get(...(params as never[])) ?? null) as T | null;
    },
    async getAllAsync<T>(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
    async withTransactionAsync(fn: () => Promise<unknown>) {
      raw.exec("BEGIN");
      try {
        const result = await fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const blobs = {
    async importBytes(bytes: Uint8Array, options?: { mimeType?: string }) {
      return { id: `blob-${bytes.byteLength}-${options?.mimeType ?? ""}` };
    },
  };
  const runtime = await createMediaRuntime({
    db,
    blobs: blobs as unknown as BlobStore,
  });
  assert.equal(runtime.selection.ok, true);
  await runtime.settings.save({
    enabled: true,
    promptReview: false,
    autoGenerate: true,
  });
  const outcome = await runtime.service!.requestGeneration({
    conversationId: "0198f2a3-0000-7000-8000-00000000000a",
    prompt: "a red fox in neon rain",
    requestedBy: "button",
    workflow: { name: "comfy-default", definition: {} },
  });
  assert.equal(outcome.kind, "job");
  if (outcome.kind !== "job") return;
  const jobId = outcome.job.id;
  let final = outcome.job;
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await runtime.scheduler.get(jobId);
    if (current) final = current;
    if (final.state === "failed" || final.state === "completed") break;
  }
  assert.equal(final.state, "failed");
  assert.match(final.error ?? "", /offline/);
  const reopened = await createMediaRuntime({
    db,
    blobs: blobs as unknown as BlobStore,
  });
  assert.deepEqual(await reopened.settings.load(), {
    enabled: true,
    promptReview: false,
    autoGenerate: true,
  });
  assert.equal((await reopened.scheduler.list()).length, 1);
  raw.close();
});
