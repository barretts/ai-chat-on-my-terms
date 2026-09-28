import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import type { FetchLike } from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { createMistralProvider } from "../src/index.js";

const id = "018f0b1a-7b3c-7abc-8def-123456789abc";
const ref = "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as SecretRef;
const request: RunRequest = {
  runId: id,
  conversationId: id,
  messageId: id,
  providerConnectionId: id,
  modelId: "mistral-test",
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
    expect(host).toBe("https://api.mistral.ai");
    expect(refs).toEqual([ref]);
    return { authorization: "Bearer test-key" };
  },
};
async function collect(it: AsyncIterable<RunEvent>) {
  const out: RunEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("Mistral chat-completions streaming adapter", () => {
  it("reports only server inventory and never inserts an unverified configured model", async () => {
    const connection = { modelId: "nonexistent-model", apiKeyRef: ref };
    const provider = createMistralProvider({
      secrets,
      fetch: async () =>
        Response.json({
          data: [{ id: "actual-model" }, { id: "actual-model" }],
        }),
      resolveConnection: async () => connection,
    });
    expect(await provider.listModels(connection)).toEqual({
      ok: true,
      value: ["actual-model"],
    });
  });
  it("maps recorded text and usage while keeping the key in an auth header", async () => {
    const fixture = await readFile(
      new URL("../fixtures/chat-completions.sse", import.meta.url),
      "utf8",
    );
    let body: Record<string, unknown> = {},
      authorization = "";
    const fetch: FetchLike = async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const bytes = new TextEncoder().encode(fixture);
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes.slice(0, 62));
            c.enqueue(bytes.slice(62));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const provider = createMistralProvider({
      secrets,
      fetch,
      resolveConnection: async () => ({
        modelId: "mistral-test",
        apiKeyRef: ref,
      }),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const events = await collect(
      provider.startRun(request, new AbortController().signal),
    );
    expect(authorization).toBe("Bearer test-key");
    expect(body).toMatchObject({
      model: "mistral-test",
      stream: true,
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "Hi" },
      ],
      temperature: 0.2,
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
      finishReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("test-key");
  });
  it("maps HTTP quota rejection separately from offline network errors", async () => {
    const fetch: FetchLike = async () => new Response("", { status: 429 });
    const provider = createMistralProvider({
      secrets,
      fetch,
      resolveConnection: async () => ({
        modelId: "mistral-test",
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
    const offline = createMistralProvider({
      secrets,
      fetch: async () => {
        throw new TypeError("socket unavailable");
      },
      resolveConnection: async () => ({
        modelId: "mistral-test",
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
  it("maps content-filter finish and does not claim media without a resolver", async () => {
    const fetch: FetchLike = async () =>
      new Response(
        'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    const provider = createMistralProvider({
      secrets,
      fetch,
      resolveConnection: async () => ({
        modelId: "mistral-test",
        apiKeyRef: ref,
      }),
    });
    const filtered = await collect(
      provider.startRun(request, new AbortController().signal),
    );
    expect(filtered.at(-1)).toMatchObject({
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
  it("resolves image references and maps them to Mistral data URLs", async () => {
    let body: Record<string, unknown> = {};
    const provider = createMistralProvider({
      secrets,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      resolveConnection: async () => ({
        modelId: "mistral-test",
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
      messages: [
        { role: "system", content: "Be brief" },
        {
          role: "user",
          content: [
            { type: "text", text: "Hi" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aGVsbG8=" },
            },
          ],
        },
      ],
    });
  });
});
