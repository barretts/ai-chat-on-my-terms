/**
 * T116 (AU-03, AU-04) — iOS App Intents bridge contract: the named
 * Siri / Action Button / Share Sheet entry points the Swift AppIntents
 * extension registers, and the payloads each one may carry. Swift side
 * is compiled into the Apple build (T159E); this contract is the
 * single source of truth both sides assert against.
 */
import { z } from "zod";
import {
  SHORTCUT_ACTIONS,
  type ShortcutAction,
} from "@locallab/automation";

/** AU-03 entry-point families. */
export const ENTRY_POINTS = [
  "siri",
  "action-button",
  "share-sheet",
  "widget",
  "scheduled",
] as const;
export type EntryPoint = (typeof ENTRY_POINTS)[number];

/** AU-04: the six App Intents the extension exposes. */
export const APP_INTENT_NAMES = [
  "LocalLabAskIntent",
  "LocalLabSearchIntent",
  "LocalLabVoiceIntent",
  "LocalLabSummarizeIntent",
  "LocalLabTranslateIntent",
  "LocalLabNewsIntent",
] as const;
export type AppIntentName = (typeof APP_INTENT_NAMES)[number];

const intentToAction: Record<AppIntentName, ShortcutAction> = {
  LocalLabAskIntent: "ask",
  LocalLabSearchIntent: "search",
  LocalLabVoiceIntent: "voice",
  LocalLabSummarizeIntent: "summarize",
  LocalLabTranslateIntent: "translate",
  LocalLabNewsIntent: "news",
};

export const AppIntentNameSchema = z.enum(APP_INTENT_NAMES);

export function actionForIntent(name: AppIntentName): ShortcutAction {
  return intentToAction[name];
}

/** Share Sheet payload (AU-03): plain text only, bounded, and it can
 * only run after an interactive foreground review — the same rule
 * `@locallab/automation`'s runner enforces (step 3). */
export const ShareSheetPayloadSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(20000)
      .refine((v) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v), "control chars refused"),
    contentType: z.enum(["text/plain"]),
  })
  .strict();
export type ShareSheetPayload = z.infer<typeof ShareSheetPayloadSchema>;

/** Intent names that consume a Share Sheet import (must show the
 * review sheet before running). */
export function requiresForegroundReview(name: AppIntentName): boolean {
  const action = intentToAction[name];
  return (
    action === "summarize" ||
    action === "translate" ||
    action === "voice"
  );
}

/** Every declared intent name maps onto a parsed shortcut action, and
 * every action has exactly one intent. */
export const INTENT_COUNT = APP_INTENT_NAMES.length;
export const ACTION_COUNT = SHORTCUT_ACTIONS.length;
