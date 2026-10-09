import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RunRequest, RunEvent } from "@locallab/contracts/run-events";
import { RunEventBatchSchema } from "@locallab/contracts/run-events";
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
  it.each([undefined, false, true])(
    "maps reasoning only for explicitly verified custom NInfer thinking control %j",
    async (ninferThinkingControl) => {
      const bodies: Record<string, unknown>[] = [];
      const provider = createCloudCompatibleProvider({
        ...(ninferThinkingControl === undefined
          ? {}
          : { ninferThinkingControl }),
        secrets,
        resolveConnection: async () => ({
          provider: "custom",
          endpointOrigin: "https://ninfer.example",
          apiKeyRef: ref,
        }),
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return response(
            'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
        },
      });
      for (const reasoning of [false, true]) {
        const events: RunEvent[] = [];
        for await (const event of provider.startRun(
          { ...request, reasoning },
          new AbortController().signal,
        ))
          events.push(event);
        expect(events.at(-1)?.type).toBe("RunCompleted");
      }
      expect(
        await provider.getCapabilities(
          {
            provider: "custom",
            endpointOrigin: "https://ninfer.example",
            apiKeyRef: ref,
          },
          request.modelId,
        ),
      ).toMatchObject({
        value: {
          reasoning: ninferThinkingControl === true ? "yes" : "unknown",
        },
      });
      expect(bodies.map((body) => body.enable_thinking)).toEqual(
        ninferThinkingControl === true ? [false, true] : [undefined, undefined],
      );
      if (ninferThinkingControl !== true)
        expect(
          bodies.every((body) => !Object.hasOwn(body, "enable_thinking")),
        ).toBe(true);
    },
  );

  it("gives reused server call IDs distinct UUIDs for child rounds sharing the timestamp", async () => {
    const provider = createCloudCompatibleProvider({
      secrets,
      resolveConnection: async () => ({
        provider: "openrouter",
        apiKeyRef: ref,
      }),
      fetch: async () =>
        response(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", function: { name: "search", arguments: '{"query":"fixture"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        ),
    });
    const ids: string[] = [];
    for (let round = 1; round <= 128; round++) {
      const events: RunEvent[] = [];
      for await (const event of provider.startRun(
        {
          ...request,
          runId: `018f0b1a-7b3c-7abc-8def-${round.toString(16).padStart(12, "0")}`,
        },
        new AbortController().signal,
      ))
        events.push(event);
      expect(RunEventBatchSchema.safeParse(events).success).toBe(true);
      const call = events.find((event) => event.type === "ToolCall");
      if (!call || call.type !== "ToolCall") throw new Error("Missing call");
      ids.push(call.invocationId);
    }
    expect(new Set(ids).size).toBe(128);
  });

  it("keeps function calls valid for durable runs and replays exact structured exchanges", async () => {
    const connection: CloudCompatibleConnection = {
      provider: "openrouter",
      apiKeyRef: ref,
    };
    const input = { path: "note.md", content: "# Note\n<xml>café 🌙</xml>" };
    const encoded = JSON.stringify(input);
    const provider = createCloudCompatibleProvider({
      toolsEnabled: true,
      secrets,
      resolveConnection: async () => connection,
      fetch: async () =>
        response(
          [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_native",
                        function: {
                          name: "search",
                          arguments: encoded.slice(0, 20),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: encoded.slice(20) } },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("") + "data: [DONE]\n\n",
        ),
    });
    const events: RunEvent[] = [];
    for await (const event of provider.startRun(
      request,
      new AbortController().signal,
    ))
      events.push(event);
    expect(RunEventBatchSchema.safeParse(events).success).toBe(true);
    const call = events.find((event) => event.type === "ToolCall");
    expect(call).toMatchObject({ input, name: "search" });
    expect(events.at(-1)).toMatchObject({
      type: "RunCompleted",
      finishReason: "tool_calls",
    });
    if (!call || call.type !== "ToolCall") throw new Error("Missing call");
    const replay = encodeChatCompletionRequest(
      {
        ...request,
        context: [
          ...request.context,
          {
            kind: "assistant",
            value: {
              content: "",
              tool_calls: [
                {
                  id: call.invocationId,
                  function: { name: call.name, arguments: call.input },
                },
              ],
            },
          },
          {
            kind: "tool",
            value: {
              tool_call_id: call.invocationId,
              content: '{"saved":true}',
            },
          },
        ],
      },
      connection,
    );
    expect((replay.messages as Record<string, unknown>[]).slice(-2)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: call.invocationId,
            type: "function",
            function: { name: "search", arguments: encoded },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: call.invocationId,
        content: '{"saved":true}',
      },
    ]);
    expect(
      await provider.getCapabilities(connection, request.modelId),
    ).toMatchObject({ value: { tools: "yes" } });
  });
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

describe("complete cloud-compatible failures", () => {
  const connection = { provider: "openrouter", apiKeyRef: ref } as const;
  const fullText =
    "upstream fixture explanation\n" +
    "detail ".repeat(1800) +
    "last-response-line";
  for (const status of [401, 403, 404, 429, 503]) {
    it(`retains the entire HTTP${status} body through normalized model and generation errors`, async () => {
      const body = JSON.stringify({
        detail: fullText,
        request_id: "cloud-fixture-request",
        metadata: { provider: "fixture-vendor" },
      });
      const provider = createCloudCompatibleProvider({
        secrets,
        resolveConnection: async () => connection,
        fetch: async () =>
          new Response(body, {
            status,
            statusText: "Fixture upstream reason",
            headers: { "content-type": "application/json" },
          }),
      });
      const models = await provider.listModels(connection);
      expect(models.ok).toBe(false);
      if (!models.ok) {
        expect(models.error.message).toContain(body);
        expect(models.error.message).toContain(
          `${status} Fixture upstream reason`,
        );
      }
      const events: RunEvent[] = [];
      for await (const event of provider.startRun(
        request,
        new AbortController().signal,
      ))
        events.push(event);
      const failure = events.at(-1);
      expect(failure?.type).toBe("RunFailed");
      if (failure?.type === "RunFailed")
        expect(failure.error.message).toContain(body);
    });
  }
  it("preserves complete text HTTP errors and malformed successful catalog responses", async () => {
    for (const status of [200, 502]) {
      const provider = createCloudCompatibleProvider({
        secrets,
        resolveConnection: async () => connection,
        fetch: async () =>
          new Response(fullText, {
            status,
            statusText: status === 200 ? "OK" : "Bad Gateway",
          }),
      });
      const models = await provider.listModels(connection);
      expect(models.ok).toBe(false);
      if (!models.ok) expect(models.error.message).toContain(fullText);
    }
  });
  it("preserves the full SSE error envelope without error.message and explicit error events", async () => {
    const envelope = JSON.stringify({
      error: { code: 429, metadata: { detail: fullText } },
      request_id: "stream-cloud-fixture-request",
    });
    for (const frame of [
      envelope,
      JSON.stringify({ detail: fullText, request_id: "event-error-fixture" }),
    ]) {
      const provider = createCloudCompatibleProvider({
        secrets,
        resolveConnection: async () => connection,
        fetch: async () => response(`event: error\ndata: ${frame}\n\n`),
      });
      const events: RunEvent[] = [];
      for await (const event of provider.startRun(
        request,
        new AbortController().signal,
      ))
        events.push(event);
      const failure = events.at(-1);
      expect(failure?.type).toBe("RunFailed");
      if (failure?.type === "RunFailed")
        expect(failure.error.message).toContain(frame);
    }
  });
  it("retains the actual secure-store cause when the saved credential is unavailable", async () => {
    const provider = createCloudCompatibleProvider({
      secrets: {
        ...secrets,
        resolveHeaders: async () => {
          throw {
            code: "secure-store",
            detail: "fixture OS denial",
            message: "Fixture keychain unavailable",
          };
        },
      },
      resolveConnection: async () => connection,
      fetch: async () => {
        throw new Error("Must not request");
      },
    });
    const models = await provider.listModels(connection);
    expect(models.ok).toBe(false);
    if (!models.ok) {
      expect(models.error.message).toContain("Fixture keychain unavailable");
    }
  });
  it("reports an unrecognized structured stream response in full instead of silently skipping it", async () => {
    const body = JSON.stringify({
      detail: fullText,
      request_id: "unrecognized-cloud-frame",
    });
    const provider = createCloudCompatibleProvider({
      secrets,
      resolveConnection: async () => connection,
      fetch: async () => response(`data: ${body}\n\ndata: [DONE]\n\n`),
    });
    const events: RunEvent[] = [];
    for await (const event of provider.startRun(
      request,
      new AbortController().signal,
    ))
      events.push(event);
    const failure = events.at(-1);
    expect(failure?.type).toBe("RunFailed");
    if (failure?.type === "RunFailed")
      expect(failure.error.message).toContain(body);
  });
});
