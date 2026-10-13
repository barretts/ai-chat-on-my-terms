import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { HttpTransport, SseMessage } from "@locallab/network-http";
import { createLMStudioAdapter } from "../src/index.js";
import type { RunRequest } from "@locallab/contracts/run-events";

const uuid = "018f0b1a-7b3c-7abc-8def-0123456789ab";
const request = (
  context: RunRequest["context"],
  modelId = "model-a",
): RunRequest => ({
  runId: uuid,
  conversationId: uuid,
  messageId: uuid,
  providerConnectionId: uuid,
  modelId,
  context,
  parameters: {},
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
});

function fakeHttp(frames: string[]) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const http: HttpTransport = {
    async request() {
      throw new Error("unused");
    },
    async *streamSse(
      url: string | URL,
      init?: RequestInit,
    ): AsyncIterable<SseMessage> {
      calls.push({ url: String(url), init });
      for (const raw of frames) {
        const [eventLine, dataLine] = raw.split("\n");
        if (eventLine?.startsWith("event: "))
          yield {
            event: eventLine.slice(7),
            data: dataLine?.replace(/^data: /, "") ?? "",
          };
        else yield { data: (eventLine ?? "").replace(/^data: /, "") };
      }
    },
  };
  return { http, calls };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("LM Studio native and compatible adapters", () => {
  it("projects native progress, text, usage and response ID continuation with bearer token", async () => {
    const fixture = await readFile(
      resolve(import.meta.dirname, "../fixtures/native-chat.sse"),
      "utf8",
    );
    const frames = fixture.trim().split("\n\n");
    const fake = fakeHttp(frames);
    const adapter = createLMStudioAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "secret",
      http: fake.http,
    });
    const firstContext = [{ kind: "user", value: "Hi" }];
    const first = await collect(
      adapter.startRun(request(firstContext), new AbortController().signal),
    );
    expect(
      first.some(
        (event) => event.type === "LoadProgress" && event.fraction === 0.7,
      ),
    ).toBe(true);
    expect(
      first.some(
        (event) => event.type === "PromptProgress" && event.fraction === 0.5,
      ),
    ).toBe(true);
    expect(
      first.some(
        (event) => event.type === "TextDelta" && event.text === "Hello",
      ),
    ).toBe(true);
    expect(first.at(-1)?.type).toBe("RunCompleted");
    expect(fake.calls[0]?.url).toBe("http://127.0.0.1:1234/api/v1/chat");
    expect(new Headers(fake.calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer secret",
    );

    const second = await collect(
      adapter.startRun(
        request([
          ...firstContext,
          { kind: "assistant", value: "Hello" },
          { kind: "user", value: "Again" },
        ]),
        new AbortController().signal,
      ),
    );
    expect(second.at(-1)?.type).toBe("RunCompleted");
    const body = JSON.parse(String(fake.calls[1]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.previous_response_id).toBe("resp_fixture_1");
    expect(body.input).toBe("Again");
  });

  it("drops stale native continuation and explicitly replays full history statelessly", async () => {
    const native = [
      'event: message.delta\ndata: {"type":"message.delta","content":"Answer"}',
      'event: chat.end\ndata: {"type":"chat.end","result":{"output":[{"type":"message","content":"Answer"}],"response_id":"resp_1"}}',
    ];
    const compatible = [
      'data: {"choices":[{"delta":{"content":"Replayed"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ];
    const fake = fakeHttp([...native, ...compatible]);
    const adapter = createLMStudioAdapter({
      baseUrl: "http://localhost:1234",
      http: fake.http,
    });
    const signal = new AbortController().signal;
    const initial = [{ kind: "user", value: "First" }];
    await collect(adapter.startRun(request(initial), signal));
    const changed = [
      { kind: "user", value: "Edited" },
      { kind: "assistant", value: "Answer" },
      { kind: "user", value: "Next" },
    ];
    const events = await collect(adapter.startRun(request(changed), signal));
    expect(fake.calls[1]?.url).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    const body = JSON.parse(String(fake.calls[1]?.init?.body)) as {
      messages: Array<{ role: string; content: string }>;
      previous_response_id?: string;
    };
    expect(body.previous_response_id).toBeUndefined();
    expect(body.messages.map((message) => message.content)).toEqual([
      "Edited",
      "Answer",
      "Next",
    ]);
    expect(
      events.some(
        (event) => event.type === "TextDelta" && event.text === "Replayed",
      ),
    ).toBe(true);
  });

  it("invalidates continuation when model/provider changes", async () => {
    const native = [
      'event: chat.end\ndata: {"type":"chat.end","result":{"output":[{"type":"message","content":"A"}],"response_id":"resp_1"}}',
    ];
    const replay = ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'];
    const fake = fakeHttp([...native, ...replay, ...replay]);
    const adapter = createLMStudioAdapter({
      baseUrl: "http://localhost:1234",
      http: fake.http,
    });
    const signal = new AbortController().signal;
    await collect(
      adapter.startRun(request([{ kind: "user", value: "Hi" }]), signal),
    );
    const switched = {
      ...request(
        [
          { kind: "user", value: "Hi" },
          { kind: "assistant", value: "A" },
          { kind: "user", value: "Next" },
        ],
        "model-b",
      ),
      providerConnectionId: "018f0b1a-7b3c-7abc-8def-0123456789ac",
    };
    await collect(adapter.startRun(switched, signal));
    expect(fake.calls[1]?.url).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    const backToOriginal = request([
      { kind: "user", value: "Hi" },
      { kind: "assistant", value: "A" },
      { kind: "user", value: "Next" },
    ]);
    await collect(adapter.startRun(backToOriginal, signal));
    expect(fake.calls[2]?.url).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
  });

  it("routes real Fetch through the shared authorized-origin policy", async () => {
    const requests: string[] = [];
    const adapter = createLMStudioAdapter({
      baseUrl: "http://127.0.0.1:1234",
      policy: {
        authorizedOrigins: ["http://127.0.0.1:1234"],
        cleartextLanOrigins: ["http://127.0.0.1:1234"],
      },
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(
          'event: chat.end\ndata: {"type":"chat.end","result":{"output":[{"type":"message","content":"ok"}],"response_id":"resp_policy"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    await collect(
      adapter.startRun(
        request([{ kind: "user", value: "hello" }]),
        new AbortController().signal,
      ),
    );
    expect(requests).toEqual(["http://127.0.0.1:1234/api/v1/chat"]);
  });

  it("sends integrated references to native requests only, re-read each run", async () => {
    const chatEnd =
      'event: chat.end\ndata: {"type":"chat.end","result":{"output":[{"type":"message","content":"ok"}],"response_id":"resp_int"}}';
    const fake = fakeHttp([chatEnd]);
    const scripted: string[][] = [["mcp/playwright"], ["mcp/filesystem"]];
    let runs = 0;
    const adapter = createLMStudioAdapter({
      baseUrl: "http://127.0.0.1:1234",
      http: fake.http,
      integrations: () => scripted[runs++] ?? [],
    });
    const first = await collect(
      adapter.startRun(
        request([{ kind: "user", value: "Open the site" }]),
        new AbortController().signal,
      ),
    );
    expect(first.at(-1)?.type).toBe("RunCompleted");
    const firstBody = JSON.parse(String(fake.calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(firstBody.integrations).toEqual(["mcp/playwright"]);
    adapter.clearConversation(uuid);
    await collect(
      adapter.startRun(
        request([{ kind: "user", value: "Again" }]),
        new AbortController().signal,
      ),
    );
    const secondBody = JSON.parse(String(fake.calls[1]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(secondBody.integrations).toEqual(["mcp/filesystem"]);
    adapter.clearConversation(uuid);
    await collect(
      adapter.startRun(
        request([
          { kind: "system", value: "ctx" },
          { kind: "user", value: "stateless" },
        ]),
        new AbortController().signal,
      ),
    );
    expect(fake.calls[2]?.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    const thirdBody = JSON.parse(String(fake.calls[2]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect("integrations" in thirdBody).toBe(false);
    adapter.dispose();
  });

  it("keeps continuation alive with integrations and explains a missing one", async () => {
    const frames = [
      'event: chat.end\ndata: {"type":"chat.end","result":{"output":[{"type":"message","content":"done"}],"response_id":"resp_keep"}}',
    ];
    const fake = fakeHttp(frames);
    const adapter = createLMStudioAdapter({
      baseUrl: "http://127.0.0.1:1234",
      http: fake.http,
      integrations: () => ["mcp/playwright"],
    });
    const context = [{ kind: "user" as const, value: "First" }];
    await collect(
      adapter.startRun(request(context), new AbortController().signal),
    );
    const second = await collect(
      adapter.startRun(
        request([
          ...context,
          { kind: "assistant", value: "done" },
          { kind: "user", value: "Next" },
        ]),
        new AbortController().signal,
      ),
    );
    expect(second.at(-1)?.type).toBe("RunCompleted");
    const body = JSON.parse(String(fake.calls[1]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.previous_response_id).toBe("resp_keep");
    expect(body.integrations).toEqual(["mcp/playwright"]);
    const missing = fakeHttp([
      'event: error\ndata: {"type":"error","error":{"message":"Plugin mcp/playwright was not found"}}',
    ]);
    const failing = createLMStudioAdapter({
      baseUrl: "http://127.0.0.1:1234",
      http: missing.http,
      integrations: () => ["mcp/playwright"],
    });
    const events = await collect(
      failing.startRun(
        request([{ kind: "user", value: "Open it" }]),
        new AbortController().signal,
      ),
    );
    const failed = events.find((event) => event.type === "RunFailed");
    expect(failed?.type).toBe("RunFailed");
    if (failed?.type !== "RunFailed") return;
    expect(failed.error.message).toContain("does not have the integration");
    expect(failed.error.message).toContain("mcp/playwright");
    expect(failed.error.message).toContain("mcp.json");
  });
});
