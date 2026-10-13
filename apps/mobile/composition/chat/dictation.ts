import { AudioSessionCoordinator } from "@locallab/audio-session";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { DictationInputPort } from "@locallab/speech-system";
import { createOfflineSpeechOutput } from "../audio/offline-speech-output";
import type { OfflineSpeech } from "../../platform/speech/types";
import type { DictationOutcome } from "../../features/composer/advanced";

/** "" keeps the system default language. */
export interface DictationPreferences {
  locale: string;
  autosend: boolean;
}

export const DEFAULT_DICTATION_PREFERENCES: DictationPreferences = {
  locale: "",
  autosend: false,
};

export function resolveDictationPreferences(
  stored: Partial<DictationPreferences> | null | undefined,
): DictationPreferences {
  return {
    locale: typeof stored?.locale === "string" ? stored.locale : "",
    autosend: stored?.autosend === true,
  };
}

/** Locale and autosend survive reopening the app. */
export class SQLiteDictationPreferenceStore {
  private ready: Promise<void> | undefined;
  constructor(private readonly database: SQLiteDatabasePort) {}
  private ensureSchema() {
    this.ready ??= this.database
      .execAsync(
        `CREATE TABLE IF NOT EXISTS dictation_preferences (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      locale TEXT NOT NULL,
      autosend INTEGER NOT NULL CHECK (autosend IN (0,1))
    )`,
      )
      .then(() => {});
    return this.ready;
  }
  async load(): Promise<DictationPreferences | null> {
    await this.ensureSchema();
    const row = await this.database.getFirstAsync<{
      locale: string;
      autosend: number;
    }>("SELECT locale, autosend FROM dictation_preferences WHERE singleton=1");
    if (!row) return null;
    return resolveDictationPreferences({
      locale: row.locale,
      autosend: row.autosend === 1,
    });
  }
  async save(value: DictationPreferences): Promise<void> {
    await this.ensureSchema();
    await this.database.runAsync(
      "INSERT INTO dictation_preferences (singleton,locale,autosend) VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET locale=excluded.locale,autosend=excluded.autosend",
      value.locale,
      value.autosend ? 1 : 0,
    );
  }
}

/**
 * Owns one conversation's dictation. Capture always goes through the audio
 * session coordinator so playback stops first and can never be transcribed
 * back through the microphone. Stop finalizes the utterance; cancel discards
 * it. Starting a new capture pre-empts the previous one.
 */
export class DictationController {
  private readonly coordinator: AudioSessionCoordinator;
  private active: AbortController | null = null;
  constructor(
    private readonly input: DictationInputPort,
    speech: OfflineSpeech,
  ) {
    this.coordinator = new AudioSessionCoordinator(
      input,
      createOfflineSpeechOutput(speech),
    );
  }
  async start(
    handlers: { onPartial: (text: string) => void },
    locale: string,
  ): Promise<DictationOutcome> {
    this.cancel();
    const controller = new AbortController();
    this.active = controller;
    const result = await this.coordinator.listen({
      ...(locale ? { locale } : {}),
      signal: controller.signal,
      onPartial: handlers.onPartial,
    });
    if (this.active === controller) this.active = null;
    const info = this.input.operationInfo();
    if (result.ok)
      return {
        status: "final",
        text: result.value,
        locale: info?.locale ?? (locale || null),
        onDevice: info?.onDevice ?? null,
      };
    if (result.error.code === "canceled") return { status: "canceled" };
    return {
      status: "error",
      code: result.error.code,
      message: result.error.message,
    };
  }
  /** Finishes the active capture; the final transcript resolves `start`. */
  stop(): void {
    this.active?.abort();
  }
  /** Discards the active capture without delivering text. */
  cancel(): void {
    const controller = this.active;
    if (!controller) return;
    this.active = null;
    void this.input.cancel();
    controller.abort();
  }
  async dispose(): Promise<void> {
    this.cancel();
    await this.coordinator.dispose();
  }
}
