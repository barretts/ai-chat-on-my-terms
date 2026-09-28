import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  ModelRuntimeCoordinator,
  ModelRuntimeError,
  type ManagedRuntimeModel,
  type ModelRuntimeAdapter,
} from "../src/index.js";

const model: ManagedRuntimeModel = {
  id: "blob:018f0000-0000-7000-8000-000000000301",
  format: "gguf",
  runtime: "gguf-ios",
  managedRef: "blob:018f0000-0000-7000-8000-000000000301",
  sha256: "a".repeat(64),
};

const request: RunRequest = {
  runId: "018f0000-0000-7000-8000-000000000302",
  conversationId: "018f0000-0000-7000-8000-000000000303",
  messageId: "018f0000-0000-7000-8000-000000000304",
  providerConnectionId: "018f0000-0000-7000-8000-000000000305",
  modelId: model.id,
  context: [{ kind: "text", value: "hello" }],
  parameters: {},
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};

function event(type: RunEvent["type"], sequence: number): RunEvent {
  const base = {
    runId: request.runId,
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  if (type === "RunStarted" || type === "RunCompleted")
    return { ...base, type };
  if (type === "TextDelta") return { ...base, type, text: "ok" };
  throw new Error("unexpected test event");
}

function adapter(
  input: {
    available?: "yes" | "no" | "unknown";
    disposed?: () => void;
    provider?: ProviderPort;
  } = {},
): ModelRuntimeAdapter {
  return {
    id: "gguf-ios",
    async availability(host) {
      assert.equal(host, "ios-device");
      return { state: input.available ?? "yes" };
    },
    async load() {
      return {
        provider:
          input.provider ??
          ({
            async listModels() {
              return { ok: true, value: [] };
            },
            async getCapabilities() {
              return { ok: true, value: {} };
            },
            async *startRun() {
              yield event("RunStarted", 0);
              yield event("TextDelta", 1);
              yield event("RunCompleted", 2);
            },
          } satisfies ProviderPort),
        async dispose() {
          input.disposed?.();
        },
      };
    },
  };
}

describe("model runtime coordinator", () => {
  it("uses only the declared runtime and blocks unknown capability", async () => {
    const coordinator = new ModelRuntimeCoordinator(
      [adapter({ available: "unknown" })],
      "ios-device",
    );
    const resolution = await coordinator.resolve(model);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.match(resolution.reason, /not verified/);
    await assert.rejects(
      coordinator.load(model),
      (error: unknown) =>
        error instanceof ModelRuntimeError && error.code === "unavailable",
    );

    const unsupported = await coordinator.resolve({
      ...model,
      runtime: "mlx-ios",
      format: "mlx",
      managedRef: "mlx:model-1",
    });
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) assert.match(unsupported.reason, /No mlx-ios adapter/);
  });

  it("validates format and managed identity before runtime initialization", async () => {
    let loads = 0;
    const base = adapter();
    const counting: ModelRuntimeAdapter = {
      ...base,
      async load(value) {
        loads += 1;
        return base.load(value);
      },
    };
    const coordinator = new ModelRuntimeCoordinator([counting], "ios-device");
    await assert.rejects(
      coordinator.load({ ...model, format: "mlx" }),
      (error: unknown) =>
        error instanceof ModelRuntimeError &&
        error.code === "invalid-managed-model",
    );
    await assert.rejects(
      coordinator.load({ ...model, managedRef: "file:///tmp/model.gguf" }),
    );
    assert.equal(loads, 0);
  });

  it("holds a model lease through a run and disposes only after it drains", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let disposed = 0;
    const provider: ProviderPort = {
      async listModels() {
        return { ok: true, value: [] };
      },
      async getCapabilities() {
        return { ok: true, value: {} };
      },
      async *startRun() {
        yield event("RunStarted", 0);
        await gate;
        yield event("TextDelta", 1);
        yield event("RunCompleted", 2);
      },
    };
    const coordinator = new ModelRuntimeCoordinator(
      [adapter({ provider, disposed: () => disposed++ })],
      "ios-device",
    );
    await coordinator.load(model);
    const iterator = coordinator
      .startRun(request, new AbortController().signal)
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "RunStarted");
    await assert.rejects(
      coordinator.unload(),
      (error: unknown) =>
        error instanceof ModelRuntimeError && error.code === "model-in-use",
    );
    release();
    assert.equal((await iterator.next()).value?.type, "TextDelta");
    assert.equal((await iterator.next()).value?.type, "RunCompleted");
    assert.equal((await iterator.next()).done, true);
    await coordinator.unload();
    assert.equal(coordinator.loadedModelId, null);
    assert.equal(disposed, 1);
  });
});
