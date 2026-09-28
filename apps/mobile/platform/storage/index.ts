import {
  CoreSQLiteRepositories,
  type SQLiteDatabasePort,
} from "@locallab/storage-sqlite-core";

export {
  CoreSQLiteRepositories,
  type LocalConversation,
  type LocalMessage,
  type NewConversation,
  type NewMessage,
  type NewRun,
  type SQLiteDatabasePort,
} from "@locallab/storage-sqlite-core";

/** Adapt an already migrated Expo SQLite handle to the shared core repositories. */
export function createMobileStorage(database: SQLiteDatabasePort) {
  return new CoreSQLiteRepositories(database);
}
