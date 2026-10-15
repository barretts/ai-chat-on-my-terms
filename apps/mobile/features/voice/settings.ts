import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

/** Engines that can produce read-aloud audio (VO-05, VO-06). */
export type VoiceEngineId = "offline" | "system" | "elevenlabs" | "xai";

export const VOICE_ENGINE_IDS: readonly VoiceEngineId[] = [
  "offline",
  "system",
  "elevenlabs",
  "xai",
];

export interface VoiceEngineCapabilities {
  readonly label: string;
  /** Whether the engine accepts a rate multiplier, and its legal range. */
  readonly rate: boolean;
  readonly rateRange: readonly [number, number];
  /** Rate values offered by the settings dropdown. */
  readonly rates: readonly number[];
  /** Pitch is only produced by the device's system voice. */
  readonly pitch: boolean;
}

export const VOICE_ENGINE_CAPABILITIES: Record<
  VoiceEngineId,
  VoiceEngineCapabilities
> = {
  offline: {
    label: "Offline voice (on device)",
    rate: true,
    rateRange: [0.5, 2],
    rates: [0.75, 1, 1.15, 1.3, 1.5],
    pitch: false,
  },
  system: {
    label: "System voice (device)",
    rate: true,
    rateRange: [0.5, 2],
    rates: [0.75, 1, 1.15, 1.3, 1.5],
    pitch: true,
  },
  elevenlabs: {
    label: "ElevenLabs",
    rate: true,
    // The provider rejects model_output_speed outside 0.7–1.2 (T079).
    rateRange: [0.7, 1.2],
    rates: [0.8, 0.9, 1, 1.1, 1.2],
    pitch: false,
  },
  xai: {
    label: "Grok voice (xAI)",
    rate: true,
    // The provider rejects speed outside 0.7–1.5 (T079).
    rateRange: [0.7, 1.5],
    rates: [0.8, 1, 1.2, 1.4],
    pitch: false,
  },
};

/** Pause detection and total listening bounds (VO-15). */
export const VOICE_LISTENING_LIMITS = {
  silenceTimeoutMs: { min: 300, max: 10_000, fallback: 1_500 },
  maxListeningMs: { min: 5_000, max: 300_000, fallback: 45_000 },
} as const;

export interface VoicePreferences {
  readonly autoRead: boolean;
  readonly engine: VoiceEngineId;
  /** Engine-specific voice identifier; empty means the engine default. */
  readonly voiceId: string;
  /** BCP-47 tag for spoken output and file transcription; empty = auto. */
  readonly locale: string;
  readonly rate: number;
  readonly pitch: number;
  readonly silenceTimeoutMs: number;
  readonly maxListeningMs: number;
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  autoRead: false,
  engine: "offline",
  voiceId: "",
  locale: "",
  rate: 1,
  pitch: 1,
  silenceTimeoutMs: VOICE_LISTENING_LIMITS.silenceTimeoutMs.fallback,
  maxListeningMs: VOICE_LISTENING_LIMITS.maxListeningMs.fallback,
};

const MAX_SERIALIZED_BYTES = 8 * 1024;

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length <= 512 ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readEngine(value: unknown): VoiceEngineId {
  return typeof value === "string" &&
    Object.hasOwn(VOICE_ENGINE_CAPABILITIES, value)
    ? (value as VoiceEngineId)
    : DEFAULT_VOICE_PREFERENCES.engine;
}

/**
 * Repairs a stored value into valid preferences. Field-level fallbacks keep
 * one corrupt field from resetting the whole voice setup.
 */
export function resolveVoicePreferences(
  value: Partial<Record<keyof VoicePreferences, unknown>> | null | undefined,
): VoicePreferences {
  const engine = readEngine(value?.engine);
  const [rateMin, rateMax] = VOICE_ENGINE_CAPABILITIES[engine].rateRange;
  return {
    autoRead: readBoolean(
      value?.autoRead,
      DEFAULT_VOICE_PREFERENCES.autoRead,
    ),
    engine,
    voiceId: readString(value?.voiceId, DEFAULT_VOICE_PREFERENCES.voiceId)
      .trim()
      .slice(0, 256),
    locale: readString(value?.locale, DEFAULT_VOICE_PREFERENCES.locale)
      .trim()
      .slice(0, 35),
    rate: readNumber(value?.rate, DEFAULT_VOICE_PREFERENCES.rate, rateMin, rateMax),
    pitch: readNumber(
      value?.pitch,
      DEFAULT_VOICE_PREFERENCES.pitch,
      0.5,
      2,
    ),
    silenceTimeoutMs: Math.round(
      readNumber(
        value?.silenceTimeoutMs,
        VOICE_LISTENING_LIMITS.silenceTimeoutMs.fallback,
        VOICE_LISTENING_LIMITS.silenceTimeoutMs.min,
        VOICE_LISTENING_LIMITS.silenceTimeoutMs.max,
      ),
    ),
    maxListeningMs: Math.round(
      readNumber(
        value?.maxListeningMs,
        VOICE_LISTENING_LIMITS.maxListeningMs.fallback,
        VOICE_LISTENING_LIMITS.maxListeningMs.min,
        VOICE_LISTENING_LIMITS.maxListeningMs.max,
      ),
    ),
  };
}

/** Parses stored JSON; unusable input yields defaults rather than throwing. */
export function parseVoicePreferences(raw: string): VoicePreferences {
  if (new TextEncoder().encode(raw).byteLength > MAX_SERIALIZED_BYTES)
    return DEFAULT_VOICE_PREFERENCES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return DEFAULT_VOICE_PREFERENCES;
    return resolveVoicePreferences(
      parsed as Partial<Record<keyof VoicePreferences, unknown>>,
    );
  } catch {
    return DEFAULT_VOICE_PREFERENCES;
  }
}

/** Serializes preferences; round-trips through {@link parseVoicePreferences}. */
export function serializeVoicePreferences(
  value: VoicePreferences,
): string {
  const resolved = resolveVoicePreferences(value);
  const raw = JSON.stringify(resolved);
  if (new TextEncoder().encode(raw).byteLength > MAX_SERIALIZED_BYTES)
    throw new Error("Voice preferences exceed the storage limit.");
  if (JSON.stringify(parseVoicePreferences(raw)) !== raw)
    throw new Error("Voice preferences did not round-trip.");
  return raw;
}

/**
 * Controls the selected engine can actually honor. Unsupported controls are
 * hidden by the UI while their stored values stay intact for other engines.
 */
export interface EffectiveVoiceControls {
  readonly rate: number | undefined;
  readonly pitch: number | undefined;
}

export function effectiveVoiceControls(
  prefs: VoicePreferences,
  engine: VoiceEngineId = prefs.engine,
): EffectiveVoiceControls {
  const capabilities = VOICE_ENGINE_CAPABILITIES[engine];
  const [rateMin, rateMax] = capabilities.rateRange;
  return {
    rate: capabilities.rate
      ? Math.min(rateMax, Math.max(rateMin, prefs.rate))
      : undefined,
    pitch: capabilities.pitch ? prefs.pitch : undefined,
  };
}

const TABLE = "voice_preferences";

/** Singleton-row store mirroring SQLiteDictationPreferenceStore. */
export class SQLiteVoicePreferenceStore {
  constructor(private readonly database: SQLiteDatabasePort) {}
  private ready: Promise<void> | null = null;
  private ensureSchema(): Promise<void> {
    this.ready ??= this.database
      .execAsync(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
           singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
           settings TEXT NOT NULL
         )`,
      )
      .then(() => {});
    return this.ready;
  }
  async load(): Promise<VoicePreferences | null> {
    await this.ensureSchema();
    const row = await this.database.getFirstAsync<{ settings: string }>(
      `SELECT settings FROM ${TABLE} WHERE singleton = 1`,
    );
    if (!row) return null;
    return parseVoicePreferences(row.settings);
  }
  async save(value: VoicePreferences): Promise<void> {
    await this.ensureSchema();
    await this.database.runAsync(
      `INSERT INTO ${TABLE} (singleton, settings) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET settings = excluded.settings`,
      serializeVoicePreferences(value),
    );
  }
}
