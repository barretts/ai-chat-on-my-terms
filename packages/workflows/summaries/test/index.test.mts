import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_CAPS,
  artifactText,
  buildPrompt,
  parseSummarySource,
  runSummaryWorkflow,
  type GenerateOutcome,
} from "../src/index.ts";

test("prompt templates are fixture-stable (golden)", () => {
  assert.equal(
    buildPrompt("article-summary", {
      kind: "share-sheet",
      text: "article body here",
      title: "Kernel news",
    }),
    [
      "Summarize the article below.",
      "Requirements: one lead sentence, then at most 5 bullet points. Do not add facts that are not in the article.",
      "",
      "Source: Kernel news",
      '"""',
      "article body here",
      '"""',
    ].join("\n"),
  );
  assert.equal(
    buildPrompt("meeting-minutes", {
      kind: "transcript",
      text: "we agreed to ship monday",
    }),
    [
      "Turn the meeting material below into minutes.",
      "Sections: Decisions; Action items (owner, task, due date when stated); Open questions. Use only what was said in the material.",
      "",
      '"""',
      "we agreed to ship monday",
      '"""',
    ].join("\n"),
  );
  assert.equal(
    buildPrompt("speech-shrink", { kind: "transcript", text: "um so basically" }, {
      targetPercent: 25,
    }),
    [
      "Compress the spoken transcript below to about 25% of its original length. Keep every distinct fact and the speaker's meaning; remove filler, repetition and restatements.",
      "",
      '"""',
      "um so basically",
      '"""',
    ].join("\n"),
  );
});

test("share-sheet text and transcripts respect explicit source caps (step 2)", () => {
  assert.equal(
    parseSummarySource({
      kind: "share-sheet",
      text: "x".repeat(SOURCE_CAPS["share-sheet"]),
    }) !== null,
    true,
  );
  assert.equal(
    parseSummarySource({
      kind: "share-sheet",
      text: "x".repeat(SOURCE_CAPS["share-sheet"] + 1),
    }),
    null,
  );
  assert.equal(
    parseSummarySource({
      kind: "transcript",
      text: "x".repeat(SOURCE_CAPS.transcript),
    }) !== null,
    true,
  );
  assert.equal(
    parseSummarySource({
      kind: "transcript",
      text: "x".repeat(SOURCE_CAPS.transcript + 1),
    }),
    null,
  );
  assert.equal(parseSummarySource({ kind: "share-sheet", text: "" }), null);
  assert.equal(
    parseSummarySource({ kind: "share-sheet", text: "ok", file: "x.pdf" }),
    null,
  );
});

test("over-cap and empty sources surface named outcomes", async () => {
  const generate = async (): Promise<GenerateOutcome> => ({
    ok: true,
    text: "never",
  });
  const tooLong = await runSummaryWorkflow(
    "article-summary",
    { kind: "share-sheet", text: "x".repeat(SOURCE_CAPS["share-sheet"] + 1) },
    { modelClass: "q4-small", generate },
  );
  assert.deepEqual(tooLong, { ok: false, reason: "source-too-long" });
  const empty = await runSummaryWorkflow(
    "article-summary",
    { kind: "share-sheet", text: "" },
    { modelClass: "q4-small", generate },
  );
  assert.deepEqual(empty, { ok: false, reason: "source-empty" });
});

test("unavailable model is surfaced (smoke check 2)", async () => {
  const res = await runSummaryWorkflow(
    "meeting-minutes",
    { kind: "transcript", text: "material" },
    {
      modelClass: "q9-tiny-missing",
      async generate() {
        return { ok: false, reason: "model-unavailable" };
      },
    },
  );
  assert.deepEqual(res, { ok: false, reason: "model-unavailable" });
});

test("results are editable copy/share artifacts with source length (step 3)", async () => {
  const res = await runSummaryWorkflow(
    "speech-shrink",
    { kind: "transcript", text: "um so basically it works" },
    {
      modelClass: "q4-small",
      async generate(prompt, modelClass) {
        assert.match(prompt, /about 50%/);
        assert.equal(modelClass, "q4-small");
        return { ok: true, text: "it works" };
      },
    },
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.artifact, {
    workflow: "speech-shrink",
    format: "markdown",
    editable: true,
    sourceLength: "um so basically it works".length,
    text: "it works",
  });
  assert.equal(artifactText(res.artifact), "it works");
});
