import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export type ComposerMode = "shine" | "compact";

export interface ComposerAttachment {
  id: string;
  name: string;
  uri: string;
  mediaType?: string;
  sizeBytes?: number;
}

export interface ComposerPreferences {
  mode: ComposerMode;
  starterSuggestions: boolean;
  returnSends: boolean;
}

export const DEFAULT_COMPOSER_PREFERENCES: ComposerPreferences = {
  mode: "shine",
  starterSuggestions: true,
  returnSends: true,
};

export interface ComposerPreferenceStore {
  load(): Promise<Partial<ComposerPreferences> | null>;
  save(value: ComposerPreferences): Promise<void>;
}

const CREATE_PREFERENCES = `CREATE TABLE IF NOT EXISTS composer_preferences (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('shine', 'compact')),
  starter_suggestions INTEGER NOT NULL CHECK (starter_suggestions IN (0, 1)),
  return_sends INTEGER NOT NULL CHECK (return_sends IN (0, 1))
)`;

/** Durable app SQLite adapter; callers can share the same database as chat history. */
export class SQLiteComposerPreferenceStore implements ComposerPreferenceStore {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: SQLiteDatabasePort) {}

  async load(): Promise<Partial<ComposerPreferences> | null> {
    await this.ensureSchema();
    const row = await this.db.getFirstAsync<{
      mode: ComposerMode;
      starter_suggestions: number;
      return_sends: number;
    }>(
      "SELECT mode, starter_suggestions, return_sends FROM composer_preferences WHERE singleton = 1",
    );
    return row
      ? {
          mode: row.mode,
          starterSuggestions: row.starter_suggestions === 1,
          returnSends: row.return_sends === 1,
        }
      : null;
  }

  async save(value: ComposerPreferences): Promise<void> {
    await this.ensureSchema();
    await this.db.runAsync(
      `INSERT INTO composer_preferences (singleton, mode, starter_suggestions, return_sends)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET mode=excluded.mode,
       starter_suggestions=excluded.starter_suggestions, return_sends=excluded.return_sends`,
      value.mode,
      value.starterSuggestions ? 1 : 0,
      value.returnSends ? 1 : 0,
    );
  }

  private ensureSchema(): Promise<void> {
    this.ready ??= this.db.execAsync(CREATE_PREFERENCES);
    return this.ready;
  }
}

export interface ComposerSendPayload {
  text: string;
  attachments: readonly ComposerAttachment[];
  searchEnabled: boolean;
  toolIds: readonly string[];
}

export type ComposerSendIntent = (
  payload: ComposerSendPayload,
) => Promise<unknown>;

export function resolveComposerPreferences(
  stored: Partial<ComposerPreferences> | null | undefined,
): ComposerPreferences {
  return {
    mode: stored?.mode === "compact" ? "compact" : "shine",
    starterSuggestions:
      typeof stored?.starterSuggestions === "boolean"
        ? stored.starterSuggestions
        : DEFAULT_COMPOSER_PREFERENCES.starterSuggestions,
    returnSends:
      typeof stored?.returnSends === "boolean"
        ? stored.returnSends
        : DEFAULT_COMPOSER_PREFERENCES.returnSends,
  };
}

export function normalizeComposerDraft(draft: string): string {
  return draft.trim();
}

export function makeComposerPayload(
  text: string,
  attachments: readonly ComposerAttachment[],
  searchEnabled: boolean,
  toolIds: readonly string[],
): ComposerSendPayload | null {
  const normalized = normalizeComposerDraft(text);
  if (!normalized && attachments.length === 0) return null;
  return { text: normalized, attachments, searchEnabled, toolIds };
}

/** A resolved send can still report that persistence did not accept the turn. */
export function sendWasAccepted(result: unknown): boolean {
  return result !== false;
}

export type ReturnKeyAction = { type: "send" } | { type: "insert-newline" };

export function returnKeyAction(returnSends: boolean): ReturnKeyAction {
  return returnSends ? { type: "send" } : { type: "insert-newline" };
}
