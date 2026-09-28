import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RunRequest, RunEvent } from "@locallab/contracts/run-events";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import type { FetchLike } from "@locallab/network-http";
import {
  CLOUD_COMPATIBLE_PRESETS,
  createCloudCompatibleProvider,
  encodeChatCompletionRequest,
  type CloudCompatibleConnection,
} from "../src/index.js";

const id = "018f0b1a-7b3c-7abc-8def-123456789abc";
const ref = "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as SecretRef;
const request: RunRequest = {
  runId: id,
  conversationId: id,
  messageId: id,
  providerConnectionId: id,
  modelId: "vendor/model-custom-id",
  context: [
    { kind: "user", value: "hello" },
    {
      kind: "tool-definitions",
      value: [
        { name: "search", parameters: { type: "object", properties: {} } },
      ],
    },
  ],
  parameters: {},
  permittedTools: ["search"],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};
const fixture = await readFile(
  new URL("../fixtures/chat.sse", import.meta.url),
  "utf8",
);
const secrets: SecretStore = {
  async put() {
    throw new Error("unused");
  },
  async remove() {},
  async resolveHeaders() {
    return { authorization: "fixture-token" };
  },
};
const response = (body: string, type = "text/event-stream") =>
  new Response(body, { headers: { "content-type": type } });

describe("named OpenAI-compatible cloud integrations", () => {
  it("pins all named presets to their vendor origin and retains arbitrary model IDs", () => {
    expect(CLOUD_COMPATIBLE_PRESETS).toEqual({
      openrouter: "https://openrouter.ai/api/v1",
      deepseek: "https://api.deepseek.com/v1",
      zai: "https://open.bigmodel.cn/api/paas/v4",
      "vercel-gateway": "https://ai-gateway.vercel.sh/v1",
    });
    for (const provider of [
      "openrouter",
      "deepseek",
      "zai",
      "vercel-gateway",
    ] as const) {
      const body = encodeChatCompletionRequest(request, {
        provider,
        apiKeyRef: ref,
      });
      expect(body.model).toBe("vendor/model-custom-id");
      expect(body.tools).toHaveLength(1);
      if (provider === "openrouter")
        expect(body.provider).toEqual({ allow_fallbacks: false });
      if (provider === "vercel-gateway")
        expect(body.providerOptions).toEqual({ gateway: { only: ["vendor"] } });
    }
  });
  it("uses custom HTTPS origins and explicitly enables router fallback only on opt-in", () => {
    const connection: CloudCompatibleConnection = {
      provider: "openrouter",
      apiKeyRef: ref,
      allowCrossProviderRouting: true,
    };
    expect(encodeChatCompletionRequest(request, connection).provider).toEqual({
      allow_fallbacks: true,
    });
    expect(
      encodeChatCompletionRequest(request, {
        provider: "custom",
        endpointOrigin: "https://gateway.example",
        apiKeyRef: ref,
      }).model,
    ).toBe("vendor/model-custom-id");
    expect(() =>
      encodeChatCompletionRequest(request, {
        provider: "custom",
        endpointOrigin: "http://gateway.example",
        apiKeyRef: ref,
      }),
    ).toThrow(/HTTPS/);
  });
  it("streams compatible text and usage with a vendor-scoped bearer secret", async () => {
    const connection = { provider: "zai", apiKeyRef: ref } as const;
    const fetcher: FetchLike = async (input, init) => {
      expect(String(input)).toBe(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fixture-token",
      );
      return response(fixture);
    };
    const provider = createCloudCompatibleProvider({
      secrets,
      fetch: fetcher,
      resolveConnection: async () => connection,
      now: () => "2026-01-01T00:00:00Z",
    });
    const events: RunEvent[] = [];
    for await (const event of provider.startRun(
      request,
      new AbortController().signal,
    ))
      events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "RunStarted",
      "TextDelta",
      "Usage",
      "RunCompleted",
    ]);
    expect(events[1]).toMatchObject({ text: "cloud reply" });
  });
  it("discovers models on the selected origin without changing vendor", async () => {
    const fetcher: FetchLike = async (input) => {
      expect(String(input)).toBe("https://api.deepseek.com/v1/models");
      return response(
        JSON.stringify({ data: [{ id: "deepseek-custom" }] }),
        "application/json",
      );
    };
    const provider = createCloudCompatibleProvider({
      secrets,
      fetch: fetcher,
      resolveConnection: async () => ({ provider: "deepseek", apiKeyRef: ref }),
    });
    expect(
      await provider.listModels({ provider: "deepseek", apiKeyRef: ref }),
    ).toEqual({ ok: true, value: ["deepseek-custom"] });
  });
});
