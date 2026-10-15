/**
 * T117G (AU-07) — CtxLLM context recipe: context rides on chat runs
 * and persists across runs until the user clears it. Storage is the
 * app's own file/variable (the host injects a storage port); this
 * module never syncs temp context anywhere off-device — there is no
 * network seam at all here.
 */
import { z } from "zod";

export const ContextTextSchema = z.string().min(1).max(20000);
export const QuestionSchema = z.string().min(1).max(4000);

export interface ContextStorage {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ContextRunResult {
  prompt: string;
  reply: string;
}

export function buildContextualPrompt(
  context: string | null,
  question: string,
): string {
  if (context === null || context.length === 0) return question;
  return `Use the retained context to answer. If the context does not cover the question, say so.\n\nRetained context:\n"""\n${context}\n"""\n\nQuestion: ${question}`;
}

export type ContextOutcome =
  | ContextRunResult
  | { ok: false; reason: "model-unavailable" | "invalid-input" };

export async function runWithContext(
  question: unknown,
  options: {
    storage: ContextStorage;
    modelClass: string;
    generate(
      prompt: string,
      modelClass: string,
    ): Promise<{ ok: true; text: string } | { ok: false; reason: "model-unavailable" }>;
  },
): Promise<ContextOutcome> {
  const q = QuestionSchema.safeParse(question);
  if (!q.success) return { ok: false, reason: "invalid-input" };
  const context = await options.storage.load();
  const prompt = buildContextualPrompt(context, q.data);
  const outcome = await options.generate(prompt, options.modelClass);
  if (!outcome.ok) return outcome;
  return { prompt, reply: outcome.text };
}

/** Setting/updating context is always an explicit user action. */
export async function setContext(
  text: unknown,
  storage: ContextStorage,
): Promise<boolean> {
  const parsed = ContextTextSchema.safeParse(text);
  if (!parsed.success) return false;
  await storage.save(parsed.data);
  return true;
}

/** User-initiated clear (smoke 2). */
export async function clearContext(storage: ContextStorage): Promise<void> {
  await storage.clear();
}

export async function readContext(
  storage: ContextStorage,
): Promise<string | null> {
  return await storage.load();
}
