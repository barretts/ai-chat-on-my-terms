/** Minimal subset exposed by expo-sqlite and faked by the bounded contract tests. */
export interface ProbeSQLiteDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(
    sql: string,
    ...params: Array<string | number | null>
  ): Promise<unknown>;
  getFirstAsync<T>(
    sql: string,
    ...params: Array<string | number | null>
  ): Promise<T | null>;
  closeAsync(): Promise<void>;
}

export interface ProbeRecord {
  id: string;
  value: string;
  createdAt: string;
}

export interface SQLiteRecordProbePort {
  createWriteCloseReopenRead(record: ProbeRecord): Promise<ProbeRecord | null>;
}

/** This port deliberately exercises the same close/reopen boundary as app restart. */
export function createSQLiteRecordProbePort(
  openDatabase: (name: string) => Promise<ProbeSQLiteDatabase>,
  databaseName = "expo-transport-probe.db",
): SQLiteRecordProbePort {
  return {
    async createWriteCloseReopenRead(record) {
      const first = await openDatabase(databaseName);
      try {
        await first.execAsync(
          "CREATE TABLE IF NOT EXISTS transport_probe (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL)",
        );
        await first.runAsync(
          "INSERT OR REPLACE INTO transport_probe (id, value, created_at) VALUES (?, ?, ?)",
          record.id,
          record.value,
          record.createdAt,
        );
      } finally {
        await first.closeAsync();
      }

      const reopened = await openDatabase(databaseName);
      try {
        const row = await reopened.getFirstAsync<{
          id: string;
          value: string;
          created_at: string;
        }>(
          "SELECT id, value, created_at FROM transport_probe WHERE id = ?",
          record.id,
        );
        return row
          ? { id: row.id, value: row.value, createdAt: row.created_at }
          : null;
      } finally {
        await reopened.closeAsync();
      }
    },
  };
}
