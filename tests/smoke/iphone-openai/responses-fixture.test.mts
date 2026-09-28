import { describe, expect, it } from "vitest";
import type { RunRequest, RunEvent } from "@locallab/contracts/run-events";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import type { FetchLike } from "@locallab/network-http";
import { createOpenAIResponsesProvider } from "../../../packages/providers/openai-first-run/src/index.js";

const runId = "018f0b1a-7b3c-7abc-8def-123456789abc";
const request: RunRequest = {
  runId,
  conversationId: runId,
  messageId: runId,
  providerConnectionId: "018f0b1a-7b3c-7abc-8def-123456789abd",
  modelId: "gpt-fixture",
  context: [{ kind: "user", value: "Reply with the word hello." }],
  parameters: {},
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};
const ref = "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as SecretRef;
const secret = "fixture-secret-never-display";

function secretStore(
  resolveHeaders: SecretStore["resolveHeaders"],
): SecretStore {
  return {
    put: async () => {
      throw new Error("unused");
    },
    remove: async () => {},
    resolveHeaders,
  };
}

async function collect(events: AsyncIterable<RunEvent>) {
  const output: RunEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

describe("iPhone OpenAI first-run controlled smoke", () => {
  it("streams the Responses fixture through the same adapter used by the route", async () => {
    let requestAuthorization = "";
    const fetcher: FetchLike = async (_input, init) => {
      requestAuthorization =
        new Headers(init?.headers).get("authorization") ?? "";
      const sse = [
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
      ].join("");
      return new Response(sse, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const port = createOpenAIResponsesProvider({
      secrets: secretStore(async () => ({ authorization: secret })),
      fetch: fetcher,
      resolveConnection: async () => ({
        endpointUrl: "https://api.example.test/v1/responses",
        modelId: "gpt-fixture",
        apiKeyRef: ref,
      }),
    });
    const events = await collect(
      port.startRun(request, new AbortController().signal),
    );
    expect(requestAuthorization).toBe(`Bearer ${secret}`);
    expect(events.map((event) => event.type)).toEqual([
      "RunStarted",
      "TextDelta",
      "Usage",
      "RunCompleted",
    ]);
    expect(events.find((event) => event.type === "TextDelta")).toMatchObject({
      text: "Hello",
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("turns an invalid saved key into a recoverable, key-safe failure", async () => {
    let fetchCalls = 0;
    const port = createOpenAIResponsesProvider({
      secrets: secretStore(async () => {
        throw new Error(secret);
      }),
      fetch: async () => {
        fetchCalls += 1;
        return new Response();
      },
      resolveConnection: async () => ({
        endpointUrl: "https://api.example.test/v1/responses",
        modelId: "gpt-fixture",
        apiKeyRef: ref,
      }),
    });
    const events = await collect(
      port.startRun(request, new AbortController().signal),
    );
    const failure = events.find((event) => event.type === "RunFailed");
    expect(failure).toMatchObject({
      type: "RunFailed",
      error: { code: "unauthorized", recoverable: true },
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(fetchCalls).toBe(0);
  });

  it("honors composer stop while the remote Responses stream is open", async () => {
    let fetchCalls = 0;
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const port = createOpenAIResponsesProvider({
      secrets: secretStore(async () => ({ authorization: secret })),
      fetch: async (_input, init) => {
        fetchCalls += 1;
        received();
        return new Response(
          new ReadableStream({
            start(stream) {
              init?.signal?.addEventListener(
                "abort",
                () => stream.error(new DOMException("Stopped", "AbortError")),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      resolveConnection: async () => ({
        endpointUrl: "https://api.example.test/v1/responses",
        modelId: "gpt-fixture",
        apiKeyRef: ref,
      }),
    });
    const controller = new AbortController();
    const iterator = port
      .startRun(request, controller.signal)
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "RunStarted" });
    const pending = iterator.next();
    await requestReceived;
    controller.abort();
    const stopped = await pending;
    expect(stopped).toMatchObject({
      done: false,
      value: { type: "RunCanceled" },
    });
    expect(fetchCalls).toBe(1);
    expect(JSON.stringify(stopped)).not.toContain(secret);
  });
});
