import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLlamaStreamDecoder,
  splitThinking,
  type LlamaOutput,
  type StreamDeltas,
} from "../src/stream-decoder.js";

function collect(updates: LlamaOutput[], final: LlamaOutput): StreamDeltas {
  const decoder = createLlamaStreamDecoder();
  const all = [...updates.map((update) => decoder.push(update))];
  all.push(decoder.finish(final));
  return {
    reasoning: all.map((delta) => delta.reasoning).join(""),
    text: all.map((delta) => delta.text).join(""),
  };
}

test("cumulative native content is emitted once as deltas", () => {
  const decoder = createLlamaStreamDecoder();
  const snapshots = ["Hello", "Hello!", "Hello! How", "Hello! How can"];
  const deltas = snapshots.map(
    (content, index) =>
      decoder.push({ token: index ? "x" : "Hello", content }).text,
  );
  assert.deepEqual(deltas, ["Hello", "!", " How", " can"]);
  assert.deepEqual(decoder.finish({ content: "Hello! How can I" }), {
    reasoning: "",
    text: " I",
  });
});

test("the reported Qwen stream renders without think tags or repetition", () => {
  const tokens = ["<think>", "\n", "</think>", "\n", "Hello", "!", " How"];
  let accumulated = "";
  const updates = tokens.map((token) => {
    accumulated += token;
    // reasoning_format "none" leaves the template block inside content.
    return { token, content: accumulated, accumulated_text: accumulated };
  });
  assert.deepEqual(
    collect(updates, { text: accumulated, content: accumulated }),
    { reasoning: "", text: "Hello! How" },
  );
});

test("native reasoning_content is routed to reasoning deltas", () => {
  const result = collect(
    [
      { token: "Let", reasoning_content: "Let" },
      { token: " me", reasoning_content: "Let me" },
      { token: "</think>", reasoning_content: "Let me" },
      { token: "\n\nHi", reasoning_content: "Let me", content: "\n\nHi" },
    ],
    { reasoning_content: "Let me", content: "Hi", text: "Let me</think>Hi" },
  );
  assert.deepEqual(result, { reasoning: "Let me", text: "Hi" });
});

test("tags split across raw tokens are held back, never leaked", () => {
  const decoder = createLlamaStreamDecoder();
  const seen = ["<th", "ink>", "plan", "</th", "ink>", "Answer"].map((token) =>
    decoder.push({ token }),
  );
  assert.deepEqual(seen, [
    { reasoning: "", text: "" },
    { reasoning: "", text: "" },
    { reasoning: "plan", text: "" },
    { reasoning: "", text: "" },
    { reasoning: "", text: "" },
    { reasoning: "", text: "Answer" },
  ]);
  assert.deepEqual(decoder.finish({ text: "<think>plan</think>Answer" }), {
    reasoning: "",
    text: "",
  });
});

test("an unterminated think block streams as reasoning", () => {
  assert.deepEqual(splitThinking("<think>\nstill going", true), {
    reasoning: "still going",
    text: "",
  });
  assert.deepEqual(splitThinking("<think>still </thi", true), {
    reasoning: "still ",
    text: "",
  });
});

test("empty think blocks produce no reasoning and no leading blank lines", () => {
  assert.deepEqual(splitThinking("<think>\n\n</think>\n\nHello", false), {
    reasoning: "",
    text: "Hello",
  });
});

test("a held-back partial tag is released when the run finishes", () => {
  assert.deepEqual(collect([{ token: "a <" }], { text: "a <" }), {
    reasoning: "",
    text: "a <",
  });
});

test("raw tokens are ignored once native parsing has produced a snapshot", () => {
  const result = collect(
    [
      { token: "Hi", content: "Hi" },
      { token: " there" },
      { token: "!", content: "Hi there!" },
    ],
    { content: "Hi there!" },
  );
  assert.deepEqual(result, { reasoning: "", text: "Hi there!" });
});
