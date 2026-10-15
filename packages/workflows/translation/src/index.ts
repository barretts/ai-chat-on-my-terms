/**
 * T117G (AU-07) — Translate Clipboard recipe: validates the
 * clipboard read, translates with the selected local model, and only
 * writes the result back on success — a failed translation leaves the
 * clipboard untouched.
 */
import { z } from "zod";

export const CLIPBOARD_CAP = 10000;

export interface ClipboardPort {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

const targetLangSchema = z.string().regex(/^[a-z][a-z-]{1,7}$/);

export function buildTranslationPrompt(text: string, targetLang: string): string {
  return `Translate the text below to the language coded "${targetLang}". Preserve layout, numbers and names. Output ONLY the translation.\n\n"""\n${text}\n"""`;
}

export type TranslateResult =
  | { ok: true; translated: string; wroteBack: true }
  | {
      ok: false;
      reason:
        | "empty-clipboard"
        | "too-long"
        | "model-unavailable"
        | "empty-output" | "invalid-input";
    };

export async function translateClipboard(
  targetLang: unknown,
  options: {
    clipboard: ClipboardPort;
    modelClass: string;
    generate(
      prompt: string,
      modelClass: string,
    ): Promise<{ ok: true; text: string } | { ok: false; reason: "model-unavailable" }>;
  },
): Promise<TranslateResult> {
  const lang = targetLangSchema.safeParse(targetLang);
  if (!lang.success) return { ok: false, reason: "invalid-input" };
  const raw = await options.clipboard.read();
  if (raw === null || raw.trim().length === 0)
    return { ok: false, reason: "empty-clipboard" };
  if (raw.length > CLIPBOARD_CAP) return { ok: false, reason: "too-long" };
  const outcome = await options.generate(
    buildTranslationPrompt(raw, lang.data),
    options.modelClass,
  );
  if (!outcome.ok) return { ok: false, reason: "model-unavailable" };
  const translated = outcome.text.trim();
  if (translated.length === 0) return { ok: false, reason: "empty-output" };
  await options.clipboard.write(translated);
  return { ok: true, translated, wroteBack: true };
}
