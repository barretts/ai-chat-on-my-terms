import { EntityIdSchema } from "@locallab/contracts/identity";
import {
  normalizedContent,
  scopeKey,
  type MemoryEntry,
  type MemoryPolicy,
  type MemoryPreferences,
} from "@locallab/memory-extraction";
import { DEFAULT_PERSONA_ID } from "@locallab/personas-library";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

/**
 * Persona memory scoping (ME-04..ME-07):
 * - per-Persona sharing/extraction toggles independent of the global ones;
 * - explicit fact↔Persona associations on top of store ownership;
 * - prompt fragments deduplicated and bounded by a context budget;
 * - switching Persona never touches this data; only an explicit reset does.
 */

export const PERSONA_MEMORY_SETTINGS_KEY = "memory";

export interface PersonaMemorySettings {
  extract?: boolean;
  inject?: boolean;
  share?: boolean;
}

export interface PersonaMemoryPolicy {
  personaId: string;
  extract: boolean | null;
  inject: boolean | null;
  share: boolean;
}

export const PERSONA_MEMORY_LIMITS = Object.freeze({
  associatedFacts: 500,
  promptEntries: 200,
});

/** Tolerant read of the Persona profile map: junk values fall back to unset. */
export function readPersonaMemorySettings(
  profile: unknown,
): PersonaMemorySettings {
  if (typeof profile !== "object" || profile === null) return {};
  const raw = (profile as Record<string, unknown>)[
    PERSONA_MEMORY_SETTINGS_KEY
  ];
  if (typeof raw !== "object" || raw === null) return {};
  const entry = raw as Record<string, unknown>;
  const settings: {
    extract?: boolean;
    inject?: boolean;
    share?: boolean;
  } = {};
  if (typeof entry.extract === "boolean") settings.extract = entry.extract;
  if (typeof entry.inject === "boolean") settings.inject = entry.inject;
  if (typeof entry.share === "boolean") settings.share = entry.share;
  return settings;
}

/**
 * Per-Persona toggles override the global memory switches; unset keys fall
 * back to the global preferences, so the two layers stay independent.
 */
export function scopedMemoryPolicy(
  identity: { personaId: string; profile?: unknown },
  preferences: MemoryPreferences,
): MemoryPolicy {
  const settings = readPersonaMemorySettings(identity.profile);
  const isDefault = identity.personaId === DEFAULT_PERSONA_ID;
  return {
    extract: settings.extract ?? preferences.extractionEnabled,
    inject: settings.inject ?? preferences.injectionEnabled,
    scope: isDefault
      ? { scope: "global", scopeId: null }
      : { scope: "persona", scopeId: identity.personaId },
    includeGlobal: isDefault,
  };
}

/**
 * Merge owned and explicitly associated fragments: each normalized fact
 * appears exactly once, total bounded by the context budget in characters.
 */
export function boundedFragments(
  groups: readonly (readonly MemoryEntry[])[],
  budgetCharacters: number,
): MemoryEntry[] {
  const seen = new Set<string>();
  const result: MemoryEntry[] = [];
  let chars = 0;
  for (const group of groups) {
    for (const entry of group) {
      const key = normalizedContent(entry.content);
      if (seen.has(key)) continue;
      if (entry.content.length + chars > budgetCharacters) continue;
      seen.add(key);
      result.push(entry);
      chars += entry.content.length;
      if (result.length >= PERSONA_MEMORY_LIMITS.promptEntries) return result;
    }
  }
  return result;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persona_memory_policy (
  persona_id TEXT PRIMARY KEY NOT NULL,
  extract INTEGER CHECK (extract IN (0,1)),
  inject INTEGER CHECK (inject IN (0,1)),
  share INTEGER NOT NULL DEFAULT 0 CHECK (share IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_persona_associations (
  memory_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, persona_id)
);
CREATE INDEX IF NOT EXISTS memory_persona_associations_persona
  ON memory_persona_associations(persona_id, memory_id);
`;

function triState(value: boolean | null): 0 | 1 | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

/** SQLite-backed per-Persona policy and fact association store. */
export class SQLitePersonaMemoryScope {
  private readonly db: SQLiteDatabasePort;
  private readonly now: () => Date;

  constructor(db: SQLiteDatabasePort, now = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  async initialize(): Promise<void> {
    await this.db.execAsync(SCHEMA_SQL);
  }

  async policy(personaId: string): Promise<PersonaMemoryPolicy | null> {
    EntityIdSchema.parse(personaId);
    const row = await this.db.getFirstAsync<{
      persona_id: string;
      extract: number | null;
      inject: number | null;
      share: number;
    }>("SELECT persona_id,extract,inject,share FROM persona_memory_policy WHERE persona_id=?", personaId);
    if (!row) return null;
    return {
      personaId: row.persona_id,
      extract: row.extract === null ? null : row.extract === 1,
      inject: row.inject === null ? null : row.inject === 1,
      share: row.share === 1,
    };
  }

  async setPolicy(
    personaId: string,
    patch: Partial<Pick<PersonaMemoryPolicy, "extract" | "inject" | "share">>,
  ): Promise<PersonaMemoryPolicy> {
    EntityIdSchema.parse(personaId);
    await this.db.runAsync(
      `INSERT INTO persona_memory_policy(persona_id,extract,inject,share,updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(persona_id) DO UPDATE SET
         extract=COALESCE(excluded.extract,persona_memory_policy.extract),
         inject=COALESCE(excluded.inject,persona_memory_policy.inject),
         share=COALESCE(excluded.share,persona_memory_policy.share),
         updated_at=excluded.updated_at`,
      personaId,
      triState(patch.extract ?? null),
      triState(patch.inject ?? null),
      patch.share === undefined ? null : triState(patch.share),
      this.now().toISOString(),
    );
    // COALESCE on share would keep the old value; distinguish "not provided"
    // with a second write only when share was actually supplied.
    if (patch.share !== undefined) {
      await this.db.runAsync(
        "UPDATE persona_memory_policy SET share=? WHERE persona_id=?",
        patch.share ? 1 : 0,
        personaId,
      );
    }
    const stored = await this.policy(personaId);
    if (!stored) throw new Error("Persona memory policy disappeared");
    return stored;
  }

  async clearPolicy(personaId: string): Promise<void> {
    EntityIdSchema.parse(personaId);
    await this.db.runAsync(
      "DELETE FROM persona_memory_policy WHERE persona_id=?",
      personaId,
    );
  }

  /** Effective extraction switch: per-Persona override wins over global. */
  async extractionAllowed(personaId: string, globalEnabled: boolean): Promise<boolean> {
    const policy = await this.policy(personaId);
    return policy?.extract ?? globalEnabled;
  }

  async associate(memoryId: string, personaId: string): Promise<void> {
    EntityIdSchema.parse(memoryId);
    EntityIdSchema.parse(personaId);
    const owned = await this.db.getFirstAsync<{ persona_id: string }>(
      "SELECT json_extract(metadata_json,'$.scopeId') AS persona_id FROM memory_items WHERE id=? AND deleted_at IS NULL",
      memoryId,
    );
    if (!owned) throw new Error("Unknown memory entry");
    if (
      owned.persona_id !== null &&
      owned.persona_id !== personaId
    ) {
      // Private fact of another Persona: only an explicit sharing switch
      // may expose it, never a bare association.
      const policy = await this.policy(owned.persona_id);
      if (policy?.share !== true)
        throw new Error("Private Persona fact cannot be associated");
    }
    const count = await this.db.getFirstAsync<{ total: number }>(
      "SELECT COUNT(*) AS total FROM memory_persona_associations WHERE persona_id=?",
      personaId,
    );
    if ((count?.total ?? 0) >= PERSONA_MEMORY_LIMITS.associatedFacts)
      throw new Error("Too many associated facts");
    await this.db.runAsync(
      "INSERT OR IGNORE INTO memory_persona_associations(memory_id,persona_id,created_at) VALUES(?,?,?)",
      memoryId,
      personaId,
      this.now().toISOString(),
    );
  }

  async disassociate(memoryId: string, personaId: string): Promise<void> {
    EntityIdSchema.parse(memoryId);
    EntityIdSchema.parse(personaId);
    await this.db.runAsync(
      "DELETE FROM memory_persona_associations WHERE memory_id=? AND persona_id=?",
      memoryId,
      personaId,
    );
  }

  async associatedMemoryIds(personaId: string): Promise<string[]> {
    EntityIdSchema.parse(personaId);
    const rows = await this.db.getAllAsync<{ memory_id: string }>(
      "SELECT memory_id FROM memory_persona_associations WHERE persona_id=? ORDER BY memory_id",
      personaId,
    );
    return rows.map((row) => row.memory_id);
  }

  /** Personas that explicitly opted into sharing their facts. */
  async sharingPersonaIds(exceptPersonaId: string): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ persona_id: string }>(
      "SELECT persona_id FROM persona_memory_policy WHERE share=1 AND persona_id<>? ORDER BY persona_id",
      exceptPersonaId,
    );
    return rows.map((row) => row.persona_id);
  }

  async personaIdsWithOwnedFacts(exceptPersonaId: string): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ persona_id: string }>(
      "SELECT DISTINCT json_extract(metadata_json,'$.scopeId') AS persona_id FROM memory_items WHERE deleted_at IS NULL AND json_extract(metadata_json,'$.scope')='persona' AND json_extract(metadata_json,'$.scopeId') IS NOT NULL AND json_extract(metadata_json,'$.scopeId')<>?",
      exceptPersonaId,
    );
    return rows
      .map((row) => row.persona_id)
      .filter((value): value is string => value !== null);
  }

  /**
   * Reset clears the Persona's memory state: its policy and every
   * association. A Persona switch never calls this; only explicit reset does.
   */
  async resetPersona(personaId: string): Promise<void> {
    EntityIdSchema.parse(personaId);
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      await scopedDb.runAsync(
        "DELETE FROM memory_persona_associations WHERE persona_id=?",
        personaId,
      );
      await scopedDb.runAsync(
        "DELETE FROM persona_memory_policy WHERE persona_id=?",
        personaId,
      );
    });
  }

  /** namespace of facts owned by this persona scope (matches store layout). */
  static ownedNamespace(personaId: string): string {
    return scopeKey({ scope: "persona", scopeId: personaId });
  }
}
