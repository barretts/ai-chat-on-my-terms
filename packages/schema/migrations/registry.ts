/** Migration metadata and the single deterministic version allocator. */

export interface Migration {
  /** Immutable version stored in schema_migrations. */
  readonly version: number;
  /** Stable identifier and ledger name. */
  readonly name: string;
  /** Explicit URL to the checked-in SQLite SQL source. */
  readonly source: URL;
}

const migrations = new Map<string, Migration>();

/**
 * Allocate a version from a permanent numeric migration key (for example,
 * "0001-core" or "0002-attachments"). The number is part of the migration's
 * identity, so import order and optional feature module load order cannot
 * change a previously allocated version. Keys are never reused or renumbered.
 */
export function allocateMigrationVersion(key: string): number {
  const match = /^(\d{4,})-[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(key);
  if (!match) {
    throw new Error(`Invalid migration key "${key}"; expected NNNN-slug`);
  }
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Invalid migration version in key "${key}"`);
  }
  return version;
}

/**
 * Register a migration. This is the sole extension hook for T003A and later:
 * assign a new, never-reused numeric key and point it at a checked-in SQL file.
 */
export function registerMigration(key: string, source: URL): Migration {
  const version = allocateMigrationVersion(key);
  if (migrations.has(key)) throw new Error(`Duplicate migration key: ${key}`);
  for (const existing of migrations.values()) {
    if (existing.version === version) {
      throw new Error(
        `Migration version ${version} is already assigned to ${existing.name}`,
      );
    }
  }

  const migration = Object.freeze({ version, name: key, source });
  migrations.set(key, migration);
  return migration;
}

/** Return a frozen copy sorted by permanent version, independent of import order. */
export function getMigrations(): readonly Migration[] {
  return Object.freeze(
    [...migrations.values()].sort(
      (left, right) => left.version - right.version,
    ),
  );
}

/** Core T003 migration; T003A registers a new numeric key through the same hook. */
export const CORE_MIGRATION = registerMigration(
  "0001-core",
  new URL("../core/001_core.sql", import.meta.url),
);

/** Validate contiguous history before a runner touches the database. */
export function assertMigrationSequence(
  entries: readonly Migration[] = getMigrations(),
): void {
  const keys = new Set<string>();
  const versions = new Set<number>();
  entries.forEach((entry, index) => {
    const expected = index + 1;
    if (entry.version !== expected) {
      throw new Error(
        `Migration ${entry.name} has version ${entry.version}; expected ${expected}`,
      );
    }
    if (keys.has(entry.name) || versions.has(entry.version)) {
      throw new Error(`Duplicate migration key or version: ${entry.name}`);
    }
    keys.add(entry.name);
    versions.add(entry.version);
  });
}
