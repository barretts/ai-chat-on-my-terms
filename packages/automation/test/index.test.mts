import assert from "node:assert/strict";
import test from "node:test";
import {
  createShortcutRunner,
  parseShortcutUrl,
  serializeIntent,
  type ShortcutServices,
  type VoicePermission,
} from "../src/index.ts";

test("each App Intent action parses and serializes canonically", () => {
  const ask = parseShortcutUrl(
    "locallab://shortcut/ask?q=what+is+the+weather&modelClass=q4-small",
  );
  assert.deepEqual(ask, {
    action: "ask",
    q: "what+is+the+weather",
    modelClass: "q4-small",
  });
  assert.equal(
    serializeIntent(ask!),
    '{"action":"ask","q":"what+is+the+weather","modelClass":"q4-small"}',
  );
  assert.deepEqual(parseShortcutUrl("locallab://shortcut/search?q=hi"), {
    action: "search",
    q: "hi",
  });
  assert.deepEqual(parseShortcutUrl("locallab://shortcut/voice"), {
    action: "voice",
  });
  assert.deepEqual(parseShortcutUrl("locallab://shortcut/summarize"), {
    action: "summarize",
  });
  assert.deepEqual(
    parseShortcutUrl("locallab://shortcut/translate?lang=de"),
    { action: "translate", lang: "de" },
  );
  assert.deepEqual(parseShortcutUrl("locallab://shortcut/news?read=true"), {
    action: "news",
    read: true,
  });
  assert.deepEqual(parseShortcutUrl("locallab://shortcut/news"), {
    action: "news",
    read: false,
  });
});

test("malformed or untrusted URLs refuse — no action, no params leak", () => {
  const refusals = [
    "locallab://shortcut/execute?cmd=rm",
    "locallab://shortcut/ask",
    "locallab://shortcut/ask?q=hi&token=sk-live-secret",
    "locallab://shortcut/ask?q=100%2520bytes",
    "lmmini://shortcut/ask?q=hi",
    "https://example.com/shortcut/ask?q=hi",
    "locallab://shortcut/ask?q=hi&lang=de",
    "locallab://shortcut/translate",
    "locallab://shortcut/voice?q=sneaky",
    "locallab://shortcut/ask?q=hi&lang=de&q=again",
  ];
  for (const url of refusals)
    assert.equal(parseShortcutUrl(url), null, `expected refusal: ${url}`);
});

function servicesDouble(overrides: {
  voice?: VoicePermission;
  shared?: string | null;
}) {
  const calls: string[] = [];
  const services: ShortcutServices = {
    async ask(q, modelClass) {
      calls.push(`ask:${q}:${modelClass ?? "-"}`);
    },
    async search(q) {
      calls.push(`search:${q}`);
    },
    async voice() {
      calls.push("voice");
    },
    async summarize(text, modelClass) {
      calls.push(`summarize:${text.length}:${modelClass ?? "-"}`);
    },
    async translate(text, lang) {
      calls.push(`translate:${text.length}:${lang}`);
    },
    async news(read) {
      calls.push(`news:${read}`);
    },
    voicePermission: () => overrides.voice ?? "granted",
    sharedImport: () => overrides.shared ?? null,
  };
  return { services, calls };
}

test("each action invokes the same service the UI uses (smoke 1)", async () => {
  const { services, calls } = servicesDouble({});
  const runner = createShortcutRunner({ services });
  const results = [];
  results.push(
    await runner.runUrl("locallab://shortcut/ask?q=hello", { foreground: true }),
  );
  results.push(
    await runner.runUrl("locallab://shortcut/search?q=hi", { foreground: false }),
  );
  results.push(await runner.runUrl("locallab://shortcut/voice", { foreground: false }));
  results.push(
    await runner.runUrl("locallab://shortcut/news?read=true", {
      foreground: false,
    }),
  );
  assert.deepEqual(results, [
    { status: "done" },
    { status: "done" },
    { status: "done" },
    { status: "done" },
  ]);
  assert.deepEqual(calls, ["ask:hello:-", "search:hi", "voice", "news:true"]);
});

test("untrusted URL executes nothing at all", async () => {
  const { services, calls } = servicesDouble({});
  const runner = createShortcutRunner({ services });
  const res = await runner.runUrl(
    "locallab://shortcut/ask?q=hi&token=sk-live-secret",
    { foreground: true },
  );
  assert.deepEqual(res, { status: "refused", reason: "malformed" });
  assert.deepEqual(calls, []);
});

test("share imports and voice permission need interactive review (step 3)", async () => {
  const shared = servicesDouble({ shared: "  text shared from another app  " });
  const runner = createShortcutRunner({ services: shared.services });
  const background = await runner.runUrl("locallab://shortcut/summarize", {
    foreground: false,
  });
  assert.deepEqual(background, {
    status: "review-required",
    reason: "share-import",
  });
  assert.deepEqual(shared.calls, []);
  const foreground = await runner.runUrl("locallab://shortcut/summarize", {
    foreground: true,
  });
  assert.deepEqual(foreground, { status: "done" });
  assert.deepEqual(shared.calls, ["summarize:28:-"]);

  const noImport = servicesDouble({ shared: null });
  const missing = await createShortcutRunner({
    services: noImport.services,
  }).runUrl("locallab://shortcut/translate?lang=de", { foreground: true });
  assert.deepEqual(missing, { status: "refused", reason: "no-import" });

  const voiceNoPermission = servicesDouble({ voice: "undetermined" });
  const review = await createShortcutRunner({
    services: voiceNoPermission.services,
  }).runUrl("locallab://shortcut/voice", { foreground: false });
  assert.deepEqual(review, {
    status: "review-required",
    reason: "voice-permission",
  });
  assert.deepEqual(voiceNoPermission.calls, []);
  const voiceDenied = servicesDouble({ voice: "denied" });
  const denied = await createShortcutRunner({
    services: voiceDenied.services,
  }).runUrl("locallab://shortcut/voice", { foreground: true });
  assert.deepEqual(denied, { status: "refused", reason: "voice-denied" });
});
