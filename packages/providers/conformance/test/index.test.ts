import { describe, expect, it, vi } from "vitest";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import { conformProviderFixture } from "../src/index.js";
import {
  createProviderRegistry,
  ProviderRegistryError,
} from "../../../../apps/mobile/composition/providers/index.js";

const connectionId = "018f0000-0000-7000-8000-000000000001";
const runId = "018f0000-0000-7000-8000-000000000002";
const conversationId = "018f0000-0000-7000-8000-000000000003";
const messageId = "018f0000-0000-7000-8000-000000000004";
const timestamp = "2025-01-02T03:04:05.000Z";

const request: RunRequest = {
  runId,
  conversationId,
  messageId,
  providerConnectionId: connectionId,
  modelId: "chat-model:latest",
  context: [],
  parameters: {},
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};

function makeProvider(
  overrides: {
    models?: readonly string[];
    events?: readonly RunEvent[];
  } = {},
) {
  const startRun = vi.fn(async function* (
    _request: RunRequest,
    _signal: AbortSignal,
  ): AsyncGenerator<RunEvent> {
    const events: readonly RunEvent[] = overrides.events ?? [
      { type: "RunStarted", runId, sequence: 0, timestamp },
      { type: "TextDelta", runId, sequence: 1, timestamp, text: "fixture" },
      { type: "RunCompleted", runId, sequence: 2, timestamp },
    ];
    yield* events;
  });
  const provider: ProviderPort<object> = {
    async listModels() {
      return { ok: true, value: overrides.models ?? ["chat-model:latest"] };
    },
    async getCapabilities() {
      return { ok: true, value: { text: "yes", tools: "unknown" } };
    },
    startRun,
  };
  return { provider, startRun };
}

describe("ProviderPort fixture conformance", () => {
  it("passes selected identity to the adapter and validates events and selector fixtures", async () => {
    const { provider, startRun } = makeProvider();
    const result = await conformProviderFixture({
      provider,
      connection: {},
      request,
      selectedProviderConnectionId: connectionId,
      embeddingModelIds: ["embedding-model:v1"],
    });

    expect(startRun).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect(result.modelIds).toEqual(["chat-model:latest"]);
    expect(result.capabilities.text).toBe("yes");
    expect(result.events.at(-1)?.type).toBe("RunCompleted");
  });

  it("rejects embedding-only IDs exposed to chat selection", async () => {
    const { provider } = makeProvider({
      models: ["chat-model:latest", "embedding-model:v1"],
    });
    await expect(
      conformProviderFixture({
        provider,
        connection: {},
        request,
        selectedProviderConnectionId: connectionId,
        embeddingModelIds: ["embedding-model:v1"],
      }),
    ).rejects.toThrow("Embedding-only models exposed");
  });

  it("rejects a run request whose selected connection identity changed", async () => {
    const { provider, startRun } = makeProvider();
    await expect(
      conformProviderFixture({
        provider,
        connection: {},
        request,
        selectedProviderConnectionId: "018f0000-0000-7000-8000-000000000099",
        embeddingModelIds: [],
      }),
    ).rejects.toThrow("providerConnectionId differs");
    expect(startRun).not.toHaveBeenCalled();
  });

  it("rejects provider events that use another run identity", async () => {
    const { provider } = makeProvider({
      events: [
        {
          type: "RunStarted",
          runId: "018f0000-0000-7000-8000-000000000099",
          sequence: 0,
          timestamp,
        },
        {
          type: "RunCompleted",
          runId: "018f0000-0000-7000-8000-000000000099",
          sequence: 1,
          timestamp,
        },
      ],
    });
    await expect(
      conformProviderFixture({
        provider,
        connection: {},
        request,
        selectedProviderConnectionId: connectionId,
        embeddingModelIds: [],
      }),
    ).rejects.toThrow("event runId differs");
  });

  it("routes a saved binding without fallback and filters embedding models", async () => {
    const { provider } = makeProvider({
      models: ["chat-model:latest", "text-embedding-3-small"],
    });
    const other = makeProvider();
    const selectedList = vi.fn(async () => ({
      ok: true as const,
      value: ["chat-model:latest", "text-embedding-3-small"],
    }));
    const otherList = vi.fn(async () => ({
      ok: true as const,
      value: ["other-model"],
    }));
    const registry = createProviderRegistry({
      adapters: [
        {
          id: "selected-provider",
          port: provider,
          listModels: selectedList,
          getCapabilities: async () => ({
            ok: true,
            value: { text: "yes" as const },
          }),
        },
        {
          id: "other-provider",
          port: other.provider,
          listModels: otherList,
          getCapabilities: async () => ({
            ok: true,
            value: { text: "yes" as const },
          }),
        },
      ],
      resolveBinding: async (id) =>
        id === connectionId
          ? {
              providerConnectionId: id,
              providerId: "selected-provider",
              modelId: request.modelId,
            }
          : null,
    });

    await expect(registry.listModels(connectionId)).resolves.toEqual({
      ok: true,
      value: ["chat-model:latest"],
    });
    expect(selectedList).toHaveBeenCalledOnce();
    expect(otherList).not.toHaveBeenCalled();
    await expect(
      registry.listModels("018f0000-0000-7000-8000-000000000099"),
    ).rejects.toMatchObject({ code: "unknown-connection" });
    await expect(
      registry.getCapabilities(connectionId, "other-model"),
    ).rejects.toMatchObject({ code: "model-mismatch" });
  });

  it("rejects retry after the saved model binding changes", async () => {
    const { provider, startRun } = makeProvider();
    const registry = createProviderRegistry({
      adapters: [
        {
          id: "selected-provider",
          port: provider,
          listModels: async () => ({ ok: true, value: [request.modelId] }),
          getCapabilities: async () => ({ ok: true, value: { text: "yes" } }),
        },
      ],
      resolveBinding: async (id) => ({
        providerConnectionId: id,
        providerId: "selected-provider",
        modelId: "replacement-model",
      }),
    });
    await expect(async () => {
      for await (const _event of registry.startRun(
        request,
        new AbortController().signal,
      )) {
        void _event;
      }
    }).rejects.toBeInstanceOf(ProviderRegistryError);
    expect(startRun).not.toHaveBeenCalled();
  });
});
