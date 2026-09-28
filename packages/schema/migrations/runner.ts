import { assertMigrationSequence, getMigrations } from "./registry.js";
import {
  applySQLiteMigrations,
  type SQLiteMigrationDatabase,
} from "./apply.js";

/** Node/server wrapper. Native apps should import the separate ./embedded export. */
export interface SQLiteMigrationAdapter extends SQLiteMigrationDatabase {
  readMigrationSource(source: URL): Promise<string>;
}

export async function migrateSQLite(
  db: SQLiteMigrationAdapter,
): Promise<number> {
  const migrations = getMigrations();
  assertMigrationSequence(migrations);
  return applySQLiteMigrations(
    db,
    migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      sql: () => db.readMigrationSource(migration.source),
    })),
  );
}
