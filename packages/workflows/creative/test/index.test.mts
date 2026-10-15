import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, runCreativeWorkflow, type ContextPort } from "../src/index.ts";

test("both recipes run against a local model (smoke 1)", async () => {
  const used: string[] = [];
  const generate = async (prompt: string, modelClass: string) => {
    used.push(modelClass);
    return {
      ok: true as const,
      text: prompt.includes("story") ? "Once upon a time" : "I hear you",
    };
  };
  const story = await runCreativeWorkflow(
    {
      workflow: "story",
      premise: "a lighthouse keeper finds a robot",
      genre: "sci-fi",
    },
    { modelClass: "q4-small", generate },
  );
  const support = await runCreativeWorkflow(
    { workflow: "emotional-support", message: "work has been overwhelming" },
    { modelClass: "q4-small", generate },
  );
  assert.equal(story.ok, true);
  assert.equal(support.ok, true);
  assert.deepEqual(used, ["q4-small", "q4-small"]);
  assert.match(
    buildPrompt({ workflow: "story", premise: "p", genre: "sci-fi" }),
    /Genre: sci-fi\./,
  );
  assert.match(
    buildPrompt({ workflow: "emotional-support", message: "m" }),
    /do not diagnose/i,
  );
  assert.match(
    buildPrompt({ workflow: "emotional-support", message: "m" }),
    /professional or crisis support/,
  );
});

test("context is isolated unless intentionally selected (smoke 2, step 3)", async () => {
  const entries: unknown[] = [];
  const context: ContextPort = {
    async append(entry) {
      entries.push(entry);
    },
  };
  const gen = async () => ({ ok: true as const, text: "r" });
  const off = await runCreativeWorkflow(
    { workflow: "story", premise: "secret premise" },
    { modelClass: "q4-small", generate: gen, context },
  );
  assert.equal(off.ok, true);
  if (off.ok) assert.equal(off.retained, false);
  assert.deepEqual(entries, []);
  const on = await runCreativeWorkflow(
    { workflow: "story", premise: "kept premise" },
    { modelClass: "q4-small", generate: gen, context, saveContext: true },
  );
  assert.equal(on.ok, true);
  if (on.ok) assert.equal(on.retained, true);
  assert.equal(entries.length, 1);
});

test("persona rides ordinary chat prompts; model loss is surfaced", async () => {
  const prompt = buildPrompt({
    workflow: "story",
    premise: "p",
    persona: { name: "Grumpy Narrator", instruction: "dry wit" },
  });
  assert.match(prompt, /Adopt this persona: Grumpy Narrator — dry wit/);
  const missing = await runCreativeWorkflow(
    { workflow: "emotional-support", message: "m" },
    {
      modelClass: "q9-gone",
      async generate() {
        return { ok: false as const, reason: "model-unavailable" as const };
      },
    },
  );
  assert.deepEqual(missing, { ok: false, reason: "model-unavailable" });
});

test("inputs are strict — no smuggled fields, no unbounded text", async () => {
  let called = false;
  const options = {
    modelClass: "q4-small",
    async generate() {
      called = true;
      return { ok: true as const, text: "x" };
    },
  };
  for (const bad of [
    { workflow: "story", premise: "p", providerUrl: "https://remote" },
    { workflow: "story", premise: "p".repeat(2001) },
    { workflow: "chat", message: "m" },
  ]) {
    const res = await runCreativeWorkflow(bad, options);
    assert.deepEqual(
      res,
      { ok: false, reason: "invalid-input" },
      JSON.stringify(bad),
    );
  }
  assert.equal(called, false);
});
