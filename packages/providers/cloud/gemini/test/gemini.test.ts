import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import type { FetchLike } from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { createGeminiProvider } from "../src/index.js";

const id = "018f0b1a-7b3c-7abc-8def-123456789abc";
const ref = "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as SecretRef;
const request: RunRequest = {
  runId: id,
  conversationId: id,
  messageId: id,
  providerConnectionId: id,
  modelId: "gemini-test",
  context: [
    { kind: "system", value: "Be brief" },
    { kind: "user", value: "Hi" },
  ],
  parameters: { temperature: 0.2 },
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};
const secrets: SecretStore = {
  async put() {
    throw new Error("unused");
  },
  async remove() {},
  async resolveHeaders(host, refs) {
    expect(host).toBe("https://generativelanguage.googleapis.com");
    expect(refs).toEqual([ref]);
    return { "x-goog-api-key": "test-key" };
  },
};
async function collect(it: AsyncIterable<RunEvent>) {
  const out: RunEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("Gemini native streaming adapter", () => {
  it.each([
    [401, "unauthorized"],
    [404, "missing-model"],
  ])(
    "preserves the complete HTTP %i body in chat and model inventory errors",
    async (status, code) => {
      const body =
        "Server diagnosis: " + "x".repeat(20_000) + "\nfinal-response-detail";
      const config = { modelId: request.modelId, apiKeyRef: ref };
      const provider = createGeminiProvider({
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
      error: { status: "RESOURCE_EXHAUSTED", retry_after: 37 },
      request_id: "fixture-request",
      cause: { policy: "server-side explanation" },
      details: "x".repeat(9_000) + "stream-tail",
    };
    const config = { modelId: request.modelId, apiKeyRef: ref };
    const provider = createGeminiProvider({
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
    const config = { modelId: request.modelId, apiKeyRef: ref };
    const provider = createGeminiProvider({
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
    const inventoryProvider = createGeminiProvider({
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

  it("reports only server inventory and never inserts an unverified configured model", async () => {
    const connection = { modelId: "nonexistent-model", apiKeyRef: ref };
    const provider = createGeminiProvider({
      secrets,
      fetch: async () =>
        Response.json({
          models: [
            { name: "models/actual-model" },
            { name: "models/actual-model" },
          ],
        }),
      resolveConnection: async () => connection,
    });
    expect(await provider.listModels(connection)).toEqual({
      ok: true,
      value: ["actual-model"],
    });
  });
  it("maps recorded text and usage, sends system instruction and a header credential", async () => {
    const fixture = await readFile(
      new URL("../fixtures/generate-content.sse", import.meta.url),
      "utf8",
    );
    let body: Record<string, unknown> = {},
      apiKey = "";
    const fetch: FetchLike = async (_url, init) => {
      apiKey = new Headers(init?.headers).get("x-goog-api-key") ?? "";
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const bytes = new TextEncoder().encode(fixture);
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes.slice(0, 47));
            c.enqueue(bytes.slice(47));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const provider = createGeminiProvider({
      secrets,
      fetch,
      resolveConnection: async () => ({
        modelId: "gemini-test",
        apiKeyRef: ref,
      }),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const events = await collect(
      provider.startRun(request, new AbortController().signal),
    );
    expect(apiKey).toBe("test-key");
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: "Be brief" }] },
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      generationConfig: { temperature: 0.2 },
    });
    expect(events.map((e) => e.type)).toEqual([
      "RunStarted",
      "TextDelta",
      "TextDelta",
      "Usage",
      "RunCompleted",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "RunCompleted",
      finishReason: "STOP",
    });
    expect(JSON.stringify(events)).not.toContain("test-key");
  });
  it("distinguishes provider quota rejection from network failure", async () => {
    const fetch: FetchLike = async () => new Response("", { status: 429 });
    const provider = createGeminiProvider({
      secrets,
      fetch,
      resolveConnection: async () => ({
        modelId: "gemini-test",
        apiKeyRef: ref,
      }),
    });
    const events = await collect(
      provider.startRun(request, new AbortController().signal),
    );
    expect(events.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { code: "quota", recoverable: true },
    });
    const offline = createGeminiProvider({
      secrets,
      fetch: async () => {
        throw new TypeError("socket unavailable");
      },
      resolveConnection: async () => ({
        modelId: "gemini-test",
        apiKeyRef: ref,
      }),
    });
    const offlineEvents = await collect(
      offline.startRun(request, new AbortController().signal),
    );
    expect(offlineEvents.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { code: "offline", recoverable: true },
    });
  });
  it("classifies safety blocks and refuses unresolved attachment references", async () => {
    const fetch: FetchLike = async () =>
      new Response('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    const provider = createGeminiProvider({
      secrets,
      fetch,
      resolveConnection: async () => ({
        modelId: "gemini-test",
        apiKeyRef: ref,
      }),
    });
    const blocked = await collect(
      provider.startRun(request, new AbortController().signal),
    );
    expect(blocked.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { code: "permission" },
    });
    const media = await collect(
      provider.startRun(
        { ...request, attachmentRefs: [id] },
        new AbortController().signal,
      ),
    );
    expect(media.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { code: "unsupported" },
    });
  });
  it("resolves image references through the host bridge and maps them to Gemini inline data", async () => {
    let body: Record<string, unknown> = {};
    const provider = createGeminiProvider({
      secrets,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      resolveConnection: async () => ({
        modelId: "gemini-test",
        apiKeyRef: ref,
      }),
      resolveMedia: async (attachmentId) => {
        expect(attachmentId).toBe(id);
        return { mimeType: "image/png", base64: "aGVsbG8=" };
      },
    });
    await collect(
      provider.startRun(
        { ...request, attachmentRefs: [id] },
        new AbortController().signal,
      ),
    );
    expect(body).toMatchObject({
      contents: [
        {
          role: "user",
          parts: [
            { text: "Hi" },
            { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
          ],
        },
      ],
    });
  });
});
