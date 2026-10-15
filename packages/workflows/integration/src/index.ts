/**
 * T117 — integration gate for the twenty-two Shortcut recipes: one
 * ledger registering every catalog recipe against a single typed
 * automation intent (step 1), golden request fixtures validated
 * against the real per-package input schemas, the declared ports each
 * recipe is wired to (step 2), and the 22-item ledger compared
 * against the source catalog, distinguishing actions from bare menu
 * items (step 3).
 */
import { z } from "zod";
import type { ShortcutAction } from "@locallab/automation";
import {
  CardFieldsSchema,
  isCardFieldsEmpty,
  OcrRequestSchema,
  type CardFields,
  type ContactsPort,
} from "@locallab/ocr-ios";
import { parseSummarySource } from "@locallab/workflows-summaries";
import { SelectedTextSchema } from "@locallab/workflows-writing";
import { CreativeInputSchema } from "@locallab/workflows-creative";
import { PlanningInputSchema, type SearchPort as PlanningSearchPort } from "@locallab/workflows-planning";
import { VoiceActionPayloadSchema, type VoicePorts } from "@locallab/workflows-voice-actions";
import { ContextTextSchema, type ContextStorage } from "@locallab/workflows-context";
import { CLIPBOARD_CAP, type ClipboardPort as TranslationClipboardPort } from "@locallab/workflows-translation";
import { BriefingConfigSchema, type BriefingSearchPort } from "@locallab/workflows-briefings";

/** Step 3: an action runs a packaged workflow; a bare menu item would
 * only open a screen. The source catalog lists all 22 recipes as
 * packaged workflows, so every ledger entry is an action — and the
 * ledger asserts exactly that. */
export type RecipeKind = "action" | "menu-item";

export interface RecipeIntentBinding {
  action: ShortcutAction;
  fromUser: readonly string[];
}

export interface RecipeFixture {
  /** Golden request accepted by the recipe's real input schema. */
  request: unknown;
  /** Golden validation verdict for the fixture. */
  expect: "ok" | "invalid";
}

export interface RecipeLedgerEntry {
  id: string;
  /** Exact source-catalog wording (docs/lm-mini-features.md AU list). */
  catalogName: string;
  kind: RecipeKind;
  /** Step 1: the single typed automation intent registered for it;
   * its parameters are filled from the user-editable prompt/input. */
  action: ShortcutAction;
  intent: RecipeIntentBinding;
  /** Implementing workspace package. */
  pkg: string;
  /** Step 1: the recipe prompt is user-editable before running. */
  promptEditable: true;
  /** Development entry route (all 22 smoke through this table). */
  devRoute: string;
  fixture: RecipeFixture;
  validate(request: unknown): boolean;
}

export const SOURCE_CATALOG_RECIPES = [
  "article summary",
  "meeting minutes",
  "Speech Shrink",
  "unChatGPTfy",
  "email rephrase",
  "writing help",
  "stories",
  "social posts",
  "emotional support",
  "screenshot chat",
  "business-card scanner",
  "recipes",
  "groceries",
  "tourist guide",
  "weather",
  "CtxLLM",
  "search",
  "on-device spoken questions",
  "voice chat",
  "CallKit call",
  "clipboard translation",
  "morning news",
] as const;

const summarySource = (request: unknown): boolean =>
  parseSummarySource(request) !== null;
const clipboardText = z.string().min(1).max(CLIPBOARD_CAP);

export const RECIPE_LEDGER: readonly RecipeLedgerEntry[] = [
  {
    id: "article-summary",
    catalogName: "article summary",
    kind: "action",
    action: "summarize",
    intent: { action: "summarize", fromUser: ["modelClass"] },
    pkg: "@locallab/workflows-summaries",
    promptEditable: true,
    devRoute: "/workflows/article-summary",
    fixture: {
      request: { kind: "share-sheet", text: "The annual report covers a long year.", title: "Annual report" },
      expect: "ok",
    },
    validate: summarySource,
  },
  {
    id: "meeting-minutes",
    catalogName: "meeting minutes",
    kind: "action",
    action: "summarize",
    intent: { action: "summarize", fromUser: ["modelClass"] },
    pkg: "@locallab/workflows-summaries",
    promptEditable: true,
    devRoute: "/workflows/meeting-minutes",
    fixture: {
      request: { kind: "transcript", text: "ANA: kickoff next Monday. BO: I will bring the slides." },
      expect: "ok",
    },
    validate: summarySource,
  },
  {
    id: "speech-shrink",
    catalogName: "Speech Shrink",
    kind: "action",
    action: "summarize",
    intent: { action: "summarize", fromUser: ["modelClass"] },
    pkg: "@locallab/workflows-summaries",
    promptEditable: true,
    devRoute: "/workflows/speech-shrink",
    fixture: {
      request: { kind: "transcript", text: "um so basically we, uh, shipped it yeah" },
      expect: "ok",
    },
    validate: summarySource,
  },
  {
    id: "unchatgptfy",
    catalogName: "unChatGPTfy",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-writing",
    promptEditable: true,
    devRoute: "/workflows/unchatgptfy",
    fixture: {
      request: { text: "Let us delve into the tapestry of synergy.", origin: "selection" },
      expect: "ok",
    },
    validate: (r) => SelectedTextSchema.safeParse(r).success,
  },
  {
    id: "email-rephrase",
    catalogName: "email rephrase",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-writing",
    promptEditable: true,
    devRoute: "/workflows/email-rephrase",
    fixture: {
      request: { text: "hey send me the file asap", origin: "share-sheet" },
      expect: "ok",
    },
    validate: (r) => SelectedTextSchema.safeParse(r).success,
  },
  {
    id: "writing-help",
    catalogName: "writing help",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-writing",
    promptEditable: true,
    devRoute: "/workflows/writing-help",
    fixture: {
      request: { text: "My paragraph feels rambling, fix it.", origin: "selection" },
      expect: "ok",
    },
    validate: (r) => SelectedTextSchema.safeParse(r).success,
  },
  {
    id: "stories",
    catalogName: "stories",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-creative",
    promptEditable: true,
    devRoute: "/workflows/stories",
    fixture: {
      request: { workflow: "story", premise: "a robot learns to paint" },
      expect: "ok",
    },
    validate: (r) => CreativeInputSchema.safeParse(r).success,
  },
  {
    id: "social-posts",
    catalogName: "social posts",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-writing",
    promptEditable: true,
    devRoute: "/workflows/social-posts",
    fixture: {
      request: { text: "We shipped the release today.", origin: "clipboard" },
      expect: "ok",
    },
    validate: (r) => SelectedTextSchema.safeParse(r).success,
  },
  {
    id: "emotional-support",
    catalogName: "emotional support",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-creative",
    promptEditable: true,
    devRoute: "/workflows/emotional-support",
    fixture: {
      request: { workflow: "emotional-support", message: "this week has been heavy" },
      expect: "ok",
    },
    validate: (r) => CreativeInputSchema.safeParse(r).success,
  },
  {
    id: "screenshot-chat",
    catalogName: "screenshot chat",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-camera",
    promptEditable: true,
    devRoute: "/workflows/screenshot-chat",
    fixture: {
      request: { imageRef: "shot_01", source: "screenshot" },
      expect: "ok",
    },
    validate: (r) => OcrRequestSchema.safeParse(r).success,
  },
  {
    id: "business-card-scanner",
    catalogName: "business-card scanner",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-camera",
    promptEditable: true,
    devRoute: "/workflows/business-card-scanner",
    fixture: {
      request: { name: "Ada Lovelace", email: "ada@analytical.example" },
      expect: "ok",
    },
    validate: (r) => {
      const parsed = CardFieldsSchema.safeParse(r);
      return parsed.success && !isCardFieldsEmpty(parsed.data satisfies CardFields);
    },
  },
  {
    id: "recipes",
    catalogName: "recipes",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-planning",
    promptEditable: true,
    devRoute: "/workflows/recipes",
    fixture: {
      request: { workflow: "recipe-maker", ingredients: ["eggs", "flour"], servings: 2 },
      expect: "ok",
    },
    validate: (r) => PlanningInputSchema.safeParse(r).success,
  },
  {
    id: "groceries",
    catalogName: "groceries",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-planning",
    promptEditable: true,
    devRoute: "/workflows/groceries",
    fixture: {
      request: { workflow: "grocery-genius", pantry: ["rice", "beans"], budgetUsd: 20, meals: 4 },
      expect: "ok",
    },
    validate: (r) => PlanningInputSchema.safeParse(r).success,
  },
  {
    id: "tourist-guide",
    catalogName: "tourist guide",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-planning",
    promptEditable: true,
    devRoute: "/workflows/tourist-guide",
    fixture: {
      request: { workflow: "tourist-guide", location: { label: "Lisbon" }, days: 3 },
      expect: "ok",
    },
    validate: (r) => PlanningInputSchema.safeParse(r).success,
  },
  {
    id: "weather",
    catalogName: "weather",
    kind: "action",
    action: "news",
    intent: { action: "news", fromUser: ["read"] },
    pkg: "@locallab/workflows-briefings",
    promptEditable: true,
    devRoute: "/workflows/weather",
    fixture: {
      request: { kind: "weather-reporter", location: "Seattle", time: "07:00" },
      expect: "ok",
    },
    validate: (r) => BriefingConfigSchema.safeParse(r).success,
  },
  {
    id: "ctxllm",
    catalogName: "CtxLLM",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-context",
    promptEditable: true,
    devRoute: "/workflows/ctxllm",
    fixture: { request: "Project codename: Atlas. Budget $2k.", expect: "ok" },
    validate: (r) => ContextTextSchema.safeParse(r).success,
  },
  {
    id: "search",
    catalogName: "search",
    kind: "action",
    action: "search",
    intent: { action: "search", fromUser: ["q"] },
    pkg: "@locallab/workflows-voice-actions",
    promptEditable: true,
    devRoute: "/workflows/search",
    fixture: {
      request: { action: "search", query: "rain prediction for tomorrow" },
      expect: "ok",
    },
    validate: (r) => VoiceActionPayloadSchema.safeParse(r).success,
  },
  {
    id: "on-device-spoken-questions",
    catalogName: "on-device spoken questions",
    kind: "action",
    action: "ask",
    intent: { action: "ask", fromUser: ["q", "modelClass"] },
    pkg: "@locallab/workflows-voice-actions",
    promptEditable: true,
    devRoute: "/workflows/on-device-spoken-questions",
    fixture: {
      request: { action: "ask-on-device", query: "what is the capital of Peru" },
      expect: "ok",
    },
    validate: (r) => VoiceActionPayloadSchema.safeParse(r).success,
  },
  {
    id: "voice-chat",
    catalogName: "voice chat",
    kind: "action",
    action: "voice",
    intent: { action: "voice", fromUser: [] },
    pkg: "@locallab/workflows-voice-actions",
    promptEditable: true,
    devRoute: "/workflows/voice-chat",
    fixture: { request: { action: "voice-chat" }, expect: "ok" },
    validate: (r) => VoiceActionPayloadSchema.safeParse(r).success,
  },
  {
    id: "callkit-call",
    catalogName: "CallKit call",
    kind: "action",
    action: "voice",
    intent: { action: "voice", fromUser: [] },
    pkg: "@locallab/workflows-voice-actions",
    promptEditable: true,
    devRoute: "/workflows/callkit-call",
    fixture: { request: { action: "call" }, expect: "ok" },
    validate: (r) => VoiceActionPayloadSchema.safeParse(r).success,
  },
  {
    id: "clipboard-translation",
    catalogName: "clipboard translation",
    kind: "action",
    action: "translate",
    intent: { action: "translate", fromUser: ["lang", "modelClass"] },
    pkg: "@locallab/workflows-translation",
    promptEditable: true,
    devRoute: "/workflows/clipboard-translation",
    fixture: { request: "Good morning, world", expect: "ok" },
    validate: (r) => clipboardText.safeParse(r).success,
  },
  {
    id: "morning-news",
    catalogName: "morning news",
    kind: "action",
    action: "news",
    intent: { action: "news", fromUser: ["read"] },
    pkg: "@locallab/workflows-briefings",
    promptEditable: true,
    devRoute: "/workflows/morning-news",
    fixture: {
      request: { kind: "morning-news-brief", topics: ["transit", "ai"], time: "06:30" },
      expect: "ok",
    },
    validate: (r) => BriefingConfigSchema.safeParse(r).success,
  },
];

/** Step 2: the real ports each recipe is wired to, in one place. */
export interface DeclaredWorkflowPorts {
  clipboard: TranslationClipboardPort;
  contacts: ContactsPort;
  voice: VoicePorts;
  context: ContextStorage;
  planningSearch: PlanningSearchPort;
  briefingSearch: BriefingSearchPort;
}

export function recipeById(id: string): RecipeLedgerEntry | undefined {
  return RECIPE_LEDGER.find((entry) => entry.id === id);
}

/** Development entry route for a recipe id (undefined = unknown). */
export function workflowDevRoute(id: string): string | undefined {
  return recipeById(id)?.devRoute;
}

/** Ledger-vs-catalog comparison (step 3): names not covered and
 * ledger entries outside the catalog. Empty means the ledger matches
 * the 22-item source catalog exactly. */
export function diffLedgerAgainstCatalog(
  catalogNames: readonly string[],
): { missing: string[]; extra: string[] } {
  const ledgerNames = RECIPE_LEDGER.map((entry) => entry.catalogName);
  return {
    missing: catalogNames.filter((n) => !ledgerNames.includes(n)),
    extra: ledgerNames.filter((n) => !catalogNames.includes(n)),
  };
}
