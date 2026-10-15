import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScreenshotPrompt,
  parseCardFields,
  routeScreenshotChat,
} from "../src/index.ts";

const ocr = {
  text: "Q3 revenue rose 12% over Q2",
  languageCode: "en",
  onDevice: true as const,
};

test("vision capability routes to a vision model with the image", () => {
  const route = routeScreenshotChat({
    question: "summarize this",
    imageRef: "shot-1",
    ocr,
    visionModelClass: "vision-small",
    textModelClass: "q4-small",
  });
  assert.deepEqual(route, {
    kind: "vision-model",
    modelClass: "vision-small",
    imageRef: "shot-1",
    prompt: "summarize this",
  });
});

test("without vision it falls back to OCR text with an explicit prompt (step 2)", () => {
  const route = routeScreenshotChat({
    question: "what changed?",
    imageRef: "shot-1",
    ocr,
    visionModelClass: null,
    textModelClass: "q4-small",
  });
  assert.equal(route.kind, "ocr-text");
  assert.match(route.prompt, /Q3 revenue rose 12% over Q2/);
  assert.match(route.prompt, /Question: what changed\?/);
  assert.equal(buildScreenshotPrompt("t", "q").includes('"""\nt\n"""'), true);
});

test("card scan preview reuses the OCR bridge (card fixture path)", () => {
  const fields = parseCardFields(
    ["Grace Hopper", "Navy Labs Inc", "grace@navy.example"].join("\n"),
  );
  assert.equal(fields.name, "Grace Hopper");
  assert.equal(fields.email, "grace@navy.example");
});
