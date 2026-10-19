import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { sharedMobileDatabase } from "../database";
import { desktopInvoke } from "./bridge";
import { base64ToBytes, bytesToBase64 } from "./encoding";

/** One bound parameter on the db_* wire (DbValue in desktop.rs). */
type DbValue =
  | null
  | number
  | string
  | boolean
  | { type: "blob"; base64: string };

interface DbRunResult {
  lastInsertRowId: number;
  changes: number;
}

type DesktopRow = Record<string, unknown>;

/** SQLite bind value → wire DbValue (booleans become 0/1 integers). */
function toDbValue(value: SqliteBindValue | boolean): DbValue {
  if (value === null || typeof value === "number" || typeof value === "string")
    return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return { type: "blob", base64: bytesToBase64(value) };
}

/** Blob cells arrive as `{"type":"blob","base64":...}`; narrow before reading. */
function isBlobCell(cell: unknown): cell is { type: "blob"; base64: string } {
  return (
    cell !== null &&
    typeof cell === "object" &&
    !Array.isArray(cell) &&
    "type" in cell &&
    cell.type === "blob" &&
    "base64" in cell &&
    typeof cell.base64 === "string"
  );
}

/** Row cells come back JSON-only; revive blob cells to Uint8Array. */
function reviveRow(row: DesktopRow): DesktopRow {
  for (const [column, cell] of Object.entries(row)) {
    if (isBlobCell(cell)) row[column] = base64ToBytes(cell.base64);
  }
  return row;
}

/** Raw port over the Rust rusqlite connection; serialized by sharedMobileDatabase. */
function createDesktopSqlitePort(): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => {
      await desktopInvoke("db_exec", { sql });
    },
    runAsync: (sql, ...params) =>
      desktopInvoke<DbRunResult>("db_run", {
        sql,
        params: params.map(toDbValue),
      }),
    getFirstAsync: async <T>(sql: string, ...params: SqliteBindValue[]) => {
      const row = await desktopInvoke<DesktopRow | null>("db_get", {
        sql,
        params: params.map(toDbValue),
      });
      return row === null || row === undefined ? null : (reviveRow(row) as T);
    },
    getAllAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      (
        await desktopInvoke<DesktopRow[]>("db_all", {
          sql,
          params: params.map(toDbValue),
        })
      ).map((row) => reviveRow(row) as T),
    withTransactionAsync: async (work) => {
      const raw = createDesktopSqlitePort();
      await raw.execAsync("BEGIN IMMEDIATE");
      let scopeOpen = true;
      let scopeOperations: Promise<unknown> = Promise.resolve();
      let scopeFailed = false;
      let scopeError: unknown;
      const inScope = <T>(operation: () => Promise<T>): Promise<T> => {
        if (!scopeOpen)
          return Promise.reject(
            new Error("SQLite transaction scope is closed"),
          );
        const next = scopeOperations.then(operation);
        scopeOperations = scopeOperations.then(
          () => undefined,
          (error: unknown) => {
            if (!scopeFailed) {
              scopeFailed = true;
              scopeError = error;
            }
          },
        );
        return next;
      };
      const transaction: SQLiteDatabasePort = {
        execAsync: (sql) => inScope(() => raw.execAsync(sql)),
        runAsync: (sql, ...params) =>
          inScope(() => raw.runAsync(sql, ...params)),
        getFirstAsync: <T>(sql: string, ...params: SqliteBindValue[]) =>
          inScope(() => raw.getFirstAsync<T>(sql, ...params)),
        getAllAsync: <T>(sql: string, ...params: SqliteBindValue[]) =>
          inScope(() => raw.getAllAsync<T>(sql, ...params)),
        withTransactionAsync: async () => {
          throw new Error(
            scopeOpen
              ? "Nested SQLite transactions are not supported"
              : "SQLite transaction scope is closed",
          );
        },
      };
      try {
        await work(transaction);
        scopeOpen = false;
        await scopeOperations;
        if (scopeFailed) throw scopeError;
        await raw.execAsync("COMMIT");
      } catch (error) {
        scopeOpen = false;
        await scopeOperations;
        await raw.execAsync("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        scopeOpen = false;
      }
    },
  };
}

/**
 * Opens the Tauri-side rusqlite file (db_open) and returns the same
 * serialized port shape the Expo SQLite flow provides. Only valid when
 * `isDesktopBridge()` is true.
 */
export function openDesktopDatabase(): Promise<SQLiteDatabasePort> {
  return desktopInvoke<string>("db_open").then(() =>
    sharedMobileDatabase(createDesktopSqlitePort()),
  );
}
