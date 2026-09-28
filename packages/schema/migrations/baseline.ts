/** Pure SQLite metadata comparison used only when adopting an unversioned app DB. */
export interface SQLiteBaselineIndex {
  readonly name: string;
  readonly sql: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly columns: readonly Readonly<Record<string, unknown>>[];
}
export interface SQLiteBaselineTable {
  readonly name: string;
  readonly sql: string;
  readonly columns: readonly Readonly<Record<string, unknown>>[];
  readonly foreignKeys: readonly Readonly<Record<string, unknown>>[];
  readonly indexes: readonly SQLiteBaselineIndex[];
}
export interface SQLiteBaseline {
  readonly version: number;
  readonly name: string;
  readonly tables: readonly SQLiteBaselineTable[];
}
export interface SQLiteBaselineReader {
  all<T extends Record<string, unknown>>(sql: string): Promise<readonly T[]>;
}

export function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
export function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Preserve quoted literals while ignoring SQL keyword case and layout. */
export function normalizedSchemaSql(sql: string): string {
  let result = "";
  let quote: string | undefined;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]!;
    if (quote) {
      result += character;
      if (character === quote) {
        if (sql[index + 1] === quote) {
          result += sql[++index]!;
        } else quote = undefined;
      }
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += character;
    } else if (!/\s/.test(character)) {
      result += character.toLowerCase();
    }
  }
  return result.replace(/;$/, "");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (canonical(actual) !== canonical(expected))
    throw new Error(`Unversioned core schema mismatch: ${label}`);
}

/** Returns false for a fresh DB. A partial or incompatible core always fails.
 * The caller must hold a write transaction from inspection through ledger stamp. */
export async function validateUnversionedBaseline(
  db: SQLiteBaselineReader,
  baseline: SQLiteBaseline,
): Promise<boolean> {
  const names = [
    ...baseline.tables.map((table) => table.name),
    ...baseline.tables.flatMap((table) =>
      table.indexes.map((index) => index.name),
    ),
  ];
  const objects = await db.all<{
    name: string;
    type: string;
    tbl_name: string;
    sql: string | null;
  }>(
    `SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name IN (${names.map(quoteSqlLiteral).join(",")})`,
  );
  if (objects.length === 0) return false;
  const byName = new Map(objects.map((object) => [object.name, object]));
  for (const table of baseline.tables) {
    const actual = byName.get(table.name);
    if (!actual || actual.type !== "table" || actual.sql === null)
      throw new Error(
        `Partial unversioned core schema: missing table ${table.name}`,
      );
    assertEqual(
      normalizedSchemaSql(actual.sql),
      normalizedSchemaSql(table.sql),
      `${table.name} SQL constraints`,
    );
    assertEqual(
      await db.all(`PRAGMA table_xinfo(${quoteSqlIdentifier(table.name)})`),
      table.columns,
      `${table.name} columns`,
    );
    assertEqual(
      await db.all(
        `PRAGMA foreign_key_list(${quoteSqlIdentifier(table.name)})`,
      ),
      table.foreignKeys,
      `${table.name} foreign keys`,
    );
    const indexes = await db.all<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>(`PRAGMA index_list(${quoteSqlIdentifier(table.name)})`);
    // Discovery order is not schema identity. Additional indexes may introduce
    // new uniqueness/partial rules, so require the exact checked baseline set.
    assertEqual(
      indexes
        .map(({ seq: _seq, ...index }) => index)
        .sort((left, right) => left.name.localeCompare(right.name)),
      table.indexes
        .map((index) => index.metadata)
        .sort((left, right) =>
          String(left.name).localeCompare(String(right.name)),
        ),
      `${table.name} indexes`,
    );
    for (const index of table.indexes) {
      const actualIndex = byName.get(index.name);
      if (
        !actualIndex ||
        actualIndex.type !== "index" ||
        actualIndex.tbl_name !== table.name
      )
        throw new Error(
          `Partial unversioned core schema: missing index ${index.name}`,
        );
      assertEqual(
        actualIndex.sql === null ? null : normalizedSchemaSql(actualIndex.sql),
        index.sql === null ? null : normalizedSchemaSql(index.sql),
        `${index.name} SQL`,
      );
      assertEqual(
        await db.all(`PRAGMA index_xinfo(${quoteSqlIdentifier(index.name)})`),
        index.columns,
        `${index.name} indexed columns`,
      );
    }
  }
  if ((await db.all("PRAGMA foreign_key_check")).length)
    throw new Error(
      "Unversioned core database contains foreign key violations",
    );
  const integrity = await db.all("PRAGMA quick_check");
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok")
    throw new Error("Unversioned core database failed its integrity check");
  return true;
}
