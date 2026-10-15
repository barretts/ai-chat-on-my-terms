/**
 * T117B — writing/rewriting recipes: unChatGPTfy, Rephrase Email,
 * Help Me Write and Social Media AI. The selected text is preserved
 * verbatim, the rewrite is previewed, and the clipboard is only
 * overwritten on an explicit user action; tone and Persona are user
 * settings, never defaults smuggled in (step 3).
 */
import { z } from "zod";

export const WRITING_WORKFLOWS = [
  "unchatgptfy",
  "rephrase-email",
  "help-me-write",
  "social-media",
] as const;
export type WritingWorkflow = (typeof WRITING_WORKFLOWS)[number];
export const WritingWorkflowSchema = z.enum(WRITING_WORKFLOWS);

/** iPhone selection/share payload: the user's own text, preserved. */
export const SelectedTextSchema = z
  .object({
    text: z.string().min(1).max(8000),
    origin: z.enum(["selection", "share-sheet", "clipboard"]),
  })
  .strict();
export type SelectedText = z.infer<typeof SelectedTextSchema>;

export const TONES = ["neutral", "formal", "friendly", "direct"] as const;
export type Tone = (typeof TONES)[number];
export const ToneSchema = z.enum(TONES);

/** Persona is the existing chat Persona (name + instruction), opt-in. */
const personaSchema = z
  .object({
    name: z.string().min(1).max(64),
    instruction: z.string().min(1).max(2000),
  })
  .strict();

const templates: Record<WritingWorkflow, string> = {
  unchatgptfy:
    "Rewrite the text below so it reads like the author wrote it by hand: plain vocabulary, varied sentence rhythm, no filler phrases and no marketing tone. Keep the meaning and facts identical.",
  "rephrase-email":
    "Rephrase the email below: stay brief and courteous, keep every request and commitment, and do not invent new details.",
  "help-me-write":
    "Draft what the user is trying to say from the notes below. If the intent is unclear, ask one clarifying question instead of guessing.",
  "social-media":
    "Write short social-media variants of the text below: one 280-character variant, one slightly longer variant. No hashtags unless the source already used them.",
};

function personaLine(persona: z.infer<typeof personaSchema> | undefined) {
  return persona === undefined
    ? ""
    : `Adopt this persona: ${persona.name} — ${persona.instruction}\n`;
}

export function buildPrompt(
  workflow: WritingWorkflow,
  source: SelectedText,
  options: {
    tone?: Tone;
    persona?: z.infer<typeof personaSchema>;
    instruction?: string;
  } = {},
): string {
  const tone = options.tone ?? "neutral";
  const extra =
    options.instruction === undefined || options.instruction.trim() === ""
      ? ""
      : `User instruction: ${options.instruction.trim()}\n`;
  return [
    templates[workflow],
    `Tone: ${tone}.`,
    personaLine(options.persona),
    extra,
    `Original text (keep it; the output will be previewed before any copy-back):\n"""\n${source.text}\n"""`,
  ].join("\n");
}

/* ---------------- preview + gated clipboard (step 2) ---------------- */

export interface WritingArtifact {
  workflow: WritingWorkflow;
  originalText: string;
  preview: string;
  appliedTone: Tone;
  editable: true;
}

export type RunResult =
  | { ok: true; artifact: WritingArtifact }
  | { ok: false; reason: "source-empty" | "source-too-long" | "model-unavailable" };

export async function runWritingWorkflow(
  workflow: WritingWorkflow,
  source: unknown,
  options: {
    modelClass: string;
    generate(prompt: string, modelClass: string): Promise<{ ok: true; text: string } | { ok: false; reason: "model-unavailable" }>;
    tone?: Tone;
    persona?: z.infer<typeof personaSchema>;
    instruction?: string;
  },
): Promise<RunResult> {
  const parsed = SelectedTextSchema.safeParse(source);
  if (!parsed.success) {
    if (
      typeof source === "object" &&
      source !== null &&
      "text" in source &&
      typeof source.text === "string"
    )
      return source.text.length === 0
        ? { ok: false, reason: "source-empty" }
        : { ok: false, reason: "source-too-long" };
    return { ok: false, reason: "source-empty" };
  }
  const prompt = buildPrompt(workflow, parsed.data, {
    ...(options.tone !== undefined ? { tone: options.tone } : {}),
    ...(options.persona !== undefined ? { persona: options.persona } : {}),
    ...(options.instruction !== undefined
      ? { instruction: options.instruction }
      : {}),
  });
  const outcome = await options.generate(prompt, options.modelClass);
  if (!outcome.ok) return { ok: false, reason: "model-unavailable" };
  return {
    ok: true,
    artifact: {
      workflow,
      originalText: parsed.data.text,
      preview: outcome.text,
      appliedTone: options.tone ?? "neutral",
      editable: true,
    },
  };
}

/** Clipboard write happens ONLY after the user taps "copy" on the
 * preview; anything else leaves the clipboard untouched. */
export interface ClipboardPort {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export async function commitPreviewToClipboard(
  artifact: WritingArtifact,
  clipboard: ClipboardPort,
  userConfirmed: boolean,
): Promise<boolean> {
  if (!userConfirmed) return false;
  await clipboard.write(artifact.preview);
  return true;
}
