import { fetch as expoFetch } from "expo/fetch";
import * as SQLite from "expo-sqlite";
import { createExpoStreamingProviderPort } from "./provider.js";
import { createSQLiteRecordProbePort } from "./sqlite-probe.js";

/** Runtime adapters used by the iOS development build, keeping network traffic direct to BYOK host. */
export const createExpoProviderPort = (
  resolveConnection: Parameters<
    typeof createExpoStreamingProviderPort
  >[0]["resolveConnection"],
) =>
  createExpoStreamingProviderPort({
    fetch: expoFetch as typeof fetch,
    resolveConnection,
  });

export const expoSQLiteRecordProbe = createSQLiteRecordProbePort((name) =>
  SQLite.openDatabaseAsync(name),
);
