/** Expo-safe entry point. This graph has no registry URL evaluation or Node imports. */
import { applySQLiteMigrations, type SQLiteMigrationDatabase } from "./apply";
import {
  EMBEDDED_CORE_BASELINE,
  EMBEDDED_MIGRATIONS,
} from "./embedded-data.generated";

export type { SQLiteMigrationDatabase, SQLiteMigrationEntry } from "./apply";
export { applySQLiteMigrations } from "./apply";
export const EMBEDDED_SCHEMA_VERSION = EMBEDDED_MIGRATIONS.length;

/** Safely adopts the exact old first-run core schema, then applies registered SQL. */
export async function migrateEmbeddedSQLite(
  db: SQLiteMigrationDatabase,
): Promise<number> {
  return applySQLiteMigrations(db, EMBEDDED_MIGRATIONS, {
    baseline: EMBEDDED_CORE_BASELINE,
  });
}
