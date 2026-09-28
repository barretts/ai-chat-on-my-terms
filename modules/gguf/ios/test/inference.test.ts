import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRequest } from "@locallab/contracts/run-events";
import type { LlamaContext } from "llama.rn";
import {
  createGgufInferencePort,
  type GgufInferenceOptions,
  type LlamaRuntime,
  type ManagedModelFiles,
} from "../src/index.js";

const request = (parameters: Record<string, unknown> = {}): RunRequest => ({
  runId: "run-00000000-0000-4000-8000-000000000001",
  conversationId: "conversation-00000000-0000-4000-8000-000000000001",
  messageId: "message-00000000-0000-4000-8000-000000000001",
  providerConnectionId: "connection-00000000-0000-4000-8000-000000000001",
  modelId: "blob:00000000-0000-4000-8000-000000000001",
  context: [{ kind: "user", value: "hello" }],
  parameters,
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
});

function setup(overrides: Partial<GgufInferenceOptions> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const files: ManagedModelFiles = overrides.files ?? {
    async acquire(model) {
      assert.equal(model.blobId, "00000000-0000-4000-8000-000000000001");
      return {
        uri: "file:///private/model.gguf",
        async release() {
          calls.push({ released: true });
        },
      };
    },
  };
  const context = {
    parallel: {
      async enable(params: Record<string, unknown>) {
        calls.push({ enable: params });
      },
      async completion(
        params: Record<string, unknown>,
        callback?: (
          id: number,
          token: {
            token: string;
            content?: string;
            reasoning_content?: string;
          },
        ) => void,
      ) {
        calls.push({ completion: params });
        callback?.(1, { token: "Hi", content: "Hi" });
        let resolve!: (value: {
          timings: { prompt_n: number; predicted_n: number };
        }) => void;
        const promise = new Promise<{
          timings: { prompt_n: number; predicted_n: number };
        }>((done) => {
          resolve = done;
        });
        const stop = async () => {
          calls.push({ stopped: true });
          resolve({ timings: { prompt_n: 2, predicted_n: 1 } });
        };
        queueMicrotask(() =>
          resolve({ timings: { prompt_n: 2, predicted_n: 1 } }),
        );
        return { requestId: 1, promise, stop };
      },
    },
    async release() {
      calls.push({ contextReleased: true });
    },
  } as unknown as LlamaContext;
  const runtime: LlamaRuntime = {
    async initLlama(args) {
      calls.push({ load: args });
      return context;
    },
  };
  return {
    calls,
    port: createGgufInferencePort({ files, runtime, ...overrides }),
  };
}

test("loads only a managed blob, clamps parameters, streams ordered deltas, then releases", async () => {
  const { calls, port } = setup({
    memory: {
      async availableBytes() {
        return 1_000_000_000;
      },
    },
    maxContextSize: 4096,
  });
  const events = [];
  for await (const event of port.startRun(
    request({
      n_ctx: 100_000,
      n_batch: 8000,
      temperature: 9,
      max_tokens: 9000,
    }),
    new AbortController().signal,
  ))
    events.push(event);
  assert.deepEqual(
    events.map((event) => event.type),
    ["RunStarted", "TextDelta", "Usage", "RunCompleted"],
  );
  const load = calls.find((call) => "load" in call)?.["load"] as Record<
    string,
    unknown
  >;
  assert.equal(load["n_ctx"], 666);
  assert.equal(load["n_batch"], 666);
  assert.equal(load["use_mlock"], false);
  const completion = calls.find((call) => "completion" in call)?.[
    "completion"
  ] as Record<string, unknown>;
  assert.equal(completion["temperature"], 2);
  assert.equal(completion["n_predict"], 8192);
  assert.ok(calls.some((call) => "released" in call));
  assert.ok(calls.some((call) => "contextReleased" in call));
});

test("cancels a live native request and emits a single terminal cancellation", async () => {
  let resolveCompletion!: (value: {
    timings: { prompt_n: number; predicted_n: number };
  }) => void;
  let stops = 0;
  const context = {
    parallel: {
      async enable() {},
      async completion() {
        return {
          requestId: 1,
          promise: new Promise<{
            timings: { prompt_n: number; predicted_n: number };
          }>((resolve) => {
            resolveCompletion = resolve;
          }),
          async stop() {
            stops++;
            resolveCompletion({ timings: { prompt_n: 1, predicted_n: 0 } });
          },
        };
      },
    },
    async release() {},
  } as unknown as LlamaContext;
  const runtime: LlamaRuntime = {
    async initLlama() {
      return context;
    },
  };
  const { port } = setup({ runtime });
  const controller = new AbortController();
  const eventsPromise = (async () => {
    const events = [];
    for await (const event of port.startRun(request(), controller.signal))
      events.push(event);
    return events;
  })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const events = await eventsPromise;
  assert.equal(stops, 1);
  assert.equal(events.at(-1)?.type, "RunCanceled");
});

test("rejects path-like and non-blob model references without touching runtime", async () => {
  const { port } = setup();
  const bad = { ...request(), modelId: "file:///tmp/model.gguf" };
  const events = [];
  for await (const event of port.startRun(bad, new AbortController().signal))
    events.push(event);
  assert.equal(events.at(-1)?.type, "RunFailed");
  const failure = events.at(-1);
  assert.ok(failure?.type === "RunFailed");
  if (failure?.type === "RunFailed")
    assert.equal(failure.error.code, "missing-model");
});

test("managed-file adapter validates GGUF magic and leases while the runtime owns a staged URI", async () => {
  let leases = 0;
  const blobs = {
    async read() {
      return {
        metadata: {
          id: "x",
          sha256: "a".repeat(64),
          mimeType: "application/octet-stream",
          byteLength: 4,
          managedPath: "blobs/x",
          createdAt: "now",
        },
        bytes: new Uint8Array([0x47, 0x47, 0x55, 0x46]),
      };
    },
    async acquireLease() {
      leases++;
      return { token: "lease", blobId: "x", purpose: "gguf" };
    },
    async releaseLease() {
      leases--;
    },
  };
  const { createBlobManagedModelFiles } = await import("../src/index.js");
  const files = createBlobManagedModelFiles(blobs as never, {
    async stage() {
      return "file:///private/x.gguf";
    },
    async release() {},
  });
  const lease = await files.acquire({ blobId: "x" });
  assert.equal(lease.uri, "file:///private/x.gguf");
  assert.equal(leases, 1);
  await lease.release();
  assert.equal(leases, 0);
});

test("native completion enables its slot before dispatch and maps app context/output/thinking options", async () => {
  // Injected runtime fixture models the pinned native requirement that queued
  // completion is unavailable until parallel.enable has finished.
  const calls: string[] = [];
  let enabled = false;
  let load: Record<string, unknown> | undefined;
  let completion: Record<string, unknown> | undefined;
  const context = {
    parallel: {
      async enable(parameters: Record<string, unknown>) {
        assert.deepEqual(parameters, { n_parallel: 1, n_batch: 64 });
        calls.push("enable");
        enabled = true;
      },
      async completion(
        parameters: Record<string, unknown>,
        callback: (id: number, token: { token: string }) => void,
      ) {
        assert.ok(
          enabled,
          "native completion cannot dispatch before slot admission",
        );
        calls.push("completion");
        completion = parameters;
        callback(1, { token: "Final queued token" });
        return {
          requestId: 1,
          promise: Promise.resolve({
            stopped_limit: 1,
            timings: { prompt_n: 5, predicted_n: 73 },
          }),
          async stop() {},
        };
      },
    },
    async release() {
      calls.push("context release");
    },
  } as unknown as LlamaContext;
  const { port } = setup({
    runtime: {
      async initLlama(parameters) {
        load = parameters;
        calls.push("load");
        return context;
      },
    },
    contextSize: 2048,
  });
  const events = [];
  for await (const event of port.startRun(
    request({
      contextWindow: 3072,
      n_ctx: 512,
      n_batch: 64,
      max_output_tokens: 73,
      max_tokens: 9999,
      enable_thinking: true,
    }),
    new AbortController().signal,
  ))
    events.push(event);
  assert.equal(load?.["n_ctx"], 3072);
  assert.equal(load?.["n_parallel"], 1);
  assert.equal(completion?.["n_predict"], 73);
  assert.equal(completion?.["enable_thinking"], true);
  assert.deepEqual(calls, ["load", "enable", "completion", "context release"]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["RunStarted", "TextDelta", "Usage", "RunCompleted"],
  );
  assert.equal(
    events.find((event) => event.type === "TextDelta")?.text,
    "Final queued token",
  );
  const terminal = events.at(-1);
  assert.ok(terminal?.type === "RunCompleted");
  assert.equal(terminal.finishReason, "length");
});

test("abort during native slot admission never dispatches and disposal waits for actual context and file release", async () => {
  const admission = deferred<void>();
  const enteredAdmission = deferred<void>();
  const contextCleanup = deferred<void>();
  const enteredCleanup = deferred<void>();
  let heldLeases = 0;
  let completions = 0;
  let disposed = false;
  const context = {
    parallel: {
      async enable() {
        enteredAdmission.resolve();
        await admission.promise;
      },
      async completion() {
        completions++;
        throw new Error("canceled admission must not dispatch");
      },
    },
    async release() {
      enteredCleanup.resolve();
      await contextCleanup.promise;
    },
  } as unknown as LlamaContext;
  const port = createGgufInferencePort({
    files: {
      async acquire() {
        heldLeases++;
        return {
          uri: "file:///private/fixture.gguf",
          async release() {
            heldLeases--;
          },
        };
      },
    },
    runtime: {
      async initLlama() {
        return context;
      },
    },
  });
  const controller = new AbortController();
  const iterator = port
    .startRun(request(), controller.signal)
    [Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "RunStarted");
  const next = iterator.next();
  await enteredAdmission.promise;
  controller.abort();
  const draining = port.dispose().then(() => {
    disposed = true;
  });
  try {
    await Promise.resolve();
    assert.equal(disposed, false);
    assert.equal(heldLeases, 1);
    admission.resolve();
    assert.equal((await next).value?.type, "RunCanceled");
    const finished = iterator.next();
    await enteredCleanup.promise;
    assert.equal(completions, 0);
    assert.equal(
      heldLeases,
      1,
      "file must remain leased until native cleanup ends",
    );
    assert.equal(disposed, false);
    contextCleanup.resolve();
    assert.equal((await finished).done, true);
    await draining;
    assert.equal(disposed, true);
    assert.equal(heldLeases, 0);
  } finally {
    admission.resolve();
    contextCleanup.resolve();
    await iterator.return?.();
    await draining;
  }
});

test("oversized canonical context/output options respect native limits and explicit thinking false overrides reasoning", async () => {
  const { calls, port } = setup();
  for await (const _event of port.startRun(
    {
      ...request({
        contextWindow: 100_000,
        max_output_tokens: 100_000,
        enable_thinking: false,
      }),
      reasoning: true,
    },
    new AbortController().signal,
  )) {
    // Consume the injected runtime stream through actual cleanup.
  }
  const load = calls.find((call) => "load" in call)?.["load"] as Record<
    string,
    unknown
  >;
  const completion = calls.find((call) => "completion" in call)?.[
    "completion"
  ] as Record<string, unknown>;
  assert.equal(load["n_ctx"], 8192);
  assert.equal(completion["n_predict"], 8192);
  assert.equal(completion["enable_thinking"], false);
});

test("metadata staging avoids whole-file reads and keeps its blob lease through file cleanup", async () => {
  const { createBlobManagedModelFiles } = await import("../src/index.js");
  const blobId = "00000000-0000-4000-8000-000000000001";
  // This is metadata for a large-file adapter fixture, not actual loaded weights.
  const metadata = {
    id: blobId,
    sha256: "a".repeat(64),
    mimeType: "application/x-gguf",
    byteLength: 2_740_937_888,
    managedPath: `locallab/blobs/${blobId}`,
    createdAt: "2026-09-27T20:00:00.000Z",
  };
  const cleanup = deferred<void>();
  const cleanupEntered = deferred<void>();
  let leases = 0;
  let reads = 0;
  const controller = new AbortController();
  const files = createBlobManagedModelFiles(
    {
      async read() {
        reads++;
        throw new Error("large weights must not enter the JS heap");
      },
      async list() {
        return [metadata];
      },
      async acquireLease(id, purpose) {
        assert.equal(id, blobId);
        assert.equal(purpose, "gguf-inference");
        leases++;
        return { token: "fixture-lease", blobId, purpose };
      },
      async releaseLease(token) {
        assert.equal(token, "fixture-lease");
        leases--;
        return false;
      },
    },
    {
      async stageMetadata(value, token, signal) {
        assert.equal(value, metadata);
        assert.equal(token, "fixture-lease");
        assert.equal(signal, controller.signal);
        assert.equal(leases, 1);
        return "file:///private/fixture.gguf";
      },
      async release() {
        cleanupEntered.resolve();
        await cleanup.promise;
      },
    },
  );
  const lease = await files.acquire({ blobId }, controller.signal);
  const releasing = lease.release();
  try {
    await cleanupEntered.promise;
    assert.equal(reads, 0);
    assert.equal(leases, 1);
    cleanup.resolve();
    await releasing;
    assert.equal(leases, 0);
    assert.equal(reads, 0);
  } finally {
    cleanup.resolve();
    await releasing;
  }
});

test("abort while metadata staging is pending releases returned file and blob lease without reading weights", async () => {
  const { createBlobManagedModelFiles } = await import("../src/index.js");
  const blobId = "00000000-0000-4000-8000-000000000001";
  const staged = deferred<string>();
  const entered = deferred<void>();
  const released: string[] = [];
  let leases = 0;
  const controller = new AbortController();
  const files = createBlobManagedModelFiles(
    {
      async read() {
        throw new Error("whole-file read is forbidden in this fixture");
      },
      async list() {
        return [
          {
            id: blobId,
            sha256: "b".repeat(64),
            mimeType: "application/x-gguf",
            byteLength: 8,
            managedPath: `locallab/blobs/${blobId}`,
            createdAt: "now",
          },
        ];
      },
      async acquireLease() {
        leases++;
        return { token: "fixture-lease", blobId, purpose: "gguf" };
      },
      async releaseLease() {
        leases--;
        return false;
      },
    },
    {
      async stageMetadata() {
        entered.resolve();
        return staged.promise;
      },
      async release(uri) {
        released.push(uri);
      },
    },
  );
  const acquisition = files.acquire({ blobId }, controller.signal);
  await entered.promise;
  const reason = new Error("fixture cancellation");
  controller.abort(reason);
  assert.equal(leases, 1);
  staged.resolve("file:///private/fixture.gguf");
  await assert.rejects(acquisition, (error) => error === reason);
  assert.deepEqual(released, ["file:///private/fixture.gguf"]);
  assert.equal(leases, 0);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("cumulative llama.rn snapshots stream as deltas with reasoning split out", async () => {
  let completion: Record<string, unknown> | undefined;
  const context = {
    parallel: {
      async enable() {},
      async completion(
        parameters: Record<string, unknown>,
        callback: (
          id: number,
          token: {
            token: string;
            content?: string;
            reasoning_content?: string;
          },
        ) => void,
      ) {
        completion = parameters;
        callback(1, { token: "<think>" });
        callback(1, { token: "ok", reasoning_content: "ok" });
        callback(1, { token: "</think>", reasoning_content: "ok" });
        callback(1, {
          token: "Hello",
          reasoning_content: "ok",
          content: "Hello",
        });
        callback(1, { token: "!", reasoning_content: "ok", content: "Hello!" });
        return {
          requestId: 1,
          promise: Promise.resolve({
            text: "<think>ok</think>Hello! How",
            reasoning_content: "ok",
            content: "Hello! How",
            timings: { prompt_n: 3, predicted_n: 6 },
          }),
          async stop() {},
        };
      },
    },
    async release() {},
  } as unknown as LlamaContext;
  const { port } = setup({
    runtime: {
      async initLlama() {
        return context;
      },
    },
  });
  const events = [];
  for await (const event of port.startRun(
    request(),
    new AbortController().signal,
  ))
    events.push(event);
  assert.equal(completion?.["reasoning_format"], "auto");
  const deltas = events.flatMap((event) =>
    event.type === "TextDelta" || event.type === "ReasoningDelta"
      ? [[event.type, event.text]]
      : [],
  );
  assert.deepEqual(deltas, [
    ["ReasoningDelta", "ok"],
    ["TextDelta", "Hello"],
    ["TextDelta", "!"],
    ["TextDelta", " How"],
  ]);
  assert.deepEqual(
    events.slice(-2).map((event) => event.type),
    ["Usage", "RunCompleted"],
  );
});
