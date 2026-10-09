import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RunEventBatchSchema,
  type RunRequest,
} from "@locallab/contracts/run-events";
import { createHttpTransport, type FetchLike } from "@locallab/network-http";
import { OllamaModelService } from "@locallab/provider-ollama-models";
import { createOllamaChatProvider } from "../src/index.js";

const runId = "0193f2a0-1234-7abc-8def-123456789abc";
const request: RunRequest = {
  runId,
  conversationId: runId,
  messageId: runId,
  providerConnectionId: "0193f2a0-1234-7abc-8def-123456789abd",
  modelId: "qwen3:8b",
  context: [{ kind: "user", value: "hello" }],
  parameters: { temperature: 0.2 },
  permittedTools: ["weather"],
  attachmentRefs: [],
  reasoning: true,
  json: false,
};
const enc = new TextEncoder();
const fixtureConnection = {
  baseUrl: "http://127.0.0.1:11434",
  keepAlive: "5m",
};

function provider(
  fetch: FetchLike,
  connectionId = request.providerConnectionId,
  modelService?: OllamaModelService,
) {
  const transport = createHttpTransport({
    fetch,
    policy: {
      authorizedOrigins: ["http://127.0.0.1:11434"],
      cleartextLanOrigins: ["http://127.0.0.1:11434"],
    },
  });
  const resolved: string[] = [];
  return {
    resolved,
    port: createOllamaChatProvider({
      transport,
      ...(modelService ? { modelService } : {}),
      resolveConnection: async (id) => {
        resolved.push(id);
        return fixtureConnection;
      },
      now: () => "2026-09-26T12:00:00.000Z",
    }),
  };
}

async function collect(iterable: AsyncIterable<unknown>) {
  const result = [];
  for await (const value of iterable) result.push(value);
  return result as Array<Record<string, any>>;
}

test("preserves complete HTTP error bodies and their status while retaining Ollama classification", async () => {
  for (const status of [401, 400]) {
    const raw =
      "input length exceeds context window: " +
      "x".repeat(20_000) +
      "http-tail";
    const { port } = provider(
      async () =>
        new Response(raw, {
          status,
          statusText: "Fixture failure",
          headers: { "content-type": "text/plain" },
        }),
    );
    const events = await collect(
      port.startRun(request, new AbortController().signal),
    );
    assert.equal(events.at(-1)?.type, "RunFailed");
    const failure = events.at(-1)?.error;
    assert.equal(
      failure.code,
      status === 401 ? "unauthorized" : "context-full",
    );
    assert.ok(failure.message.includes(raw));
    assert.ok(failure.message.includes(`HTTP ${status} Fixture failure`));
    assert.ok(failure.message.includes("text/plain"));
    assert.equal(RunEventBatchSchema.safeParse(events).success, true);
  }
});

test("preserves structured NDJSON errors without a message and malformed raw events", async () => {
  const payload = JSON.stringify({
    error: { detail: "input length exceeds context window", expected: 8192 },
    request_id: "fixture-request",
    cause: { policy: "server explanation" },
    details: "x".repeat(9_000) + "stream-tail",
  });
  for (const raw of [
    payload,
    "null",
    "broken-json" + "x".repeat(9_000) + "malformed-tail",
  ]) {
    const { port } = provider(async () => new Response(raw + "\n"));
    const events = await collect(
      port.startRun(request, new AbortController().signal),
    );
    assert.equal(events.at(-1)?.type, "RunFailed");
    assert.equal(
      events.at(-1)?.error.code,
      raw === payload ? "context-full" : "malformed",
    );
    assert.ok(events.at(-1)?.error.message.includes(raw));
  }
});

test("parses fragmented native NDJSON, reasoning, tools and usage while preserving the explicit binding", async () => {
  let posted: Record<string, any> | undefined;
  const chunks = [
    JSON.stringify({ message: { thinking: "Let me ", content: "Hi " } }),
    JSON.stringify({
      message: {
        thinking: "think",
        content: "there",
        tool_calls: [{ function: { name: "weather", arguments: '{"city":' } }],
      },
    }),
    JSON.stringify({
      message: { tool_calls: [{ function: { arguments: '"Oslo"}' } }] },
    }),
    JSON.stringify({
      done: true,
      done_reason: "stop",
      prompt_eval_count: 12,
      eval_count: 7,
    }) + "\n",
  ].join("\n");
  const bytes = enc.encode(chunks);
  const fragments = [
    bytes.slice(0, 11),
    bytes.slice(11, 58),
    bytes.slice(58, 93),
    bytes.slice(93),
  ];
  const { port, resolved } = provider(async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/api/chat");
    posted = JSON.parse(String(init?.body));
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const fragment of fragments) controller.enqueue(fragment);
          controller.close();
        },
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  });
  const events = await collect(
    port.startRun(request, new AbortController().signal),
  );
  assert.equal(resolved[0], request.providerConnectionId);
  assert.equal(posted?.model, request.modelId);
  assert.equal(posted?.keep_alive, "5m");
  assert.equal(posted?.think, true);
  assert.equal(
    events
      .filter((event) => event.type === "ReasoningDelta")
      .map((event) => event.text)
      .join(""),
    "Let me think",
  );
  assert.equal(
    events
      .filter((event) => event.type === "TextDelta")
      .map((event) => event.text)
      .join(""),
    "Hi there",
  );
  assert.deepEqual(events.find((event) => event.type === "ToolCall")?.input, {
    city: "Oslo",
  });
  assert.deepEqual(
    events.find((event) => event.type === "Usage"),
    {
      type: "Usage",
      runId,
      sequence: 5,
      timestamp: "2026-09-26T12:00:00.000Z",
      inputTokens: 12,
      outputTokens: 7,
    },
  );
  assert.equal(events.at(-1)?.type, "RunCompleted");
  assert.equal(RunEventBatchSchema.safeParse(events).success, true);
});

test("regenerate resolves the original conversation binding instead of a mutable selected connection", async () => {
  const calls: string[] = [];
  const { port, resolved } = provider(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.model);
    return new Response(enc.encode('{"done":true,"done_reason":"stop"}\n'), {
      headers: { "content-type": "application/x-ndjson" },
    });
  });
  await collect(port.startRun(request, new AbortController().signal));
  const regenerate = {
    ...request,
    runId: "0193f2a0-1234-7abc-8def-223456789abc",
  };
  await collect(port.startRun(regenerate, new AbortController().signal));
  assert.deepEqual(resolved, [
    request.providerConnectionId,
    request.providerConnectionId,
  ]);
  assert.deepEqual(calls, ["qwen3:8b", "qwen3:8b"]);
});

test("normalizes Ollama context errors and disconnects before done", async () => {
  const contextPort = provider(
    async () =>
      new Response(
        enc.encode('{"error":"input length exceeds context window"}\n'),
      ),
  ).port;
  const contextEvents = await collect(
    contextPort.startRun(request, new AbortController().signal),
  );
  assert.equal(contextEvents.at(-1)?.error.code, "context-full");
  assert.equal(contextEvents.at(-1)?.error.recoverable, false);
  assert.match(
    contextEvents.at(-1)?.error.message,
    /Ollama context limit exceeded/,
  );
  assert.match(
    contextEvents.at(-1)?.error.message,
    /input length exceeds context window/,
  );
  const brokenPort = provider(
    async () => new Response(enc.encode('{"message":{"content":"partial"}}\n')),
  ).port;
  const brokenEvents = await collect(
    brokenPort.startRun(request, new AbortController().signal),
  );
  assert.equal(brokenEvents.at(-1)?.type, "RunFailed");
  assert.deepEqual(brokenEvents.at(-1)?.error, {
    code: "offline",
    message: "Ollama stream disconnected before completion",
    recoverable: true,
  });
});

test("classifies JSON context errors from Ollama's non-2xx responses", async () => {
  const { port } = provider(
    async () =>
      new Response(JSON.stringify({ error: "context length exceeded" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  const events = await collect(
    port.startRun(request, new AbortController().signal),
  );
  assert.equal(events.at(-1)?.type, "RunFailed");
  assert.equal(events.at(-1)?.error.code, "context-full");
});

test("caller cancellation aborts the request and emits one terminal cancellation", async () => {
  let aborted = false;
  const port = provider(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  ).port;
  const controller = new AbortController();
  const iteration = collect(port.startRun(request, controller.signal));
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const events = await iteration;
  assert.equal(aborted, true);
  assert.equal(events.at(-1)?.type, "RunCanceled");
  assert.equal(RunEventBatchSchema.safeParse(events).success, true);
});

test("shared model service prevents a pull while chat holds the stream lease", async () => {
  let started!: () => void;
  const chatStarted = new Promise<void>((resolve) => (started = resolve));
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/chat") {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }
    return new Response('{"status":"success"}\n', {
      headers: { "content-type": "application/x-ndjson" },
    });
  };
  const http = createHttpTransport({
    fetch,
    policy: {
      authorizedOrigins: ["http://127.0.0.1:11434"],
      cleartextLanOrigins: ["http://127.0.0.1:11434"],
    },
  });
  const modelService = new OllamaModelService({
    transport: http,
    resolveConnection: async () => fixtureConnection,
    createOperationId: () => "pull-after-chat",
  });
  const { port } = provider(fetch, request.providerConnectionId, modelService);
  const controller = new AbortController();
  const iterator = port
    .startRun(request, controller.signal)
    [Symbol.asyncIterator]();
  await iterator.next();
  const pending = iterator.next();
  await chatStarted;
  assert.throws(
    () => modelService.pull(request.providerConnectionId, request.modelId),
    /in use/,
  );
  controller.abort();
  await pending;
  await iterator.next();
  assert.equal(
    (
      await modelService.pull(request.providerConnectionId, request.modelId)
        .result
    ).status,
    "completed",
  );
});

test("filters definition context and sends only named explicitly permitted tool schemas", async () => {
  let posted: Record<string, any> | undefined;
  const { port } = provider(async (_input, init) => {
    posted = JSON.parse(String(init?.body));
    return new Response('{"done":true}\n', {
      headers: { "content-type": "application/x-ndjson" },
    });
  });
  const permitted = {
    type: "function",
    function: { name: "weather", parameters: { type: "object" } },
  };
  const result = await collect(
    port.startRun(
      {
        ...request,
        parameters: {
          tools: [
            permitted,
            null,
            {},
            { type: "function", function: { name: 7 } },
            { type: "function", function: { name: "disabled" } },
          ],
        },
        context: [
          request.context[0]!,
          {
            kind: "tool-definitions",
            value: { role: "system", content: "Untrusted definitions" },
          },
        ],
      },
      new AbortController().signal,
    ),
  );
  assert.deepEqual(posted?.tools, [permitted]);
  assert.deepEqual(posted?.messages, [{ role: "user", content: "hello" }]);
  assert.equal(result.at(-1)?.type, "RunCompleted");
  await collect(
    port.startRun(
      {
        ...request,
        permittedTools: [],
        parameters: { tools: [permitted, {}] },
      },
      new AbortController().signal,
    ),
  );
  assert.equal("tools" in (posted ?? {}), false);
});
