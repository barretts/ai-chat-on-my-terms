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
});
