/**
 * T117C — story and support recipes: AI Story Generator and Emotional
 * Support AI, run through the ordinary local chat path (Persona-capable
 * prompts, provider/model selection stays in the normal provider UI —
 * these workflows never pick a provider themselves). Context is
 * retained only if the user opts in (step 3); by default each run is
 * isolated.
 */
import { z } from "zod";

export const CREATIVE_WORKFLOWS = ["story", "emotional-support"] as const;
export type CreativeWorkflow = (typeof CREATIVE_WORKFLOWS)[number];
export const CreativeWorkflowSchema = z.enum(CREATIVE_WORKFLOWS);

const personaSchema = z
  .object({
    name: z.string().min(1).max(64),
    instruction: z.string().min(1).max(2000),
  })
  .strict();

const genreSchema = z.string().min(1).max(40);

export const CreativeInputSchema = z.discriminatedUnion("workflow", [
  z
    .object({
      workflow: z.literal("story"),
      premise: z.string().min(1).max(2000),
      genre: genreSchema.optional(),
      audienceAge: z.number().int().min(3).max(99).optional(),
      persona: personaSchema.optional(),
    })
    .strict(),
  z
    .object({
      workflow: z.literal("emotional-support"),
      message: z.string().min(1).max(4000),
      persona: personaSchema.optional(),
    })
    .strict(),
]);
export type CreativeInput = z.infer<typeof CreativeInputSchema>;

/** Step 1: local Persona-capable chat prompts (support prompts stay
 * non-clinical and point to professional help for crisis wording). */
export function buildPrompt(input: CreativeInput): string {
  const personaLine =
    "persona" in input && input.persona !== undefined
      ? `Adopt this persona: ${input.persona.name} — ${input.persona.instruction}\n`
      : "";
  if (input.workflow === "story") {
    const genre = input.genre === undefined ? "" : `Genre: ${input.genre}.\n`;
    const age =
      input.audienceAge === undefined
        ? ""
        : `Write for a reader aged ${input.audienceAge}.\n`;
    return `${personaLine}${genre}${age}Write a short original story (max 600 words) from this premise. End cleanly.\n\nPremise:\n"""\n${input.premise}\n"""`;
  }
  return `${personaLine}Respond as a supportive, grounded local assistant. Listen first, keep it brief and concrete, do not diagnose, and if the person describes risk to themselves, say plainly that professional or crisis support is the right step. Do not pretend to be a therapist.\n\nTheir message:\n"""\n${input.message}\n"""`;
}

/* ---------------- isolated-by-default context (steps 2–3) ---------------- */

export interface ContextPort {
  append(entry: { workflow: CreativeWorkflow; prompt: string; reply: string }): Promise<void>;
}

export type CreativeResult =
  | { ok: true; reply: string; retained: boolean }
  | { ok: false; reason: "model-unavailable" | "invalid-input" };

export async function runCreativeWorkflow(
  input: unknown,
  options: {
    modelClass: string;
    generate(prompt: string, modelClass: string): Promise<{ ok: true; text: string } | { ok: false; reason: "model-unavailable" }>;
    /** Step 3: context is saved ONLY when the user opted in. */
    saveContext?: boolean;
    context?: ContextPort;
  },
): Promise<CreativeResult> {
  const parsed = CreativeInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input" };
  const prompt = buildPrompt(parsed.data);
  const outcome = await options.generate(prompt, options.modelClass);
  if (!outcome.ok) return { ok: false, reason: "model-unavailable" };
  const retained = options.saveContext === true;
  if (retained && options.context !== undefined)
    await options.context.append({
      workflow: parsed.data.workflow,
      prompt,
      reply: outcome.text,
    });
  return { ok: true, reply: outcome.text, retained };
}
