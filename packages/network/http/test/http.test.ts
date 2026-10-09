import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHttpTransport,
  HttpTransportError,
  httpResponseError,
  errorDetails,
  type FetchLike,
} from "../src/index.js";

const ORIGIN = "https://provider.example";

test("HTTP and SSE failures retain status and the complete unstructured response beyond previous limits", async () => {
  const body = JSON.stringify({
    failure: {
      reason: "upstream model could not load",
      diagnostic: "detail ".repeat(2500),
      end: "LAST-RESPONSE-FIELD",
    },
  });
  for (const stream of [false, true]) {
    const client = transport(
      async () =>
        new Response(body, {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "content-type": "application/json" },
        }),
    );
    const pending = stream
      ? client.streamSse(`${ORIGIN}/chat`)[Symbol.asyncIterator]().next()
      : client.request(`${ORIGIN}/models`);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof HttpTransportError);
      assert.equal(error.response?.body, body);
      assert.equal(error.response?.complete, true);
      assert.ok(error.message.includes(body));
      assert.match(error.message, /HTTP 503 Service Unavailable/);
      assert.match(error.message, /LAST-RESPONSE-FIELD/);
      return true;
    });
  }
});

test("a stalled error body reports its received content and incomplete read explicitly", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first diagnostic line"));
      },
      pull() {
        return new Promise(() => undefined);
      },
    }),
    { status: 502 },
  );
  const error = await httpResponseError(response, { timeoutMs: 20 });
  assert.equal(error.status, 502);
  assert.equal(error.response?.complete, false);
  assert.equal(error.response?.body, "first diagnostic line");
  assert.match(error.message, /Response body \(incomplete\)/);
  assert.match(error.message, /Reading the error response timed out/);
});

test("native non-streaming responses retain their full text and remain cancellable", async () => {
  const body = "native response detail ".repeat(800) + "NATIVE-LAST-FIELD";
  const legacyResponse = {
    status: 403,
    statusText: "Forbidden",
    headers: new Headers({ "content-type": "text/plain" }),
    text: async () => body,
  } as Response;
  const error = await httpResponseError(legacyResponse);
  assert.equal(error.response?.body, body);
  assert.equal(error.response?.complete, true);
  assert.match(error.message, /NATIVE-LAST-FIELD/);
  const stalled = {
    ...legacyResponse,
    text: () => new Promise<string>(() => undefined),
  } as Response;
  const failure = await httpResponseError(stalled, { timeoutMs: 20 });
  assert.equal(failure.response?.complete, false);
  assert.match(failure.message, /timed out/);
});

test("plain response objects and fetch causes retain details without a message field", async () => {
  assert.match(
    errorDetails({ failure: { reason: "structured failure", retryAfter: 20 } }),
    /structured failure/,
  );
  assert.match(
    errorDetails({
      error: { cause: { reason: "nested server cause must survive" } },
    }),
    /nested server cause must survive/,
  );
  const nativeCause = new Error("TLS certificate rejected: fixture detail");
  const client = transport(async () => {
    throw nativeCause;
  });
  await assert.rejects(client.request(`${ORIGIN}/models`), (error: unknown) => {
    assert.ok(error instanceof HttpTransportError);
    assert.equal(error.cause, nativeCause);
    assert.match(error.message, /TLS certificate rejected: fixture detail/);
    return true;
  });
});

function transport(fetch: FetchLike, timeoutMs = 500) {
  return createHttpTransport({
    fetch,
    policy: { authorizedOrigins: [ORIGIN] },
    defaultTimeoutMs: timeoutMs,
  });
}

function response(
  status: number,
  headers: HeadersInit = {},
  body?: ReadableStream<Uint8Array>,
) {
  return new Response(body, { status, headers });
}

function byteStream(
  chunks: readonly Uint8Array[],
  delayMs = 0,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]!);
    },
  });
}

test("SSE parser handles split UTF-8, fields, multiline data, and heartbeat comments", async () => {
  const bytes = new TextEncoder().encode(
    ": heartbeat\r\nid: 7\nevent: token\ndata: caf\u00e9\ndata: second\n\n",
  );
  // Split within the multi-byte UTF-8 character to exercise streaming decode.
  const index = bytes.indexOf(0xc3);
  const chunks = [
    bytes.slice(0, index + 1),
    bytes.slice(index + 1, index + 2),
    bytes.slice(index + 2),
  ];
  const client = transport(async () =>
    response(
      200,
      { "content-type": "text/event-stream; charset=utf-8" },
      byteStream(chunks),
    ),
  );
  const messages = [];
  for await (const message of client.streamSse(`${ORIGIN}/events`))
    messages.push(message);
  assert.deepEqual(messages, [
    { data: "café\nsecond", event: "token", id: "7" },
  ]);
});

test("401 and 403 responses map to stable typed errors", async () => {
  for (const [status, code] of [
    [401, "unauthorized"],
    [403, "forbidden"],
  ] as const) {
    const client = transport(async () => response(status));
    await assert.rejects(
      client.request(`${ORIGIN}/private`),
      (error: unknown) =>
        error instanceof HttpTransportError &&
        error.code === code &&
        error.status === status,
    );
  }
});

test("provider opt-in can inspect non-2xx bodies while default stays typed", async () => {
  const client = transport(
    async () =>
      new Response(JSON.stringify({ error: "context length exceeded" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(
    client.request(`${ORIGIN}/chat`),
    (error: unknown) =>
      error instanceof HttpTransportError && error.code === "http",
  );
  const response = await client.request(
    `${ORIGIN}/chat`,
    { method: "POST" },
    { returnHttpErrors: true },
  );
  assert.equal(response.status, 400);
  assert.match(await response.text(), /context length exceeded/);
});

test("cross-origin redirects are rejected before credentials can be forwarded", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const client = createHttpTransport({
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return response(302, { location: "https://foreign.example/collect" });
    },
    // Separate authorization never makes a credential-bearing redirect safe.
    policy: { authorizedOrigins: [ORIGIN, "https://foreign.example"] },
  });
  await assert.rejects(
    client.request(`${ORIGIN}/api`, {
      headers: { authorization: "Bearer secret" },
    }),
    (error: unknown) =>
      error instanceof HttpTransportError && error.code === "redirect_rejected",
  );
  assert.deepEqual(calls, [
    { url: `${ORIGIN}/api`, authorization: "Bearer secret" },
  ]);
});

test("foreign origins require explicit authorization and HTTP additionally requires LAN cleartext authorization", async () => {
  const client = transport(async () => response(200));
  await assert.rejects(
    client.request("https://other.example/"),
    (error: unknown) =>
      error instanceof HttpTransportError &&
      error.code === "host_not_authorized",
  );
  await assert.rejects(
    client.request("http://192.168.1.10:8080/"),
    (error: unknown) =>
      error instanceof HttpTransportError &&
      error.code === "host_not_authorized",
  );
  const lan = createHttpTransport({
    fetch: async () => response(200),
    policy: {
      authorizedOrigins: ["http://192.168.1.10:8080"],
      cleartextLanOrigins: ["http://192.168.1.10:8080"],
    },
  });
  assert.equal(
    (await lan.request("http://192.168.1.10:8080/health")).status,
    200,
  );
});

test("same-origin redirects work, while rejected statuses stay typed", async () => {
  let calls = 0;
  const client = transport(async () =>
    ++calls === 1 ? response(307, { location: "/v2" }) : response(200),
  );
  assert.equal((await client.request(`${ORIGIN}/v1`)).status, 200);
  assert.equal(calls, 2);
});

test("a dropped stream is a typed offline failure", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
    },
    pull() {
      throw new Error("socket dropped");
    },
  });
  const client = transport(async () =>
    response(200, { "content-type": "text/event-stream" }, stream),
  );
  const iterator = client.streamSse(`${ORIGIN}/events`)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { data: "first" },
  });
  await assert.rejects(
    iterator.next(),
    (error: unknown) =>
      error instanceof HttpTransportError && error.code === "offline",
  );
});

test("idle SSE streams time out and caller cancellation is observable", async () => {
  const never = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => undefined);
    },
  });
  const timed = transport(
    async () => response(200, { "content-type": "text/event-stream" }, never),
    25,
  );
  await assert.rejects(
    timed.streamSse(`${ORIGIN}/events`)[Symbol.asyncIterator]().next(),
    (error: unknown) =>
      error instanceof HttpTransportError && error.code === "timeout",
  );

  const controller = new AbortController();
  const cancellable = transport(
    async () =>
      response(
        200,
        { "content-type": "text/event-stream" },
        new ReadableStream({
          pull() {
            return new Promise(() => undefined);
          },
        }),
      ),
    0,
  );
  const iterator = cancellable
    .streamSse(`${ORIGIN}/events`, {}, { signal: controller.signal })
    [Symbol.asyncIterator]();
  const pending = iterator.next();
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof HttpTransportError && error.code === "canceled",
  );
});

test("malformed UTF-8 fails without replacement characters", async () => {
  const client = transport(async () =>
    response(
      200,
      { "content-type": "text/event-stream" },
      byteStream([new Uint8Array([0xc3, 0x28])]),
    ),
  );
  await assert.rejects(
    client.streamSse(`${ORIGIN}/events`)[Symbol.asyncIterator]().next(),
    (error: unknown) =>
      error instanceof HttpTransportError && error.code === "malformed_stream",
  );
});
