import { describe, expect, it } from "vitest";
import {
  createHttpTransport,
  type HttpTransport,
  type SseMessage,
} from "@locallab/network-http";
import type { RunRequest } from "@locallab/contracts/run-events";
import {
  COMPATIBLE_LOCAL_PRESETS,
  createCompatibleLocalProvider,
  createCustomCompatiblePreset,
  createJanPreset,
  createOMLXPreset,
  createUnslothPreset,
  type CompatibleLocalConnection,
} from "../src/index.js";

const id = "0193f2a0-1234-7abc-8def-123456789abd";
const request: RunRequest = {
  runId: id,
  conversationId: id,
  messageId: id,
  providerConnectionId: id,
  modelId: "backend/model:Q4_K_M",
  context: [{ kind: "user", value: "hello" }],
  parameters: {},
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};

function mockTransport(body: unknown, frames: string[] = []) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport: HttpTransport = {
    async request(url, init) {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async *streamSse(url, init): AsyncIterable<SseMessage> {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      for (const data of frames) yield { data };
    },
  };
  return { transport, calls };
}

describe("compatible local presets", () => {
  const named = [
    ["JAN", createJanPreset],
    ["oMLX", createOMLXPreset],
    ["Unsloth", createUnslothPreset],
    ["custom", createCustomCompatiblePreset],
  ] as const;

  it.each(named)(
    "%s passes the shared model and chat compatibility fixtures",
    async (_label, makePreset) => {
      const connection = makePreset("http://127.0.0.1:1337");
      const fake = mockTransport(
        { data: [{ id: "backend/model:Q4_K_M", object: "model" }] },
        [
          JSON.stringify({
            choices: [{ delta: { content: "Hello" }, finish_reason: null }],
          }),
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 1 },
          }),
          "[DONE]",
        ],
      );
      const provider = createCompatibleLocalProvider({
        transport: fake.transport,
        resolveConnection: async () => connection,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      expect(await provider.listModels(connection)).toEqual({
        ok: true,
        value: ["backend/model:Q4_K_M"],
      });
      const events = [];
      for await (const event of provider.startRun(
        request,
        new AbortController().signal,
      ))
        events.push(event);
      expect(events.map((event) => event.type)).toContain("TextDelta");
      expect(events.map((event) => event.type)).toContain("Usage");
      expect(events.at(-1)?.type).toBe("RunCompleted");
      const chatCall = fake.calls.find((call) =>
        call.url.endsWith("/v1/chat/completions"),
      );
      expect(chatCall).toBeDefined();
      expect(JSON.parse(String(chatCall?.init?.body)).model).toBe(
        "backend/model:Q4_K_M",
      );
      expect(connection.provider).toBeDefined();
    },
  );

  it("keeps exact provider model IDs and excludes embedding-only models", async () => {
    const connection = createCustomCompatiblePreset(
      "https://models.example.test",
    );
    const fake = mockTransport({
      data: [
        {
          id: "namespace/Chat.Model:Q4_K_M",
          object: "model",
          owned_by: "local",
        },
        { id: "text-embedding-3-small", object: "model" },
        { id: "semantic", object: "model", type: "embedding" },
        {
          id: "dual-embed-chat",
          object: "model",
          capabilities: { embeddings: true, chat: true },
        },
      ],
    });
    const provider = createCompatibleLocalProvider({
      transport: fake.transport,
      resolveConnection: async () => connection,
    });
    expect(await provider.listCompatibleModels(connection)).toEqual([
      { id: "namespace/Chat.Model:Q4_K_M", ownedBy: "local" },
      { id: "dual-embed-chat" },
    ]);
    expect(await provider.listModels(connection)).toEqual({
      ok: true,
      value: ["namespace/Chat.Model:Q4_K_M", "dual-embed-chat"],
    });
  });

  it("keeps uncertain model capabilities unknown and does not claim management or MCP", async () => {
    const connection = createJanPreset("http://127.0.0.1:1337");
    const { transport } = mockTransport({ data: [] });
    const provider = createCompatibleLocalProvider({
      transport,
      resolveConnection: async () => connection,
    });
    const result = await provider.getCapabilities(connection, "model-id");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools).toBe("unknown");
      expect(result.value.vision).toBe("unknown");
      expect(result.value.modelManagement).toBe("unknown");
      expect(result.value.mcp).toBe("unknown");
    }
    expect(COMPATIBLE_LOCAL_PRESETS.omlx.label).toBe("oMLX");
  });

  it("requires a bare HTTP(S) origin and secret references resolve per request", async () => {
    expect(() =>
      createUnslothPreset("http://user:pass@localhost:3000"),
    ).toThrow();
    expect(() =>
      createUnslothPreset("https://models.example.test/v1"),
    ).toThrow();
    const connection: CompatibleLocalConnection = {
      provider: "custom",
      origin: "https://models.example.test",
      credentialRef: "sec_00000000-0000-4000-8000-000000000001" as never,
    };
    const fake = mockTransport({ data: [] });
    const provider = createCompatibleLocalProvider({
      transport: fake.transport,
      resolveConnection: async () => connection,
      secretStore: {
        async resolveHeaders(host, refs) {
          expect(host).toBe(connection.origin);
          expect(refs).toEqual([connection.credentialRef]);
          return { authorization: "Bearer resolved" };
        },
        async put() {
          throw new Error("unused");
        },
        async remove() {},
      },
    });
    expect(await provider.listModels(connection)).toEqual({
      ok: true,
      value: [],
    });
    expect(new Headers(fake.calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer resolved",
    );
  });
});

describe("complete compatible server failures", () => {
  const connection = createCustomCompatiblePreset(
    "https://models.example.test",
  );
  const fullText =
    "upstream fixture explanation\n" +
    "detail ".repeat(1800) +
    "last-response-line";
  for (const body of [
    fullText,
    JSON.stringify({
      error: { detail: fullText },
      request_id: "model-fixture-request",
    }),
  ]) {
    it(`retains a complete ${body.startsWith("{") ? "structured" : "text"} HTTP failure for model discovery and generation`, async () => {
      const transport = createHttpTransport({
        fetch: async () =>
          new Response(body, {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "content-type": "text/plain" },
          }),
        policy: { authorizedOrigins: [connection.origin] },
      });
      const provider = createCompatibleLocalProvider({
        transport,
        resolveConnection: async () => connection,
      });
      const models = await provider.listModels(connection);
      expect(models.ok).toBe(false);
      if (!models.ok) {
        expect(models.error.message).toContain(body);
        expect(models.error.message).toContain("503 Service Unavailable");
      }
      const events = [];
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
  it("retains non-ok model responses from a supplied transport and full malformed HTTP200 catalogs", async () => {
    for (const status of [200, 502]) {
      const transport: HttpTransport = {
        request: async () =>
          new Response(fullText, {
            status,
            statusText: status === 200 ? "OK" : "Bad Gateway",
          }),
        streamSse: async function* () {},
      };
      const provider = createCompatibleLocalProvider({
        transport,
        resolveConnection: async () => connection,
      });
      const models = await provider.listModels(connection);
      expect(models.ok).toBe(false);
      if (!models.ok) {
        expect(models.error.message).toContain(fullText);
        expect(models.error.message).toContain(String(status));
      }
    }
  });
  it("does not skip streamed error envelopes or malformed data and retains every response field", async () => {
    const errorFrame = JSON.stringify({
      error: { code: 429, details: fullText },
      request_id: "stream-fixture-request",
    });
    for (const body of [
      errorFrame,
      fullText,
      JSON.stringify({
        detail: fullText,
        request_id: "unrecognized-frame-fixture",
      }),
    ]) {
      const { transport } = mockTransport({}, [body]);
      const provider = createCompatibleLocalProvider({
        transport,
        resolveConnection: async () => connection,
      });
      const events = [];
      for await (const event of provider.startRun(
        request,
        new AbortController().signal,
      ))
        events.push(event);
      const failure = events.at(-1);
      expect(failure?.type).toBe("RunFailed");
      if (failure?.type === "RunFailed") {
        expect(failure.error.message).toContain(body);
        expect(failure.error.code).toBe(
          body === errorFrame ? "quota" : "malformed",
        );
      }
    }
  });
});
