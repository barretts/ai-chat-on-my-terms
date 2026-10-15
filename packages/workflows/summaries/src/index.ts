/**
 * T117A (AU-03) — packaged summary workflows: article summary,
 * meeting minutes and Speech Shrink. A workflow is prompt template +
 * bounded source + editable artifact; the model runs through the
 * injected seam, and an unavailable model is surfaced as a named
 * outcome (never a silently missing answer).
 */
import { z } from "zod";

export const SUMMARY_WORKFLOWS = [
  "article-summary",
  "meeting-minutes",
  "speech-shrink",
] as const;
export type SummaryWorkflow = (typeof SUMMARY_WORKFLOWS)[number];

export const SummaryWorkflowSchema = z.enum(SUMMARY_WORKFLOWS);

/** Step 2: explicit per-source length caps. Over-cap sources are
 * refused (no silent truncation of the user's material). */
export const SOURCE_CAPS = {
  "share-sheet": 20000,
  transcript: 60000,
} as const;

const sourceSchemas = {
  "share-sheet": z
    .object({
      kind: z.literal("share-sheet"),
      text: z.string().min(1).max(SOURCE_CAPS["share-sheet"]),
      title: z.string().min(1).max(200).optional(),
    })
    .strict(),
  transcript: z
    .object({
      kind: z.literal("transcript"),
      text: z.string().min(1).max(SOURCE_CAPS.transcript),
      title: z.string().min(1).max(200).optional(),
    })
    .strict(),
} as const;
export type SummarySource = z.infer<
  (typeof sourceSchemas)[keyof typeof sourceSchemas]
>;

export function parseSummarySource(source: unknown): SummarySource | null {
  const kind =
    typeof source === "object" &&
    source !== null &&
    "kind" in source &&
    source.kind === "transcript"
      ? "transcript"
      : "share-sheet";
  const parsed = sourceSchemas[kind].safeParse(source);
  return parsed.success ? (parsed.data as SummarySource) : null;
}

const TARGET_PERCENTS = [25, 50] as const;
export type SpeechShrinkTarget = (typeof TARGET_PERCENTS)[number];

function sourceBlock(source: SummarySource): string {
  const heading =
    source.title === undefined ? "" : `Source: ${source.title}\n`;
  return `${heading}"""\n${source.text}\n"""`;
}

/** Step 1: the three prompt templates (golden-fixture stable). */
export function buildPrompt(
  workflow: SummaryWorkflow,
  source: SummarySource,
  options: { targetPercent?: SpeechShrinkTarget } = {},
): string {
  const block = sourceBlock(source);
  switch (workflow) {
    case "article-summary":
      return `Summarize the article below.\nRequirements: one lead sentence, then at most 5 bullet points. Do not add facts that are not in the article.\n\n${block}`;
    case "meeting-minutes":
      return `Turn the meeting material below into minutes.\nSections: Decisions; Action items (owner, task, due date when stated); Open questions. Use only what was said in the material.\n\n${block}`;
    case "speech-shrink": {
      const percent = options.targetPercent ?? 50;
      return `Compress the spoken transcript below to about ${percent}% of its original length. Keep every distinct fact and the speaker's meaning; remove filler, repetition and restatements.\n\n${block}`;
    }
  }
}

/* ---------------- run seam + artifacts (steps 2–3) ---------------- */

export type GenerateOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: "model-unavailable" };

export type WorkflowResult =
  | { ok: true; artifact: WorkflowArtifact }
  | { ok: false; reason: "source-too-long" | "source-empty" | "model-unavailable" };

/** Step 3: copy/share artifacts are plain editable text the user can
 * review before sending anywhere. */
export interface WorkflowArtifact {
  workflow: SummaryWorkflow;
  format: "markdown";
  editable: true;
  sourceLength: number;
  text: string;
}

export async function runSummaryWorkflow(
  workflow: SummaryWorkflow,
  source: unknown,
  options: {
    modelClass: string;
    generate(prompt: string, modelClass: string): Promise<GenerateOutcome>;
    targetPercent?: SpeechShrinkTarget;
  },
): Promise<WorkflowResult> {
  const parsed = parseSummarySource(source);
  if (parsed === null) {
    // Distinguish the two input failures for honest UI messaging.
    if (
      typeof source === "object" &&
      source !== null &&
      "text" in source &&
      typeof source.text === "string"
    ) {
      return source.text.length === 0
        ? { ok: false, reason: "source-empty" }
        : { ok: false, reason: "source-too-long" };
    }
    return { ok: false, reason: "source-empty" };
  }
  const prompt = buildPrompt(workflow, parsed, {
    ...(options.targetPercent !== undefined
      ? { targetPercent: options.targetPercent }
      : {}),
  });
  const outcome = await options.generate(prompt, options.modelClass);
  if (!outcome.ok) return { ok: false, reason: "model-unavailable" };
  return {
    ok: true,
    artifact: {
      workflow,
      format: "markdown",
      editable: true,
      sourceLength: parsed.text.length,
      text: outcome.text,
    },
  };
}

/** Copy/share surface: the artifact's full text goes to the clipboard
 * / share sheet verbatim (it stays editable on the host sheet). */
export function artifactText(artifact: WorkflowArtifact): string {
  return artifact.text;
}
