import assert from "node:assert/strict";
import test from "node:test";
import { MediaBackendError, type MediaSnapshot } from "@locallab/media-engine";
import { RecoveringMediaBackend } from "@locallab/media-queue";
import {
  MediaServerConfigSchema,
  SqliteMediaServerConfigStore,
  SqliteMediaSettingsStore,
  buildMediaBackend,
} from "../src/index.js";

function fakeDb(rows: Map<string, string>) {
  const statements: string[] = [];
  return {
    statements,
    async execAsync(sql: string) {
      statements.push(sql);
    },
    async runAsync(sql: string, ...params: unknown[]) {
      statements.push(sql);
      const id = String(params[0]);
      if (sql.startsWith("INSERT")) rows.set(id, String(params[1]));
      else rows.delete(id);
    },
    async getFirstAsync<T>(sql: string, ...params: unknown[]) {
      const hit = rows.get(String(params[0]));
      return (hit === undefined ? null : { value_json: hit }) as T | null;
    },
  };
}

test("media settings default off and round-trip durably", async () => {
  const rows = new Map<string, string>();
  const db = fakeDb(rows);
  const store = new SqliteMediaSettingsStore(db);
  await store.initialize();
  assert.deepEqual(await store.load(), {
    enabled: false,
    promptReview: false,
    autoGenerate: false,
  });
  await store.save({ enabled: true, promptReview: true, autoGenerate: false });
  assert.deepEqual(await store.load(), {
    enabled: true,
    promptReview: true,
    autoGenerate: false,
  });
  assert.ok(
    db.statements.some((s) => s.includes("media_settings")),
    "settings table is created durably",
  );
});

test("server config store round-trips and rejects unknown shapes", async () => {
  const rows = new Map<string, string>();
  const store = new SqliteMediaServerConfigStore(fakeDb(rows));
  await store.initialize();
  assert.equal(await store.load(), undefined);
  await store.save({ backend: "comfyui", baseUrl: "http://127.0.0.1:8188" });
  assert.deepEqual(await store.load(), {
    backend: "comfyui",
    baseUrl: "http://127.0.0.1:8188",
  });
  assert.throws(
    () => MediaServerConfigConfigParseThrows(),
    /baseUrl/,
  );
});

function MediaServerConfigConfigParseThrows() {
  return MediaServerConfigSchema.parse({ backend: "comfyui" });
}

test("coreml without injected hardware backend reports unsupported", () => {
  const result = buildMediaBackend(
    { backend: "coreml", baseUrl: "local://coreml" },
    { db: fakeDb(new Map()), blobSink: async () => "ref" },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "unsupported");
  assert.match(result.failure.message, /iPhone/);
});

test("eligible hardware injects the coreml backend without a server ledger", () => {
  const injected = {
    async generate() {
      return { outputRefs: ["blob-coreml-1"] };
    },
  };
  const result = buildMediaBackend(
    { backend: "coreml", baseUrl: "local://coreml" },
    {
      db: fakeDb(new Map()),
      blobSink: async () => "ref",
      coremlBackend: injected,
    },
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.backendId, "coreml");
  assert.equal(result.backend, injected);
});
test("unknown backend and malformed url give distinct typed failures", () => {
  const deps = { db: fakeDb(new Map()), blobSink: async () => "ref" };
  const unknown = buildMediaBackend(
    { backend: "novel-gen", baseUrl: "http://x" },
    deps,
  );
  const malformed = buildMediaBackend(
    { backend: "comfyui", baseUrl: "ftp://x" },
    deps,
  );
  assert.ok(!unknown.ok && !malformed.ok);
  if (unknown.ok || malformed.ok) return;
  assert.equal(unknown.failure.code, "unsupported");
  assert.equal(malformed.failure.code, "malformed");
});
function snapshot(prompt: string, definition = {}): MediaSnapshot {
  return {
    conversationId: "0198f2a3-0000-7000-8000-000000000001",
    prompt,
    inputRefs: [],
    workflowSnapshot: { name: "comfy-default", definition },
    capturedAt: new Date().toISOString(),
  };
}

test("selected comfyui backend reaches the ledger and maps transport failures to offline", async () => {
  const rows = new Map<string, string>();
  const built = buildMediaBackend(
    { backend: "comfyui", baseUrl: "http://127.0.0.1:8188" },
    {
      db: fakeDb(rows),
      blobSink: async () => "blob-1",
      fetchImpl: async () => {
        throw new TypeError("fetch failed: connection refused");
      },
    },
  );
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.ok(built.backend instanceof RecoveringMediaBackend);
  await assert.rejects(
    built.backend.generate({
      snapshot: snapshot("a red fox"),
      jobId: "0198f2a3-0000-7000-8000-000000000abc",
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
      reportServerJob: () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof MediaBackendError);
      if (!(error instanceof MediaBackendError)) return false;
      assert.equal(error.failure.code, "offline");
      return true;
    },
  );
});

test("server-side endpoint failures stay distinct from transport failures", async () => {
  const built = buildMediaBackend(
    { backend: "a1111", baseUrl: "http://127.0.0.1:7860" },
    {
      db: fakeDb(new Map()),
      blobSink: async () => "blob-1",
      fetchImpl: async (url) => ({
        ok: false,
        status: url.includes("txt2img") ? 404 : 200,
        json: async () => ({ error: { message: "no endpoint" } }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    },
  );
  assert.ok(built.ok);
  if (!built.ok) return;
  await assert.rejects(
    built.backend.generate({
      snapshot: snapshot("a red fox", { steps: 20, cfgScale: 7, width: 512, height: 512 }),
      jobId: "0198f2a3-0000-7000-8000-000000000abd",
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
      reportServerJob: () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof MediaBackendError);
      if (!(error instanceof MediaBackendError)) return false;
      assert.equal(error.failure.code, "host-stopped");
      return true;
    },
  );
});
