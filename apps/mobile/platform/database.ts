import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";

const adapters = new WeakMap<SQLiteDatabasePort, SQLiteDatabasePort>();

/** One operation queue for every feature sharing this native connection. */
export function sharedMobileDatabase(
  database: SQLiteDatabasePort,
): SQLiteDatabasePort {
  const existing = adapters.get(database);
  if (existing) return existing;
  let operations: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = operations.then(work);
    operations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const adapter: SQLiteDatabasePort = {
    execAsync: (sql) => enqueue(() => database.execAsync(sql)),
    runAsync: (sql, ...params) =>
      enqueue(() => database.runAsync(sql, ...params)),
    getFirstAsync: <T>(sql: string, ...params: SqliteBindValue[]) =>
      enqueue(() => database.getFirstAsync<T>(sql, ...params)),
    getAllAsync: <T>(sql: string, ...params: SqliteBindValue[]) =>
      enqueue(() => database.getAllAsync<T>(sql, ...params)),
    withTransactionAsync: (work) =>
      enqueue(async () => {
        await database.execAsync("BEGIN IMMEDIATE");
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
          scopeOperations = next.then(
            () => undefined,
            (error) => {
              if (!scopeFailed) {
                scopeFailed = true;
                scopeError = error;
              }
            },
          );
          return next;
        };
        const transaction: SQLiteDatabasePort = {
          execAsync: (sql) => inScope(() => database.execAsync(sql)),
          runAsync: (sql, ...params) =>
            inScope(() => database.runAsync(sql, ...params)),
          getFirstAsync: <T>(sql: string, ...params: SqliteBindValue[]) =>
            inScope(() => database.getFirstAsync<T>(sql, ...params)),
          getAllAsync: <T>(sql: string, ...params: SqliteBindValue[]) =>
            inScope(() => database.getAllAsync<T>(sql, ...params)),
          withTransactionAsync: async () => {
            throw new Error(
              scopeOpen
                ? "Nested SQLite transactions are not supported"
                : "SQLite transaction scope is closed",
            );
          },
        };
        adapters.set(transaction, transaction);
        try {
          await work(transaction);
          scopeOpen = false;
          await scopeOperations;
          if (scopeFailed) throw scopeError;
          await database.execAsync("COMMIT");
        } catch (error) {
          scopeOpen = false;
          await scopeOperations;
          await database.execAsync("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          scopeOpen = false;
        }
      }),
  };
  adapters.set(database, adapter);
  adapters.set(adapter, adapter);
  return adapter;
}
