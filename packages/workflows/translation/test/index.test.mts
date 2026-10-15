import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIPBOARD_CAP,
  translateClipboard,
  type ClipboardPort,
} from "../src/index.ts";

function clipboardDouble(initial: string | null) {
  let value = initial;
  const writes: string[] = [];
  const clipboard: ClipboardPort = {
    async read() {
      return value;
    },
    async write(text) {
      writes.push(text);
      value = text;
    },
  };
  return { clipboard, writes, get: () => value };
}

test("clipboard translate round-trip writes only on success (smoke)", async () => {
  const { clipboard, writes } = clipboardDouble("Good morning, world");
  const res = await translateClipboard("de", {
    clipboard,
    modelClass: "q4-small",
    async generate(prompt) {
      assert.match(prompt, /language coded "de"/);
      assert.match(prompt, /Good morning, world/);
      return { ok: true as const, text: "Guten Morgen, Welt" };
    },
  });
  assert.deepEqual(res, {
    ok: true,
    translated: "Guten Morgen, Welt",
    wroteBack: true,
  });
  assert.deepEqual(writes, ["Guten Morgen, Welt"]);
});

test("failed translation leaves the clipboard untouched (step 3)", async () => {
  const { clipboard, writes, get } = clipboardDouble("untouchable text");
  const missing = await translateClipboard("fr", {
    clipboard,
    modelClass: "q9-gone",
    async generate() {
      return { ok: false as const, reason: "model-unavailable" as const };
    },
  });
  assert.deepEqual(missing, { ok: false, reason: "model-unavailable" });
  assert.deepEqual(writes, []);
  assert.equal(get(), "untouchable text");
  const empty = await translateClipboard("fr", {
    clipboard,
    modelClass: "q4-small",
    async generate() {
      return { ok: true as const, text: "   " };
    },
  });
  assert.deepEqual(empty, { ok: false, reason: "empty-output" });
  assert.deepEqual(writes, []);
  assert.equal(get(), "untouchable text");
});

test("clipboard and language inputs are validated (step 2)", async () => {
  const gen = async () => ({ ok: true as const, text: "x" });
  const empty = clipboardDouble(null);
  assert.deepEqual(
    await translateClipboard("de", {
      clipboard: empty.clipboard,
      modelClass: "q4-small",
      generate: gen,
    }),
    { ok: false, reason: "empty-clipboard" },
  );
  const blank = clipboardDouble("   ");
  assert.deepEqual(
    await translateClipboard("de", {
      clipboard: blank.clipboard,
      modelClass: "q4-small",
      generate: gen,
    }),
    { ok: false, reason: "empty-clipboard" },
  );
  const huge = clipboardDouble("x".repeat(CLIPBOARD_CAP + 1));
  assert.deepEqual(
    await translateClipboard("de", {
      clipboard: huge.clipboard,
      modelClass: "q4-small",
      generate: gen,
    }),
    { ok: false, reason: "too-long" },
  );
  const badLang = clipboardDouble("hello");
  for (const lang of ["", "DE", "toolonglanguagecode", 42]) {
    assert.deepEqual(
      await translateClipboard(lang, {
        clipboard: badLang.clipboard,
        modelClass: "q4-small",
        generate: gen,
      }),
      { ok: false, reason: "invalid-input" },
    );
  }
  assert.deepEqual(badLang.writes, []);
});
