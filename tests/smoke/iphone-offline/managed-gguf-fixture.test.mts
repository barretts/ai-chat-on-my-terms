import { describe, expect, it } from "vitest";
import type { RunRequest, RunEvent } from "@locallab/contracts/run-events";
import { createGgufInferencePort } from "../../../modules/gguf/ios/src/index.js";

const id = "018f0b1a-7b3c-7abc-8def-123456789abc";
const request: RunRequest = {
  runId: id,
  conversationId: id,
  messageId: id,
  providerConnectionId: id,
  modelId: `blob:${id}`,
  context: [{ kind: "user", value: "Say hello from the offline model." }],
  parameters: { max_tokens: 8 },
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};

describe("iPhone offline controlled GGUF smoke", () => {
  it("loads only the managed blob and streams a bounded fixture response", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const files = {
      async acquire(model: { blobId: string }) {
        acquired.push(model.blobId);
        return {
          uri: "file:///app-cache/fixture.gguf",
          async release() {
            released.push(model.blobId);
          },
        };
      },
    };
    const runtime = {
      async initLlama(options: { model: string; n_ctx: number }) {
        expect(options.model).toBe("file:///app-cache/fixture.gguf");
        expect(options.n_ctx).toBeGreaterThan(0);
        return {
          parallel: {
            async completion(
              _params: unknown,
              onToken: (_id: number, token: { content: string }) => void,
            ) {
              onToken(0, { content: "Hello from the local fixture." });
              return {
                promise: Promise.resolve({
                  timings: { prompt_n: 8, predicted_n: 6 },
                }),
                async stop() {},
              };
            },
          },
          async release() {},
        };
      },
    };
    const port = createGgufInferencePort({
      files,
      runtime: runtime as never,
      contextSize: 256,
      maxContextSize: 256,
    });
    const events: RunEvent[] = [];
    for await (const event of port.startRun(
      request,
      new AbortController().signal,
    ))
      events.push(event);
    expect(acquired).toEqual([id]);
    expect(released).toEqual([id]);
    expect(events.map((event) => event.type)).toEqual([
      "RunStarted",
      "TextDelta",
      "Usage",
      "RunCompleted",
    ]);
    expect(events.find((event) => event.type === "TextDelta")).toMatchObject({
      text: "Hello from the local fixture.",
    });
  });

  it("rejects a model path that is not a managed blob identity", async () => {
    const port = createGgufInferencePort({
      files: {
        async acquire() {
          throw new Error("must not read arbitrary paths");
        },
      },
      runtime: {} as never,
    });
    const events: RunEvent[] = [];
    const invalid = { ...request, modelId: "file:///tmp/model.gguf" };
    for await (const event of port.startRun(
      invalid,
      new AbortController().signal,
    ))
      events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "RunFailed",
      error: { code: "missing-model" },
    });
  });
});
