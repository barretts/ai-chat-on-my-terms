import { JobScheduler, SQLiteJobStore } from "@locallab/jobs";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { EntityId } from "@locallab/contracts/identity";

/** Construct after the app's SQLite migrations have completed. */
export function createMobileJobScheduler(
  database: SQLiteDatabasePort,
  deviceId: EntityId,
) {
  return new JobScheduler(new SQLiteJobStore(database), { deviceId });
}
