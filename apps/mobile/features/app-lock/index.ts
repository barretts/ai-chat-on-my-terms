/** App Lock mobile wiring: grace preference persistence plus core re-exports. */
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { GRACE_PERIODS } from "@locallab/app-lock";
import type { GracePeriod } from "@locallab/app-lock";

export {
  GRACE_PERIODS,
  GRACE_MILLISECONDS,
  createLockSession,
  shouldChallengeOnForeground,
  validatePin,
} from "@locallab/app-lock";
export type {
  BiometricOutcome,
  BiometricPort,
  GracePeriod,
  LockRecord,
  LockRecordStore,
  LockSession,
} from "@locallab/app-lock";

const prefsSql = `
CREATE TABLE IF NOT EXISTS app_lock_prefs (
  scope TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
`;

export interface LockPreferencesDoc {
  version: 1;
  grace: GracePeriod;
}

export const DEFAULT_LOCK_PREFS: LockPreferencesDoc = {
  version: 1,
  grace: "oneMinute",
};

export interface LockPrefsStore {
  load(): Promise<LockPreferencesDoc>;
  save(prefs: LockPreferencesDoc): Promise<void>;
}

export async function ensureAppLockSchema(
  db: SQLiteDatabasePort,
): Promise<void> {
  await db.execAsync(prefsSql);
}

export function createLockPrefsStore(
  db: SQLiteDatabasePort,
): LockPrefsStore {
  return {
    async load() {
      const row = await db.getFirstAsync<{ doc: string }>(
        "SELECT doc FROM app_lock_prefs WHERE scope = ?",
        "lock",
      );
      if (row === null) return { ...DEFAULT_LOCK_PREFS };
      try {
        const parsed = JSON.parse(row.doc) as LockPreferencesDoc;
        if (parsed.version !== 1 || !GRACE_PERIODS.includes(parsed.grace))
          return { ...DEFAULT_LOCK_PREFS };
        return parsed;
      } catch {
        return { ...DEFAULT_LOCK_PREFS };
      }
    },
    async save(prefs) {
      if (!GRACE_PERIODS.includes(prefs.grace)) return;
      await db.runAsync(
        "INSERT INTO app_lock_prefs(scope, doc) VALUES('lock', ?) ON CONFLICT(scope) DO UPDATE SET doc = excluded.doc",
        JSON.stringify({ version: 1, grace: prefs.grace }),
      );
    },
  };
}
