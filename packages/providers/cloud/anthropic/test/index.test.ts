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
  it.each([
    [401, "unauthorized"],
    [404, "missing-model"],
  ])(
    "preserves the complete HTTP %i body in chat and model inventory errors",
    async (status, code) => {
      const body =
        "Server diagnosis: " + "x".repeat(20_000) + "\nfinal-response-detail";
      const config = connection;
      const provider = createAnthropicProvider({
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
      error: { type: "rate_limit_error", retry_after: 37 },
      request_id: "fixture-request",
      cause: { policy: "server-side explanation" },
      details: "x".repeat(9_000) + "stream-tail",
    };
    const config = connection;
    const provider = createAnthropicProvider({
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
    expect(failure.error.code).toBe("quota");
    expect(failure.error.message).toContain(JSON.stringify(payload, null, 2));
  });

  it("includes the complete malformed stream event and invalid model inventory response", async () => {
    const raw = "<html>" + "x".repeat(9_000) + "invalid-body-tail</html>";
    const config = connection;
    const provider = createAnthropicProvider({
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
    const inventoryProvider = createAnthropicProvider({
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
