import assert from "node:assert/strict";
import test from "node:test";
import {
  clearContext,
  readContext,
  runWithContext,
  setContext,
  type ContextStorage,
} from "../src/index.ts";

function storageDouble() {
  let value: string | null = null;
  const calls: string[] = [];
  const storage: ContextStorage = {
    async load() {
      calls.push("load");
      return value;
    },
    async save(text) {
      calls.push(`save:${text.length}`);
      value = text;
    },
    async clear() {
      calls.push("clear");
      value = null;
    },
  };
  return { storage, calls };
}

test("context persists across runs until cleared (smoke 1)", async () => {
  const { storage } = storageDouble();
  const seen: string[] = [];
  const generate = async (prompt: string) => {
    seen.push(prompt);
    return { ok: true as const, text: "a: 42" };
  };
  assert.equal(await setContext("Project codename: Atlas. Budget $2k.", storage), true);
  const r1 = await runWithContext("what is the budget?", {
    storage,
    modelClass: "q4-small",
    generate,
  });
  const r2 = await runWithContext("what is the budget again?", {
    storage,
    modelClass: "q4-small",
    generate,
  });
  assert.ok("prompt" in r1 && "prompt" in r2);
  assert.match(r1.prompt, /Project codename: Atlas/);
  assert.match(r2.prompt, /Project codename: Atlas/);
  await clearContext(storage);
  assert.equal(await readContext(storage), null);
  const r3 = await runWithContext("budget?", {
    storage,
    modelClass: "q4-small",
    generate,
  });
  assert.ok("prompt" in r3);
  assert.equal(r3.prompt, "budget?");
});

test("no off-device sync seam exists — only the injected storage port", async () => {
  const { storage, calls } = storageDouble();
  await setContext("secret context", storage);
  await runWithContext("q", {
    storage,
    modelClass: "q4-small",
    async generate() {
      return { ok: true as const, text: "a" };
    },
  });
  assert.deepEqual(calls, ["save:14", "load"]);
});

test("oversized or empty context is refused, never truncated", async () => {
  const { storage, calls } = storageDouble();
  assert.equal(await setContext("", storage), false);
  assert.equal(await setContext("x".repeat(20001), storage), false);
  assert.deepEqual(calls, []);
  const bad = await runWithContext("", {
    storage,
    modelClass: "q4-small",
    async generate() {
      return { ok: true as const, text: "a" };
    },
  });
  assert.deepEqual(bad, { ok: false, reason: "invalid-input" });
});

test("model loss surfaces as a named reason", async () => {
  const { storage } = storageDouble();
  const missing = await runWithContext("q", {
    storage,
    modelClass: "q9-gone",
    async generate() {
      return { ok: false as const, reason: "model-unavailable" as const };
    },
  });
  assert.deepEqual(missing, { ok: false, reason: "model-unavailable" });
});
