import { validateUnversionedBaseline, type SQLiteBaseline } from "./baseline";

/** Expo/native adapters implement these operations without a filesystem reader. */
export interface SQLiteMigrationDatabase {
  exec(sql: string): Promise<void>;
  all<T extends Record<string, unknown>>(sql: string): Promise<readonly T[]>;
  /** Acquire a SQLite write lock and run the callback atomically. */
  transaction<T>(
    work: (transaction?: SQLiteMigrationDatabase) => Promise<T>,
  ): Promise<T>;
}
export interface SQLiteMigrationEntry {
  readonly version: number;
  readonly name: string;
  readonly sql: string | (() => Promise<string>);
}

interface LedgerRow extends Record<string, unknown> {
  version: unknown;
  name: unknown;
}
const CREATE_LEDGER = `CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`;

export function assertEmbeddedMigrationSequence(
  entries: readonly SQLiteMigrationEntry[],
): void {
  const names = new Set<string>();
  entries.forEach((entry, index) => {
    const match = /^(\d{4,})-[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(entry.name);
    if (
      entry.version !== index + 1 ||
      !Number.isSafeInteger(entry.version) ||
      !match ||
      Number(match[1]) !== entry.version
    )
      throw new Error(
        `Migration ${entry.name} has version ${entry.version}; expected ${index + 1} and a matching permanent key`,
      );
    if (names.has(entry.name))
      throw new Error(`Duplicate schema migration name: ${entry.name}`);
    if (typeof entry.sql !== "string" && typeof entry.sql !== "function")
      throw new Error(`Migration ${entry.name} has no SQL source`);
    names.add(entry.name);
  });
}

async function readAndValidateLedger(
  db: SQLiteMigrationDatabase,
  migrations: readonly SQLiteMigrationEntry[],
): Promise<number> {
  const rows = await db.all<LedgerRow>(
    "SELECT version,name FROM schema_migrations ORDER BY version",
  );
  const names = new Set<string>();
  let expectedVersion = 1;
  for (const row of rows) {
    const { version, name } = row;
    if (
      !Number.isSafeInteger(version) ||
      (version as number) < 1 ||
      typeof name !== "string" ||
      !name
    )
      throw new Error(`Corrupt schema_migrations row: ${JSON.stringify(row)}`);
    if (version !== expectedVersion)
      throw new Error(
        `Out-of-order schema history: found version ${version}, expected ${expectedVersion}`,
      );
    if (names.has(name))
      throw new Error(`Duplicate schema migration ledger entry: ${name}`);
    const registered = migrations[(version as number) - 1];
    if (
      !registered ||
      registered.version !== version ||
      registered.name !== name
    )
      throw new Error(
        `Unknown or mismatched applied migration ${version} (${name})`,
      );
    names.add(name);
    expectedVersion++;
  }
  return expectedVersion - 1;
}

/** Shared ledger/transaction algorithm for static native SQL and Node URL sources. */
export async function applySQLiteMigrations(
  db: SQLiteMigrationDatabase,
  entries: readonly SQLiteMigrationEntry[],
  options: { readonly baseline?: SQLiteBaseline } = {},
): Promise<number> {
  assertEmbeddedMigrationSequence(entries);
  if (
    options.baseline &&
    (options.baseline.version !== 1 ||
      options.baseline.name !== entries[0]?.name)
  )
    throw new Error(
      "Unversioned adoption requires the registered immutable core baseline",
    );
  // SQLite ignores changes to foreign_keys inside a transaction.
  await db.exec("PRAGMA foreign_keys = ON");
  let currentVersion = await db.transaction(async (transaction) => {
    const scoped = transaction ?? db;
    const ledger = await scoped.all<{ type: string }>(
      "SELECT type FROM sqlite_master WHERE name='schema_migrations'",
    );
    if (ledger.length === 0) {
      const adopted = options.baseline
        ? await validateUnversionedBaseline(scoped, options.baseline)
        : false;
      await scoped.exec(CREATE_LEDGER);
      if (adopted)
        await scoped.exec(
          `INSERT INTO schema_migrations(version,name) VALUES (1,'${entries[0]!.name}')`,
        );
    } else if (ledger.length !== 1 || ledger[0]!.type !== "table")
      throw new Error("schema_migrations must be a table");
    return readAndValidateLedger(scoped, entries);
  });
  for (const migration of entries) {
    if (migration.version <= currentVersion) continue;
    if (migration.version !== currentVersion + 1)
      throw new Error(
        `Cannot apply migration ${migration.name} after version ${currentVersion}`,
      );
    const sql =
      typeof migration.sql === "string" ? migration.sql : await migration.sql();
    if (!sql.trim())
      throw new Error(`Migration ${migration.name} has an empty SQL source`);
    await db.transaction(async (transaction) => {
      const scoped = transaction ?? db;
      const lockedVersion = await readAndValidateLedger(scoped, entries);
      if (lockedVersion !== currentVersion)
        throw new Error(
          `Schema version changed during migration: expected ${currentVersion}, found ${lockedVersion}`,
        );
      await scoped.exec(sql);
      await scoped.exec(
        `INSERT INTO schema_migrations(version,name) VALUES (${migration.version},'${migration.name}')`,
      );
    });
    currentVersion = migration.version;
  }
  return currentVersion;
}
