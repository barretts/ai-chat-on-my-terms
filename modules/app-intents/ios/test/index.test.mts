import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_COUNT,
  AppIntentNameSchema,
  INTENT_COUNT,
  ShareSheetPayloadSchema,
  actionForIntent,
  requiresForegroundReview,
} from "../src/index.ts";

test("the six App Intents map one-to-one onto shortcut actions", () => {
  assert.equal(INTENT_COUNT, 6);
  assert.equal(ACTION_COUNT, 6);
  assert.equal(actionForIntent("LocalLabAskIntent"), "ask");
  assert.equal(actionForIntent("LocalLabSearchIntent"), "search");
  assert.equal(actionForIntent("LocalLabVoiceIntent"), "voice");
  assert.equal(actionForIntent("LocalLabSummarizeIntent"), "summarize");
  assert.equal(actionForIntent("LocalLabTranslateIntent"), "translate");
  assert.equal(actionForIntent("LocalLabNewsIntent"), "news");
  assert.equal(AppIntentNameSchema.safeParse("LocalLabEvilIntent").success, false);
});

test("share-sheet payloads are plain text, bounded, control-free", () => {
  assert.equal(
    ShareSheetPayloadSchema.safeParse({
      text: "shared article body",
      contentType: "text/plain",
    }).success,
    true,
  );
  const refusals = [
    { text: "x", contentType: "application/pdf" },
    { text: "evil\u0000payload", contentType: "text/plain" },
    { text: "", contentType: "text/plain" },
    { text: "x".repeat(20001), contentType: "text/plain" },
    { text: "ok", contentType: "text/plain", url: "https://evil" },
  ];
  for (const bad of refusals) {
    const res = ShareSheetPayloadSchema.safeParse(bad);
    assert.equal(res.success, false, `expected refusal: ${JSON.stringify(bad)}`);
  }
});

test("sensitive intents require the foreground review sheet (step 3)", () => {
  assert.equal(requiresForegroundReview("LocalLabSummarizeIntent"), true);
  assert.equal(requiresForegroundReview("LocalLabTranslateIntent"), true);
  assert.equal(requiresForegroundReview("LocalLabVoiceIntent"), true);
  assert.equal(requiresForegroundReview("LocalLabAskIntent"), false);
  assert.equal(requiresForegroundReview("LocalLabNewsIntent"), false);
});
