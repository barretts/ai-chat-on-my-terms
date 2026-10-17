import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlamaContext } from "llama.rn";
import {
  RunEventBatchSchema,
  type RunRequest,
} from "@locallab/contracts/run-events";
import { createGgufInferencePort } from "../src/index.js";
import { nativeChatRequest, nativeToolCalls } from "../src/tool-protocol.js";
import { createLlamaStreamDecoder } from "../src/stream-decoder.js";

const id = "00000000-0000-7000-8000-000000000001";
const definition = {
  name: "current_time",
  description: "Read the time",
  parameters: { type: "object", properties: {} },
};
const request = (): RunRequest => ({
  runId: id,
  conversationId: id,
  messageId: id,
  providerConnectionId: id,
  modelId: `blob:${id}`,
  context: [
    { kind: "user", value: "Use current_time" },
    { kind: "tool-definitions", value: [definition] },
  ],
  parameters: {},
  permittedTools: ["current_time"],
  attachmentRefs: [],
  reasoning: false,
  json: false,
});
const call = (name = "current_time", args = "{}") => ({
  type: "function",
  function: { name, arguments: args },
});

function native(
  result: object,
  updates: object[] = [],
  onCompletion?: () => void,
) {
  const completions: Record<string, unknown>[] = [];
  let released = 0;
  const context = {
    parallel: {
      async completion(
        params: Record<string, unknown>,
        callback: (id: number, token: object) => void,
      ) {
        completions.push(params);
        for (const token of updates) callback(1, token);
        onCompletion?.();
        return {
          requestId: 1,
          promise: Promise.resolve(result),
          async stop() {},
        };
      },
    },
    async release() {
      released++;
    },
  } as unknown as LlamaContext;
  const port = createGgufInferencePort({
    runtime: {
      async initLlama() {
        return context;
      },
    },
    files: {
      async acquire() {
        return {
          uri: "file:///private/model.gguf",
          async release() {
            released++;
          },
        };
      },
    },
  });
  return { port, completions, released: () => released };
}

test("native completion receives permitted tools with Jinja and emits one complete call from repeated snapshots", async () => {
  const snapshot = { token: "x", content: "", tool_calls: [call()] };
  const { port, completions, released } = native(
    {
      content: "",
      tool_calls: [call()],
      timings: { prompt_n: 20, predicted_n: 10 },
    },
    [snapshot, snapshot],
  );
  const events = [];
  for await (const event of port.startRun(
    request(),
    new AbortController().signal,
  ))
    events.push(event);
  RunEventBatchSchema.parse(events);
  assert.equal(completions[0]?.jinja, true);
  assert.equal(completions[0]?.tool_choice, "auto");
  assert.deepEqual(completions[0]?.tools, [
    { type: "function", function: definition },
  ]);
  assert.deepEqual(completions[0]?.messages, [
    { role: "user", content: "Use current_time" },
  ]);
  assert.equal(events.filter((event) => event.type === "ToolCall").length, 1);
  assert.ok(!events.some((event) => event.type === "TextDelta"));
  assert.deepEqual(events.at(-1), {
    runId: id,
    sequence: events.length - 1,
    timestamp: events.at(-1)?.timestamp,
    type: "RunCompleted",
    finishReason: "tool_calls",
  });
  assert.equal(released(), 2);
});

test("tool definitions are filtered by permission and never become chat messages", () => {
  const input = request();
  input.permittedTools = [];
  assert.deepEqual(nativeChatRequest(input).tools, []);
  assert.equal(nativeChatRequest(input).messages.length, 1);
});

test("tool exchange replay keeps assistant call arguments and matching tool result IDs", () => {
  const input = request();
  input.context.splice(
    1,
    0,
    {
      kind: "assistant",
      value: {
        content: "Checking.",
        tool_calls: [
          {
            id,
            type: "function",
            function: { name: "current_time", arguments: { timezone: "UTC" } },
          },
        ],
      },
    },
    {
      kind: "tool",
      value: {
        tool_call_id: id,
        name: "current_time",
        content: '{"time":"12:00"}',
      },
    },
  );
  assert.deepEqual(nativeChatRequest(input).messages.slice(1), [
    {
      role: "assistant",
      content: "Checking.",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "current_time", arguments: '{"timezone":"UTC"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: id,
      name: "current_time",
      content: '{"time":"12:00"}',
    },
  ]);
});

for (const [label, calls, code] of [
  ["invalid JSON", [call("current_time", "{")], "malformed"],
  ["array arguments", [call("current_time", "[]")], "malformed"],
  ["null arguments", [call("current_time", "null")], "malformed"],
  ["unpermitted function", [call("workspace_read_file")], "permission"],
  ["malformed second call", [call(), call("current_time", "{")], "malformed"],
] as const)
  test(`rejects ${label} before any tool event, while releasing the model`, async () => {
    const { port, released } = native({ content: "", tool_calls: calls });
    const events = [];
    for await (const event of port.startRun(
      request(),
      new AbortController().signal,
    ))
      events.push(event);
    RunEventBatchSchema.parse(events);
    assert.ok(!events.some((event) => event.type === "ToolCall"));
    assert.equal(events.at(-1)?.type, "RunFailed");
    const failure = events.at(-1);
    if (failure?.type === "RunFailed") assert.equal(failure.error.code, code);
    assert.equal(released(), 2);
  });

test("calls not backed by a granted definition cannot execute", async () => {
  const input = request();
  input.context = input.context.filter(
    (item) => item.kind !== "tool-definitions",
  );
  const { port } = native({ content: "", tool_calls: [call()] });
  const events = [];
  for await (const event of port.startRun(input, new AbortController().signal))
    events.push(event);
  assert.equal(events.at(-1)?.type, "RunFailed");
});

test("native call IDs are stable per round and distinct across calls and rounds", () => {
  const first = nativeToolCalls([call(), call()], request(), ["current_time"]);
  const repeated = nativeToolCalls([call(), call()], request(), [
    "current_time",
  ]);
  const next = nativeToolCalls(
    [call()],
    { ...request(), runId: "00000000-0000-7000-8000-000000000002" },
    ["current_time"],
  );
  assert.deepEqual(first, repeated);
  assert.equal(
    new Set([...first, ...next].map((call) => call.invocationId)).size,
    3,
  );
});

test("split raw tool tags and JSON arguments do not leak into visible chat", () => {
  const decoder = createLlamaStreamDecoder({ toolsEnabled: true });
  let text = "";
  for (const token of [
    "Checking. ",
    "<tool_",
    "call>",
    "<function=current_time><parameter=secret>hidden</parameter></function>",
    "</tool_call>",
  ])
    text += decoder.push({ token }).text;
  text += decoder.finish({
    content: "Checking. <tool_call>hidden</tool_call>",
    tool_calls: [call()],
  }).text;
  assert.equal(text, "Checking. ");
});

test("unparsed native tool markup fails explicitly rather than pretending to answer", async () => {
  const { port } = native({ text: "<tool_call>unparsed</tool_call>" });
  const events = [];
  for await (const event of port.startRun(
    request(),
    new AbortController().signal,
  ))
    events.push(event);
  assert.equal(events.at(-1)?.type, "RunFailed");
  assert.ok(
    !events.some(
      (event) => event.type === "ToolCall" || event.type === "TextDelta",
    ),
  );
});

test("output-limit termination never executes a partially generated call", async () => {
  const { port } = native({
    content: "",
    tool_calls: [call()],
    stopped_limit: 1,
  });
  const events = [];
  for await (const event of port.startRun(
    request(),
    new AbortController().signal,
  ))
    events.push(event);
  assert.equal(events.at(-1)?.type, "RunFailed");
  assert.ok(!events.some((event) => event.type === "ToolCall"));
});

test("abort during native dispatch cancels the turn without executing the returned tool call", async () => {
  const controller = new AbortController();
  const { port, released } = native(
    { content: "", tool_calls: [call()] },
    [],
    () => controller.abort(),
  );
  const events = [];
  for await (const event of port.startRun(request(), controller.signal))
    events.push(event);
  RunEventBatchSchema.parse(events);
  assert.equal(events.at(-1)?.type, "RunCanceled");
  assert.ok(!events.some((event) => event.type === "ToolCall"));
  assert.equal(released(), 2);
});
