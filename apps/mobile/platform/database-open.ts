import * as SQLite from "expo-sqlite";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { sharedMobileDatabase } from "./database";
import { isDesktopBridge } from "./desktop/bridge";
import { openDesktopDatabase } from "./desktop/database";

let appDatabase: Promise<SQLiteDatabasePort> | undefined;

/** Routes share one app-lifetime connection; unmounting a screen must not close it. */
export function openMobileDatabase(): Promise<SQLiteDatabasePort> {
  appDatabase ??= (
    isDesktopBridge()
      ? openDesktopDatabase()
      : SQLite.openDatabaseAsync("locallab.db").then((database) =>
          sharedMobileDatabase(database as unknown as SQLiteDatabasePort),
        )
  ).catch((error: unknown) => {
    appDatabase = undefined;
    throw error;
  });
  return appDatabase;
}
