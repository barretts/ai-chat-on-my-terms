import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { SQLiteMigrationDatabase } from "@locallab/schema/embedded";

/** Pass the scoped connection through every migration transaction callback. */
export function mobileMigrationDatabase(
  db: SQLiteDatabasePort,
): SQLiteMigrationDatabase {
  return {
    exec: db.execAsync.bind(db),
    all: db.getAllAsync.bind(db),
    async transaction<T>(
      work: (transaction?: SQLiteMigrationDatabase) => Promise<T>,
    ): Promise<T> {
      let result!: T;
      await db.withTransactionAsync(async (transaction) => {
        result = await work(mobileMigrationDatabase(transaction ?? db));
      });
      return result;
    },
  };
}
