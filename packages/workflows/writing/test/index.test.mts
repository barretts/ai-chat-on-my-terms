import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrompt,
  commitPreviewToClipboard,
  runWritingWorkflow,
  type ClipboardPort,
} from "../src/index.ts";

const sel = { text: "hey can you send me the file today", origin: "selection" } as const;

test("the four recipes produce distinct prompts (smoke: outputs distinct)", () => {
  const prompts = (
    ["unchatgptfy", "rephrase-email", "help-me-write", "social-media"] as const
  ).map((w) => buildPrompt(w, sel));
  assert.equal(new Set(prompts).size, 4);
  assert.match(prompts[0]!, /reads like the author wrote it by hand/);
  assert.match(prompts[1]!, /Rephrase the email below/);
  assert.match(prompts[2]!, /ask one clarifying question/);
  assert.match(prompts[3]!, /280-character variant/);
  for (const p of prompts)
    assert.ok(p.includes('"""\nhey can you send me the file today\n"""'));
});

test("selection is preserved and model failure is surfaced", async () => {
  const res = await runWritingWorkflow("unchatgptfy", sel, {
    modelClass: "q4-small",
    async generate() {
      return { ok: true, text: "can you send the file today?" };
    },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.artifact.originalText, sel.text);
  assert.equal(res.artifact.editable, true);
  const bad = await runWritingWorkflow(
    "rephrase-email",
    { text: "x".repeat(8001), origin: "clipboard" },
    {
      modelClass: "q4-small",
      async generate() {
        return { ok: true, text: "no" };
      },
    },
  );
  assert.deepEqual(bad, { ok: false, reason: "source-too-long" });
  const missing = await runWritingWorkflow("social-media", sel, {
    modelClass: "q9-gone",
    async generate() {
      return { ok: false, reason: "model-unavailable" };
    },
  });
  assert.deepEqual(missing, { ok: false, reason: "model-unavailable" });
});

test("tone and persona are explicit user settings (step 3)", async () => {
  const seen: string[] = [];
  const res = await runWritingWorkflow("rephrase-email", sel, {
    modelClass: "q4-small",
    tone: "formal",
    persona: { name: "Calm Colleague", instruction: "plain and warm" },
    async generate(prompt) {
      seen.push(prompt);
      return { ok: true, text: "ok" };
    },
  });
  assert.equal(res.ok, true);
  assert.match(seen[0]!, /Tone: formal\./);
  assert.match(seen[0]!, /Adopt this persona: Calm Colleague — plain and warm/);
  const plain = buildPrompt("unchatgptfy", sel);
  assert.ok(!plain.includes("Adopt this persona"));
  assert.ok(plain.includes("Tone: neutral."));
});

test("clipboard write only happens on the explicit copy tap (step 2)", async () => {
  const writes: string[] = [];
  const clipboard: ClipboardPort = {
    async read() {
      return "old clipboard";
    },
    async write(text) {
      writes.push(text);
    },
  };
  const res = await runWritingWorkflow("unchatgptfy", sel, {
    modelClass: "q4-small",
    async generate() {
      return { ok: true, text: "rewritten" };
    },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(await commitPreviewToClipboard(res.artifact, clipboard, false), false);
  assert.deepEqual(writes, []);
  assert.equal(await commitPreviewToClipboard(res.artifact, clipboard, true), true);
  assert.deepEqual(writes, ["rewritten"]);
});
