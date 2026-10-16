import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RunRequest, RunEvent } from "@locallab/contracts/run-events";
import { RunEventBatchSchema } from "@locallab/contracts/run-events";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import type { FetchLike } from "@locallab/network-http";
import {
  createOpenAIAdvancedProvider,
  decodeOpenAIAdvancedFrame,
  encodeOpenAIAdvancedRequest,
} from "../src/index.js";

const id = "018f0b1a-7b3c-7abc-8def-123456789abc";
const ref = "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as SecretRef;
const request: RunRequest = {
  runId: id,
  conversationId: id,
  messageId: id,
  providerConnectionId: id,
  modelId: "gpt-vision-test",
  context: [
    {
      kind: "user",
      value: {
        parts: [
          { type: "text", text: "What is this?" },
          { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
        ],
      },
    },
    {
      kind: "tool-definitions",
      value: [
        {
          name: "lookup",
          description: "Search",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    },
  ],
  parameters: { reasoning_effort: "high", max_output_tokens: 99 },
  permittedTools: ["lookup", "not-defined"],
  attachmentRefs: [],
  reasoning: true,
  json: false,
};
const connection = {
  endpointUrl: "https://api.example.test/v1/responses",
  modelId: request.modelId,
  apiKeyRef: ref,
};
const fixture = await readFile(
  new URL("../fixtures/advanced.sse", import.meta.url),
  "utf8",
);
const secrets: SecretStore = {
  async put() {
    throw new Error("unused");
  },
  async remove() {},
  async resolveHeaders(host, refs) {
    expect(host).toBe("https://api.example.test");
    expect(refs).toEqual([ref]);
    return { authorization: "fixture-token" };
  },
};
async function collect(source: AsyncIterable<RunEvent>) {
  const out: RunEvent[] = [];
  for await (const value of source) out.push(value);
  return out;
}

describe("OpenAI advanced provider", () => {
  it.each([
    [401, "unauthorized"],
    [404, "missing-model"],
  ])(
    "preserves the complete HTTP %i body in chat and model inventory errors",
    async (status, code) => {
      const body =
        "Server diagnosis: " + "x".repeat(20_000) + "\nfinal-response-detail";
      const config = connection;
      const provider = createOpenAIAdvancedProvider({
        secrets: secrets,
        fetch: async () =>
          new Response(body, {
            status,
            statusText: "Fixture failure",
            headers: { "content-type": "text/plain" },
          }),
        resolveConnection: async () => config,
      });
      const events = await collect(
        provider.startRun(request, new AbortController().signal),
      );
      const failure = events.at(-1);
      expect(failure?.type).toBe("RunFailed");
      if (failure?.type !== "RunFailed")
        throw new Error("Expected a failed run");
      expect(failure.error.code).toBe(code);
      expect(failure.error.message).toContain(body);
      expect(failure.error.message).toContain(`HTTP ${status} Fixture failure`);
      expect(failure.error.message).toContain("text/plain");
      const inventory = await provider.listModels(config);
      expect(inventory.ok).toBe(false);
      if (inventory.ok) throw new Error("Expected failed inventory");
      expect(inventory.error.code).toBe(code);
      expect(inventory.error.message).toContain(body);
    },
  );

  it("preserves structured stream errors without a message, including envelope and cause fields", async () => {
    const payload = {
      error: { code: "invalid_model", policy: "not enabled" },
      request_id: "fixture-request",
      cause: { policy: "server-side explanation" },
      details: "x".repeat(9_000) + "stream-tail",
    };
    const config = connection;
    const provider = createOpenAIAdvancedProvider({
      secrets: secrets,
      fetch: async () =>
        new Response(`event: error\ndata: ${JSON.stringify(payload)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      resolveConnection: async () => config,
    });
    const events = await collect(
      provider.startRun(request, new AbortController().signal),
    );
    const failure = events.at(-1);
    expect(failure?.type).toBe("RunFailed");
    if (failure?.type !== "RunFailed") throw new Error("Expected a failed run");
    expect(failure.error.code).toBe("missing-model");
    expect(failure.error.message).toContain(JSON.stringify(payload, null, 2));
  });

  it("includes the complete malformed stream event and invalid model inventory response", async () => {
    const raw = "<html>" + "x".repeat(9_000) + "invalid-body-tail</html>";
    const config = connection;
    const provider = createOpenAIAdvancedProvider({
      secrets: secrets,
      fetch: async () =>
        new Response(`data: ${raw}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      resolveConnection: async () => config,
    });
    const events = await collect(
      provider.startRun(request, new AbortController().signal),
    );
    const failure = events.at(-1);
    expect(failure?.type).toBe("RunFailed");
    if (failure?.type !== "RunFailed") throw new Error("Expected a failed run");
    expect(failure.error.code).toBe("malformed");
    expect(failure.error.message).toContain(raw);
    const inventoryProvider = createOpenAIAdvancedProvider({
      secrets: secrets,
      fetch: async () =>
        new Response(raw, { headers: { "content-type": "text/html" } }),
      resolveConnection: async () => config,
    });
    const inventory = await inventoryProvider.listModels(config);
    expect(inventory.ok).toBe(false);
    if (inventory.ok) throw new Error("Expected failed inventory");
    expect(inventory.error.code).toBe("malformed");
    expect(inventory.error.message).toContain(raw);
  });

  it.each([
    "fixture-token",
    "Bearer fixture-token",
    "Bearer Bearer fixture-token",
  ])(
    "normalizes raw and previously prefixed keys without duplicating Bearer (%s)",
    async (stored) => {
      let calls = 0;
      const port = createOpenAIAdvancedProvider({
        secrets: {
          ...secrets,
          resolveHeaders: async () => ({ authorization: stored }),
        },
        fetch: async (_url, init) => {
          calls++;
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer fixture-token",
          );
          return Response.json({ data: [{ id: request.modelId }] });
        },
        resolveConnection: async () => connection,
      });
      expect(await port.listModels(connection)).toEqual({
        ok: true,
        value: [request.modelId],
      });
      expect(calls).toBe(1);
    },
  );
  it("encodes reasoning, tool schemas, and inline vision in vendor request shape", () => {
    expect(encodeOpenAIAdvancedRequest(request)).toMatchObject({
      model: request.modelId,
      reasoning: { effort: "high", summary: "auto" },
      tools: [{ type: "function", name: "lookup" }],
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "What is this?" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,aGVsbG8=",
            },
          ],
        },
      ],
    });
  });
  it("normalizes captured reasoning, text, tool, source and usage stream events", async () => {
    const bytes = new TextEncoder().encode(fixture);
    const fetch: FetchLike = async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fixture-token",
      );
      return new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i += 37)
              c.enqueue(bytes.slice(i, i + 37));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const port = createOpenAIAdvancedProvider({
      secrets,
      fetch,
      resolveConnection: async () => connection,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const events = await collect(
      port.startRun(request, new AbortController().signal),
    );
    expect(events.map((e) => e.type)).toEqual([
      "RunStarted",
      "ReasoningDelta",
      "TextDelta",
      "ToolCall",
      "Source",
      "Usage",
      "RunCompleted",
    ]);
    expect(RunEventBatchSchema.safeParse(events).success).toBe(true);
    expect(events[3]).toMatchObject({
      type: "ToolCall",
      name: "lookup",
      input: { q: "cats" },
    });
    expect(events[4]).toMatchObject({
      type: "Source",
      url: "https://example.test/cats",
    });
    expect(JSON.stringify(events)).not.toContain("fixture-token");
  });
  it("rejects malformed tool JSON in the request event codec without fabricating a tool call", () => {
    expect(() =>
      decodeOpenAIAdvancedFrame({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "x",
          name: "lookup",
          arguments: "{",
        },
      }),
    ).toThrow(/malformed function call/);
  });
  it("replays canonical tool-call exchanges into Responses input items (R011)", () => {
    const body = encodeOpenAIAdvancedRequest({
      ...request,
      context: [
        { kind: "user", value: { content: "read a.txt" } },
        {
          kind: "assistant",
          value: {
            role: "assistant",
            content: "reading",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: { q: "a.txt" } },
              },
              {
                id: "call-2",
                type: "function",
                function: { name: "lookup", arguments: { q: "b.txt" } },
              },
            ],
          },
        },
        {
          kind: "tool",
          value: {
            role: "tool",
            tool_call_id: "call-1",
            name: "lookup",
            content: '{"found":true}',
          },
        },
        {
          kind: "tool",
          value: {
            role: "tool",
            tool_call_id: "call-2",
            name: "lookup",
            content: "boom: not found",
          },
        },
      ],
    }) as { input: Record<string, unknown>[] };
    expect(body.input).toEqual([
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "reading" },
      {
        type: "function_call",
        call_id: "call-1",
        name: "lookup",
        arguments: '{"q":"a.txt"}',
      },
      {
        type: "function_call",
        call_id: "call-2",
        name: "lookup",
        arguments: '{"q":"b.txt"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: '{"found":true}',
      },
      {
        type: "function_call_output",
        call_id: "call-2",
        output: "boom: not found",
      },
    ]);
    expect(() =>
      encodeOpenAIAdvancedRequest({
        ...request,
        context: [{ kind: "tool", value: { name: "lookup", content: "x" } }],
      }),
    ).toThrow(/tool_call_id/);
  });
});

