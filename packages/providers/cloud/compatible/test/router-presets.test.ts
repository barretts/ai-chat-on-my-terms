import { describe, expect, it } from "vitest";
import type { RunRequest } from "@locallab/contracts/run-events";
import type { FetchLike } from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import {
  createCloudCompatibleProvider,
  encodeChatCompletionRequest,
  type CloudCompatibleConnection,
} from "../src/index.js";

const ref = "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as SecretRef;
const request: RunRequest = {
  runId: "018f0b1a-7b3c-7abc-8def-123456789abc",
  conversationId: "018f0b1a-7b3c-7abc-8def-123456789abc",
  messageId: "018f0b1a-7b3c-7abc-8def-123456789abc",
  providerConnectionId: "018f0b1a-7b3c-7abc-8def-123456789abc",
  modelId: "openrouter/custom-model:free",
  context: [{ kind: "user", value: "hello" }],
  parameters: {},
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};

describe("OpenRouter and DeepSeek presets", () => {
  it("browses OpenRouter publicly while refusing every uncredentialed generation and other discovery", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const secrets: SecretStore = {
      async put() {
        throw new Error("unused");
      },
      async remove() {},
      async resolveHeaders() {
        throw new Error("Public catalog must not resolve a credential");
      },
    };
    const connection: CloudCompatibleConnection = { provider: "openrouter" };
    const provider = createCloudCompatibleProvider({
      secrets,
      resolveConnection: async () => connection,
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers)),
        });
        return Response.json({
          data: [{ id: "fixture-vendor/catalog-model" }],
        });
      },
    });
    expect(await provider.listModels(connection)).toEqual({
      ok: true,
      value: ["fixture-vendor/catalog-model"],
    });
    expect(calls).toEqual([
      { url: "https://openrouter.ai/api/v1/models", headers: {} },
    ]);
    const events = [];
    for await (const event of provider.startRun(
      request,
      new AbortController().signal,
    ))
      events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { code: "unauthorized" },
    });
    for (const other of [
      "deepseek",
      "zai",
      "vercel-gateway",
      "custom",
    ] as const) {
      expect(
        await provider.listModels({
          provider: other,
          endpointOrigin: "https://custom-fixture.test",
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "unauthorized" },
      });
    }
    expect(calls).toHaveLength(1);
  });

  it("keeps OpenRouter provider routing off unless the connection opts in", () => {
    const connection: CloudCompatibleConnection = {
      provider: "openrouter",
      apiKeyRef: ref,
    };
    expect(encodeChatCompletionRequest(request, connection)).toMatchObject({
      model: "openrouter/custom-model:free",
      provider: { allow_fallbacks: false },
    });
    expect(
      encodeChatCompletionRequest(request, {
        ...connection,
        allowCrossProviderRouting: true,
      }).provider,
    ).toEqual({ allow_fallbacks: true });
  });

  it("sends DeepSeek model discovery only to the pinned DeepSeek endpoint", async () => {
    const calls: string[] = [];
    const secrets: SecretStore = {
      async put() {
        throw new Error("unused");
      },
      async remove() {},
      async resolveHeaders(host, refs) {
        expect(host).toBe("https://api.deepseek.com");
        expect(refs).toEqual([ref]);
        return { authorization: "deepseek-fixture-token" };
      },
    };
    const fetch: FetchLike = async (url) => {
      calls.push(String(url));
      return Response.json({ data: [{ id: "deepseek-custom-model" }] });
    };
    const provider = createCloudCompatibleProvider({
      secrets,
      fetch,
      resolveConnection: async () => ({ provider: "deepseek", apiKeyRef: ref }),
    });
    expect(
      await provider.listModels({ provider: "deepseek", apiKeyRef: ref }),
    ).toEqual({ ok: true, value: ["deepseek-custom-model"] });
    expect(calls).toEqual(["https://api.deepseek.com/v1/models"]);
  });
});
