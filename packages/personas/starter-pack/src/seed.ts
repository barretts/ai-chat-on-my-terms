/**
 * Trope pack seeding (T184), generalizing the Mini assistant pattern
 * (`SQLitePersonaLibrary.initialize`): a `persona_library_state` marker
 * installs the pack once per device; per-persona tombstones keep a deleted
 * trope deleted across launches (PE-04). Explicit reload (`loadTropePack`,
 * the persona screen's "Load character pack") is the ONLY way a tombstone is
 * cleared — user intent beats the tombstone exactly when the user asks.
 *
 * Avatars ride an injected attacher (bundled asset → managed attachment →
 * attachment id). Attach failure keeps the persona photo-less; a per-trope
 * insert failure never aborts the pack. All mutations go through the
 * library's own serialized create/update so the shared mutation queue and
 * transactions hold; the raw statements here are read-only pre-checks plus
 * the tombstone delete on explicit reload.
 */
import { PersonaLibraryError } from "@locallab/personas-library";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import {
  STARTER_TROPES,
  TROPE_PACK_SEED_KEY,
  type StarterTrope,
} from "./tropes";

/** Insert-only view of the persona library the pack needs. */
export interface TropePersonaWriter {
  create(input: {
    id: string;
    name: string;
    description?: string;
    prompt?: string;
    appearance?: { accentColor?: string; backgroundColor?: string };
    photoAttachmentId?: string | null;
  }): Promise<unknown>;
  update(
    id: string,
    input: { photoAttachmentId?: string | null },
  ): Promise<unknown>;
}

export interface TropeSeedOptions {
  library: TropePersonaWriter;
  db: SQLiteDatabasePort;
  /** Bundled asset → managed attachment; resolves to the attachment id, or null when unavailable. */
  attachAvatar?: (trope: StarterTrope) => Promise<string | null>;
  log?: (message: string) => void;
}

export interface TropeSeedResult {
  /** Trope keys newly inserted in this call. */
  inserted: string[];
  /** Trope keys whose tombstone an explicit reload cleared. */
  restored: string[];
}

async function readState(
  db: SQLiteDatabasePort,
  key: string,
): Promise<string | undefined> {
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM persona_library_state WHERE key=?",
    key,
  );
  return row?.value;
}

async function hasRow(
  db: SQLiteDatabasePort,
  sql: string,
  id: string,
): Promise<boolean> {
  return (await db.getFirstAsync(sql, id)) !== null;
}

function draftOf(trope: StarterTrope) {
  return {
    id: trope.id,
    name: trope.name,
    description: trope.description,
    prompt: trope.prompt,
    appearance: {
      accentColor: trope.accentColor,
      backgroundColor: trope.backgroundColor,
    },
  };
}

async function install(
  trope: StarterTrope,
  options: TropeSeedOptions,
  restored: string[],
): Promise<boolean> {
  const { library, db, attachAvatar, log = () => undefined } = options;
  try {
    const record = await library.create(draftOf(trope));
    void record;
    if (attachAvatar) {
      try {
        const attachmentId = await attachAvatar(trope);
        if (attachmentId)
          await library.update(trope.id, { photoAttachmentId: attachmentId });
      } catch (cause) {
        // The persona stays usable with colored initials (appearance fallback).
        log(
          `starter-pack avatar attach failed for ${trope.key}: ${String(cause)}`,
        );
      }
    }
    if (restored.includes(trope.key))
      log(`starter-pack restored deleted trope ${trope.key}`);
    return true;
  } catch (cause) {
    if (cause instanceof PersonaLibraryError && cause.code === "conflict")
      return false; // edited or deleted since the marker; never touch it here
    log(`starter-pack insert failed for ${trope.key}: ${String(cause)}`);
    return false;
  }
}

/**
 * Explicit-reload only: a bundled trope that already exists but has no
 * avatar (e.g. it was seeded on a platform whose avatar import failed) gets
 * its bust attached. Personas that already have an avatar are left alone.
 */
async function backfillAvatar(
  trope: StarterTrope,
  options: TropeSeedOptions,
): Promise<void> {
  const { db, attachAvatar, log = () => undefined } = options;
  if (!attachAvatar) return;
  const row = await db.getFirstAsync<Record<string, unknown>>(
    "SELECT photo_attachment_id FROM persona_profiles WHERE persona_id=?",
    trope.id,
  );
  if (!row || row.photo_attachment_id) return; // has an avatar (or no profile)
  try {
    const attachmentId = await attachAvatar(trope);
    if (attachmentId)
      await options.library.update(trope.id, {
        photoAttachmentId: attachmentId,
      });
  } catch (cause) {
    log(
      `starter-pack avatar backfill failed for ${trope.key}: ${String(cause)}`,
    );
  }
}

/** Boot seeding: install-all-once behind the marker; deleted tropes stay deleted. */
export async function seedTropePack(
  options: TropeSeedOptions,
): Promise<TropeSeedResult> {
  const { db } = options;
  if (await readState(db, TROPE_PACK_SEED_KEY))
    return { inserted: [], restored: [] };
  const result = { inserted: [] as string[], restored: [] as string[] };
  for (const trope of STARTER_TROPES) {
    if (await hasRow(db, "SELECT id FROM personas WHERE id=?", trope.id))
      continue; // already present (e.g. mid-install crash): leave it alone
    if (
      await hasRow(
        db,
        "SELECT entity_id FROM persona_tombstones WHERE entity_id=?",
        trope.id,
      )
    )
      continue; // deleted before the marker existed; only explicit reload resurrects
    if (await install(trope, options, result.restored))
      result.inserted.push(trope.key);
  }
  await db.runAsync(
    `INSERT INTO persona_library_state (key,value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    TROPE_PACK_SEED_KEY,
    "installed",
  );
  return result;
}

/** Explicit owner reload: re-insert every missing trope, clearing its tombstone. */
export async function loadTropePack(
  options: TropeSeedOptions,
): Promise<TropeSeedResult> {
  const { db } = options;
  const result = { inserted: [] as string[], restored: [] as string[] };
  for (const trope of STARTER_TROPES) {
    if (await hasRow(db, "SELECT id FROM personas WHERE id=?", trope.id)) {
      await backfillAvatar(trope, options); // edits win; a missing bust is repaired
      continue;
    }
    const tombstoned = await hasRow(
      db,
      "SELECT entity_id FROM persona_tombstones WHERE entity_id=?",
      trope.id,
    );
    if (tombstoned) {
      await db.runAsync(
        "DELETE FROM persona_tombstones WHERE entity_id=?",
        trope.id,
      );
      result.restored.push(trope.key);
    }
    if (await install(trope, options, result.restored))
      result.inserted.push(trope.key);
  }
  await db.runAsync(
    `INSERT INTO persona_library_state (key,value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    TROPE_PACK_SEED_KEY,
    "installed",
  );
  return result;
}

export { STARTER_TROPES, TROPE_PACK_SEED_KEY } from "./tropes";
export type { StarterTrope } from "./tropes";
