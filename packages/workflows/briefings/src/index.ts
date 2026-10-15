/**
 * T117H — Weather Reporter and Morning News Brief recipes: topics,
 * schedule time and voice are user-set inputs; live sources are only
 * fetched through an ENABLED search provider (the offline path says
 * so explicitly); notifications are only scheduled when the user
 * opted in; briefings are cached with a source-freshness stamp.
 */
import { z } from "zod";

export const BRIEFING_KINDS = ["weather-reporter", "morning-news-brief"] as const;
export type BriefingKind = (typeof BRIEFING_KINDS)[number];

const timeOfDay = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

export const BriefingConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("weather-reporter"),
      location: z.string().min(1).max(100),
      time: timeOfDay,
      voice: z.boolean().default(false),
      notify: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("morning-news-brief"),
      topics: z.array(z.string().min(1).max(40)).min(1).max(6),
      time: timeOfDay,
      voice: z.boolean().default(false),
      notify: z.boolean().default(false),
    })
    .strict(),
]);
export type BriefingConfig = z.input<typeof BriefingConfigSchema>;
export type ParsedBriefingConfig = z.output<typeof BriefingConfigSchema>;
export type BriefingKeyInput =
  | { kind: "weather-reporter"; location: string; time: string }
  | { kind: "morning-news-brief"; topics: readonly string[]; time: string };

/** Stable cache/schedule key. */
export function briefingKey(config: BriefingKeyInput): string {
  return config.kind === "weather-reporter"
    ? `weather-reporter:${config.location}:${config.time}`
    : `morning-news-brief:${config.topics.join(",")}:${config.time}`;
}
export function buildBriefingPrompt(
  config: BriefingKeyInput,
  sources: readonly string[],
): string {
  const sourceBlock =
    sources.length === 0
      ? "No live sources are available; clearly state that live data is missing and keep the brief general."
      : `Live sources:\n- ${sources.join("\n- ")}`;
  if (config.kind === "weather-reporter")
    return `Write a short weather-style briefing for ${config.location} at ${config.time}. Never invent measurements; label anything without live data as unconfirmed. ${sourceBlock}`;
  return `Write a morning news brief at ${config.time} covering: ${config.topics.join(", ")}. Never invent events; label anything without live data as unconfirmed. ${sourceBlock}`;
}

/* ---------------- search-gated sources (step 2) ---------------- */

export interface BriefingSearchPort {
  search(query: string): Promise<string[]>;
}

export type BriefingSources =
  | { available: true; provider: true; items: string[] }
  | { available: false; notice: "search-not-enabled" };

export async function gatherBriefingSources(
  config: ParsedBriefingConfig,
  options: { searchEnabled: boolean; search?: BriefingSearchPort },
): Promise<BriefingSources> {
  const port = options.search;
  if (!options.searchEnabled || port === undefined)
    return { available: false, notice: "search-not-enabled" };
  const query =
    config.kind === "weather-reporter"
      ? `weather forecast for ${config.location}`
      : `news about ${config.topics.join(", ")}`;
  const items = await port.search(query);
  return { available: true, provider: true, items };
}

/* ---------------- cache with freshness (step 3) ---------------- */

export interface CachedBriefing {
  text: string;
  voice: boolean;
  sources: BriefingSources;
  generatedAt: number;
}

export type CacheRead =
  | { state: "fresh"; briefing: CachedBriefing }
  | { state: "stale"; briefing: CachedBriefing }
  | { state: "none" };

export interface BriefingCache {
  read(key: string, now: number): CacheRead;
  write(key: string, briefing: CachedBriefing): void;
}

export function createMemoryBriefingCache(maxAgeMs: number): BriefingCache {
  const entries = new Map<string, CachedBriefing>();
  return {
    read(key, now) {
      const found = entries.get(key);
      if (found === undefined) return { state: "none" };
      return now - found.generatedAt <= maxAgeMs
        ? { state: "fresh", briefing: found }
        : { state: "stale", briefing: found };
    },
    write(key, briefing) {
      entries.set(key, briefing);
    },
  };
}

/* ---------------- user-opted notifications (step 3) ---------------- */

export interface NotificationPort {
  schedule(key: string, time: string): Promise<void>;
}

/* ---------------- run seam ---------------- */

export type BriefingOutcome =
  | {
      ok: true;
      fromCache: boolean;
      cacheState: "fresh" | "stored";
      brief: CachedBriefing;
      scheduled: boolean;
    }
  | { ok: false; reason: "model-unavailable" | "invalid-input" };

export async function runBriefing(
  config: unknown,
  options: {
    modelClass: string;
    generate(
      prompt: string,
      modelClass: string,
    ): Promise<{ ok: true; text: string } | { ok: false; reason: "model-unavailable" }>;
    searchEnabled: boolean;
    search?: BriefingSearchPort;
    cache: BriefingCache;
    notifications?: NotificationPort;
    now: number;
  },
): Promise<BriefingOutcome> {
  const parsed = BriefingConfigSchema.safeParse(config);
  if (!parsed.success) return { ok: false, reason: "invalid-input" };
  const cfg = parsed.data;
  const key = briefingKey(cfg);
  const cached = options.cache.read(key, options.now);
  if (cached.state === "fresh") {
    return {
      ok: true,
      fromCache: true,
      cacheState: "fresh",
      brief: cached.briefing,
      scheduled: false,
    };
  }
  const sources = await gatherBriefingSources(cfg, {
    searchEnabled: options.searchEnabled,
    ...(options.search !== undefined ? { search: options.search } : {}),
  });
  const outcome = await options.generate(
    buildBriefingPrompt(cfg, sources.available ? sources.items : []),
    options.modelClass,
  );
  if (!outcome.ok) return { ok: false, reason: "model-unavailable" };
  const brief: CachedBriefing = {
    text: outcome.text,
    voice: cfg.voice,
    sources,
    generatedAt: options.now,
  };
  options.cache.write(key, brief);
  const scheduled =
    cfg.notify && options.notifications !== undefined
      ? (await options.notifications.schedule(key, cfg.time), true)
      : false;
  return { ok: true, fromCache: false, cacheState: "stored", brief, scheduled };
}
