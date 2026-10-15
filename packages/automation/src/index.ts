/**
 * T116 (AU-04, AU-05) — typed deep-link automation for the Shortcuts /
 * App Intents family. AU-05's family is `locallab://shortcut/...` (this
 * project's scheme; the original product's brand is never used).
 *
 * Invariant (card smoke 2): a malformed or untrusted URL parses to null
 * and can never reach a service — the parser is strict per action
 * (unknown action, unknown parameter, over-long or percent-encoded
 * values all refuse), so a hostile link cannot name a tool, smuggle a
 * secret parameter, or execute anything.
 */
import { z } from "zod";

export const SHORTCUT_ACTIONS = [
  "ask",
  "search",
  "voice",
  "summarize",
  "translate",
  "news",
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

const modelClassSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/);
const langSchema = z.string().regex(/^[a-z][a-z-]{1,7}$/);
const freeText = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => !value.includes("%"), "percent-encoding refused");
const searchText = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("%"), "percent-encoding refused");

const intentSchemas = {
  ask: z
    .object({
      action: z.literal("ask"),
      q: freeText,
      modelClass: modelClassSchema.optional(),
    })
    .strict(),
  search: z
    .object({ action: z.literal("search"), q: searchText })
    .strict(),
  voice: z.object({ action: z.literal("voice") }).strict(),
  summarize: z
    .object({
      action: z.literal("summarize"),
      modelClass: modelClassSchema.optional(),
    })
    .strict(),
  translate: z
    .object({
      action: z.literal("translate"),
      lang: langSchema,
      modelClass: modelClassSchema.optional(),
    })
    .strict(),
  news: z
    .object({ action: z.literal("news"), read: z.boolean().default(false) })
    .strict(),
} as const;

export type ShortcutIntent = z.infer<(typeof intentSchemas)[ShortcutAction]>;

const MAX_QUERY_PAIRS = 8;

const actionParams: Record<ShortcutAction, readonly string[]> = {
  ask: ["q", "modelClass"],
  search: ["q"],
  voice: [],
  summarize: ["modelClass"],
  translate: ["lang", "modelClass"],
  news: ["read"],
};

/** Parse `locallab://shortcut/<action>?params` into a typed intent, or
 * null for anything malformed/untrusted. */
export function parseShortcutUrl(url: string): ShortcutIntent | null {
  const match = /^locallab:\/\/shortcut\/([a-z-]+)(?:\?(.*))?$/.exec(url);
  if (match === null) return null;
  const [, action, query] = match;
  if (!(SHORTCUT_ACTIONS as readonly string[]).includes(action ?? ""))
    return null;
  const params: Record<string, string> = {};
  if (query !== undefined && query !== "") {
    const pairs = query.split("&");
    if (pairs.length > MAX_QUERY_PAIRS) return null;
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq <= 0) return null;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (key in params) return null;
      params[key] = value;
    }
  }
  for (const key of Object.keys(params))
    if (!actionParams[action as ShortcutAction].includes(key)) return null;
  const shape =
    intentSchemas[action as ShortcutAction] ??
    (null as null | (typeof intentSchemas)[ShortcutAction]);
  if (shape === null) return null;
  const candidate: Record<string, unknown> = { action };
  if ("q" in params) candidate.q = params.q;
  if ("modelClass" in params) candidate.modelClass = params.modelClass;
  if ("lang" in params) candidate.lang = params.lang;
  if ("read" in params) {
    if (!["true", "false"].includes(params.read ?? "")) return null;
    candidate.read = params.read === "true";
  }
  const parsed = shape.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Canonical JSON form shared with the desktop companion CLI (the two
 * implementations assert byte-identical fixtures in their tests). */
export function serializeIntent(intent: ShortcutIntent): string {
  const fields: Record<string, unknown> = { action: intent.action };
  if (intent.action === "ask" || intent.action === "search")
    fields.q = intent.q;
  if (intent.action === "translate") fields.lang = intent.lang;
  if (
    (intent.action === "ask" ||
      intent.action === "summarize" ||
      intent.action === "translate") &&
    intent.modelClass !== undefined
  )
    fields.modelClass = intent.modelClass;
  if (intent.action === "news") fields.read = intent.read;
  return JSON.stringify(fields);
}

/* ---------------- execution seam (smoke 1, step 3) ---------------- */

export type VoicePermission = "granted" | "denied" | "undetermined";

export interface ShortcutServices {
  ask(q: string, modelClass: string | null): Promise<void>;
  search(q: string): Promise<void>;
  voice(): Promise<void>;
  summarize(text: string, modelClass: string | null): Promise<void>;
  translate(text: string, lang: string): Promise<void>;
  news(read: boolean): Promise<void>;
  voicePermission(): VoicePermission;
  /** Last Share Sheet import awaiting review; null when none. */
  sharedImport(): string | null;
}

export type RunResult =
  | { status: "done" }
  | { status: "refused"; reason: string }
  | { status: "review-required"; reason: "share-import" | "voice-permission" };

/**
 * Step 3: sensitive imports (Share Sheet text feeding summarize /
 * translate) and unavailable voice permission require an interactive
 * foreground confirmation; nothing sensitive runs from a background
 * launch.
 */
export function createShortcutRunner(options: {
  services: ShortcutServices;
}) {
  const services = options.services;
  return {
    async runUrl(
      url: string,
      context: { foreground: boolean },
    ): Promise<RunResult> {
      const intent = parseShortcutUrl(url);
      if (intent === null) return { status: "refused", reason: "malformed" };
      switch (intent.action) {
        case "ask":
          await services.ask(intent.q, intent.modelClass ?? null);
          return { status: "done" };
        case "search":
          await services.search(intent.q);
          return { status: "done" };
        case "voice": {
          const permission = services.voicePermission();
          if (permission === "denied")
            return { status: "refused", reason: "voice-denied" };
          if (permission !== "granted")
            return {
              status: "review-required",
              reason: "voice-permission",
            };
          await services.voice();
          return { status: "done" };
        }
        case "summarize": {
          const text = reviewedImport(services, context.foreground);
          if (text === null)
            return context.foreground
              ? { status: "refused", reason: "no-import" }
              : { status: "review-required", reason: "share-import" };
          await services.summarize(text, intent.modelClass ?? null);
          return { status: "done" };
        }
        case "translate": {
          const text = reviewedImport(services, context.foreground);
          if (text === null)
            return context.foreground
              ? { status: "refused", reason: "no-import" }
              : { status: "review-required", reason: "share-import" };
          await services.translate(text, intent.lang);
          return { status: "done" };
        }
        case "news":
          await services.news(intent.read);
          return { status: "done" };
      }
    },
  };
}

function reviewedImport(
  services: ShortcutServices,
  foreground: boolean,
): string | null {
  if (!foreground) return null;
  const text = services.sharedImport();
  if (text === null || text.trim() === "" || text.length > 20000) return null;
  return text.trim();
}
