import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RunRequest, RunEvent } from "@locallab/contracts/run-events";
import { RunEventBatchSchema } from "@locallab/contracts/run-events";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import type { FetchLike } from "@locallab/network-http";
import {
  ANTHROPIC_VERSION,
  createAnthropicProvider,
  encodeAnthropicRequest,
} from "../src/index.js";

const id = "018f0b1a-7b3c-7abc-8def-123456789abc";
const ref = "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as SecretRef;
const request: RunRequest = {
  runId: id,
  conversationId: id,
  messageId: id,
  providerConnectionId: id,
  modelId: "claude-test",
  context: [
    { kind: "system", value: "Be concise." },
    {
      kind: "user",
      value: {
        parts: [
          { type: "text", text: "Describe this" },
          { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
        ],
      },
    },
    {
      kind: "tool-definitions",
      value: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
        },
      ],
    },
  ],
  parameters: { max_output_tokens: 300, reasoning_budget: 5000 },
  permittedTools: ["lookup"],
  attachmentRefs: [],
  reasoning: true,
  json: false,
};
const connection = {
  endpointUrl: "https://api.anthropic.example/v1/messages",
  modelId: request.modelId,
  apiKeyRef: ref,
};
const fixture = await readFile(
  new URL("../fixtures/messages-advanced.sse", import.meta.url),
  "utf8",
);
const secrets: SecretStore = {
  async put() {
    throw new Error("unused");
  },
  async remove() {},
  async resolveHeaders(host, refs) {
    expect(host).toBe("https://api.anthropic.example");
    expect(refs).toEqual([ref]);
    return { "x-api-key": "anthropic-fixture-token" };
  },
};
async function collect(source: AsyncIterable<RunEvent>) {
  const out: RunEvent[] = [];
  for await (const value of source) out.push(value);
  return out;
}

describe("Anthropic Messages provider", () => {
  it("recovers an older generic Authorization secret as a host-bound x-api-key", async () => {
    let calls = 0;
    const port = createAnthropicProvider({
      secrets: {
        ...secrets,
        async resolveHeaders(host, refs) {
          expect(host).toBe("https://api.anthropic.example");
          expect(refs).toEqual([ref]);
          return { authorization: "Bearer anthropic-fixture-token" };
        },
      },
      fetch: async (_url, init) => {
        calls++;
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe("anthropic-fixture-token");
        expect(headers.get("authorization")).toBeNull();
        return Response.json({ data: [{ id: request.modelId }] });
      },
      resolveConnection: async () => connection,
    });
    expect(await port.listModels(connection)).toEqual({
      ok: true,
      value: [request.modelId],
    });
    expect(calls).toBe(1);
  });
  it("encodes native system, vision, tools, and extended thinking fields", () => {
    expect(encodeAnthropicRequest(request)).toMatchObject({
      model: "claude-test",
      system: "Be concise.",
      max_tokens: 5001,
      thinking: { type: "enabled", budget_tokens: 5000 },
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aGVsbG8=",
              },
            },
          ],
        },
      ],
    });
  });
  it("streams captured thinking, text, complete tool JSON, and usage using selected host secret", async () => {
    const bytes = new TextEncoder().encode(fixture);
    const fetch: FetchLike = async (_input, init) => {
      const h = new Headers(init?.headers);
      expect(h.get("x-api-key")).toBe("anthropic-fixture-token");
      expect(h.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
      return new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i += 41)
              c.enqueue(bytes.slice(i, i + 41));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const port = createAnthropicProvider({
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
      "Usage",
      "ReasoningDelta",
      "TextDelta",
      "ToolCall",
      "Usage",
      "RunCompleted",
    ]);
    expect(RunEventBatchSchema.safeParse(events).success).toBe(true);
    expect(events[4]).toMatchObject({
      type: "ToolCall",
      name: "lookup",
      input: { q: "dogs" },
    });
    expect(JSON.stringify(events)).not.toContain("anthropic-fixture-token");
  });
  it("does not resolve any credential until the selected connection is chosen", async () => {
    let resolutions = 0;
    const port = createAnthropicProvider({
      secrets: {
        ...secrets,
        async resolveHeaders() {
          resolutions++;
          return { "x-api-key": "x" };
        },
      },
      fetch: async () => new Response("", { status: 500 }),
      resolveConnection: async () => {
        throw new Error("No selected provider");
      },
    });
    const events = await collect(
      port.startRun(request, new AbortController().signal),
    );
    expect(resolutions).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "RunFailed" });
  });
});
