import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRequest } from "@locallab/contracts/run-events";
import { createMlxInferencePort, type MlxNativeRuntime } from "../src/index.js";

const request = (parameters: Record<string, unknown> = {}): RunRequest => ({
  runId: "run-00000000-0000-4000-8000-000000000001",
  conversationId: "conversation-00000000-0000-4000-8000-000000000001",
  messageId: "message-00000000-0000-4000-8000-000000000001",
  providerConnectionId: "connection-00000000-0000-4000-8000-000000000001",
  modelId: "mlx:sample-model",
  context: [{ kind: "user", value: "hello" }],
  parameters,
  permittedTools: [],
  attachmentRefs: [],
  reasoning: true,
  json: false,
});

function setup(runtimeOverrides: Partial<MlxNativeRuntime> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const runtime: MlxNativeRuntime = {
    async capabilities() {
      return {
        runtime: "yes",
        streaming: "yes",
        tokenizer: "yes",
        temperature: "yes",
        topP: "yes",
        maxTokens: "yes",
        tools: "no",
        jsonMode: "no",
        ggufAlternative: "yes",
      };
    },
    async *run(input) {
      calls.push({ run: input });
      yield { type: "reasoning", text: "thinking" };
      yield { type: "text", text: "Hello" };
      yield { type: "usage", inputTokens: 4, outputTokens: 1 };
    },
    ...runtimeOverrides,
  };
  const port = createMlxInferencePort({
    folders: {
      async resolveManagedFolder(id) {
        calls.push({ id });
        return id.startsWith("mlx:") ? "/app/models/sample" : undefined;
      },
      async validateFolder(folder) {
        calls.push({ folder });
        return { ok: true };
      },
    },
    runtime,
  });
  return { calls, port };
}

test("loads a validated managed folder, clamps supported sampling, and streams terminal ordered events", async () => {
  const { calls, port } = setup();
  const events = [];
  for await (const event of port.startRun(
    request({ temperature: 9, top_p: 0, max_tokens: 9000 }),
    new AbortController().signal,
  ))
    events.push(event);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "RunStarted",
      "LoadProgress",
      "ReasoningDelta",
      "TextDelta",
      "Usage",
      "RunCompleted",
    ],
  );
  const input = calls.find((call) => "run" in call)?.["run"] as {
    folder: string;
    sampling: { temperature: number; topP: number; maxTokens: number };
  };
  assert.equal(input.folder, "/app/models/sample");
  assert.deepEqual(input.sampling, {
    temperature: 2,
    topP: 0.01,
    maxTokens: 8192,
  });
});

test("reports unsupported and unknown hardware with the explicit GGUF fallback", async () => {
  for (const runtimeCapability of ["no", "unknown"] as const) {
    const { port } = setup({
      async capabilities() {
        return {
          runtime: runtimeCapability,
          streaming: "yes",
          tokenizer: "yes",
          temperature: "yes",
          topP: "yes",
          maxTokens: "yes",
          tools: "no",
          jsonMode: "no",
          ggufAlternative: "yes",
          explanation: "No verified MLX Metal runtime",
        };
      },
    });
    const events = [];
    for await (const event of port.startRun(
      request(),
      new AbortController().signal,
    ))
      events.push(event);
    assert.equal(events.at(-1)?.type, "RunFailed");
    const failure = events.at(-1);
    assert.ok(failure?.type === "RunFailed");
    if (failure?.type === "RunFailed")
      assert.equal(
        failure.error.code,
        runtimeCapability === "no"
          ? "unsupported-hardware"
          : "capability-unknown",
      );
  }
});

test("rejects path or non-MLX model IDs without opening a folder", async () => {
  const { calls, port } = setup();
  const events = [];
  for await (const event of port.startRun(
    { ...request(), modelId: "file:///private/model.gguf" },
    new AbortController().signal,
  ))
    events.push(event);
  assert.equal(events.at(-1)?.type, "RunFailed");
  assert.equal(
    calls.some((call) => "run" in call),
    false,
  );
});

test("propagates cancellation and disposes active work", async () => {
  let observedAbort = false;
  const { port } = setup({
    async *run(input) {
      await new Promise<void>((resolve) =>
        input.signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve();
          },
          { once: true },
        ),
      );
    },
  });
  const controller = new AbortController();
  const eventsPromise = (async () => {
    const events = [];
    for await (const event of port.startRun(request(), controller.signal))
      events.push(event);
    return events;
  })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const events = await eventsPromise;
  assert.equal(observedAbort, true);
  assert.equal(events.at(-1)?.type, "RunCanceled");
});
