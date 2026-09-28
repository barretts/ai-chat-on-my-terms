import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  createExpoStreamingProviderPort,
  type FetchLike,
} from "../src/provider.js";

const request: RunRequest = {
  runId: "018f47c2-7c20-7abc-8def-123456789abc",
  conversationId: "018f47c2-7c20-7abc-8def-123456789abd",
  messageId: "018f47c2-7c20-7abc-8def-123456789abe",
  providerConnectionId: "018f47c2-7c20-7abc-8def-123456789abf",
  modelId: "fixture-model",
  context: [{ kind: "user", value: "Say hello" }],
  parameters: { temperature: 0 },
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};

test("fragmented SSE text is reconstructed and sent directly to BYOK host", async () => {
  const payload = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"café"}}]}\r\n\r\ndata: [DONE]\n\n',
  );
  const accentByte = payload.indexOf(0xc3);
  const chunks = [
    payload.slice(0, accentByte + 1),
    payload.slice(accentByte + 1, accentByte + 3),
    payload.slice(accentByte + 3),
  ];
  let fetchUrl = "";
  let authorization = "";
  const fetch: FetchLike = async (input, init) => {
    fetchUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  const port = createExpoStreamingProviderPort({
    fetch,
    resolveConnection: async () => ({
      baseUrl: "https://provider.example/v1",
      apiKey: "do-not-log-this-key",
    }),
    now: () => "2026-01-01T00:00:00.000Z",
  });

  const events: RunEvent[] = [];
  for await (const event of port.startRun(
    request,
    new AbortController().signal,
  ))
    events.push(event);

  assert.equal(fetchUrl, "https://provider.example/v1/chat/completions");
  assert.equal(authorization, "Bearer do-not-log-this-key");
  assert.deepEqual(
    events.map((event) => event.type),
    ["RunStarted", "TextDelta", "RunCompleted"],
  );
  const textDelta = events.find(
    (event): event is Extract<RunEvent, { type: "TextDelta" }> =>
      event.type === "TextDelta",
  );
  assert.equal(textDelta?.text, "café");
  assert.deepEqual(
    events.map((event) => event.sequence),
    [0, 1, 2],
  );
  assert.equal(JSON.stringify(events).includes("do-not-log-this-key"), false);
});

test("aborting an in-flight stream produces one terminal cancellation event", async () => {
  let requestSignal: AbortSignal | undefined;
  const fetch: FetchLike = async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
          ),
        );
        requestSignal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      },
    });
    return new Response(stream, { status: 200 });
  };
  const port = createExpoStreamingProviderPort({
    fetch,
    resolveConnection: async () => ({
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
    }),
  });
  const aborter = new AbortController();
  const iterator = port
    .startRun(request, aborter.signal)
    [Symbol.asyncIterator]();
  const seen: Array<RunEvent | undefined> = [];
  seen.push((await iterator.next()).value);
  seen.push((await iterator.next()).value);
  aborter.abort();
  seen.push((await iterator.next()).value);
  assert.deepEqual(
    seen.map((event) => event?.type),
    ["RunStarted", "TextDelta", "RunCanceled"],
  );
  assert.equal(
    seen.filter(
      (event) =>
        event &&
        ["RunCompleted", "RunCanceled", "RunFailed"].includes(event.type),
    ).length,
    1,
  );
});

test("breaking stream iteration closes the request transport", async () => {
  let canceled = false;
  const fetch: FetchLike = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"one"}}]}\n\n',
          ),
        );
      },
      cancel() {
        canceled = true;
      },
    });
    return new Response(stream, { status: 200 });
  };
  const port = createExpoStreamingProviderPort({
    fetch,
    resolveConnection: async () => ({ baseUrl: "https://provider.example/v1" }),
  });
  for await (const event of port.startRun(
    request,
    new AbortController().signal,
  )) {
    if (event.type === "TextDelta") break;
  }
  assert.equal(canceled, true);
});
