import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { SecretRef } from "@locallab/security-secrets";
import {
  SQLiteConnectionRepository,
  modelConnectionKind,
} from "../../features/connections";
import { SQLiteModelSelectionRepository } from "../../features/models/selection";
import { SQLiteChatProviderRegistry } from "./providers";

/** Adopt older server settings once; chat and Models then share one catalog. */
export async function openConnectionCatalog(db: SQLiteDatabasePort) {
  const registry = new SQLiteChatProviderRegistry(db);
  await registry.initialize();
  await db.execAsync(`CREATE TABLE IF NOT EXISTS connection_catalog_imports_local (
    connection_id TEXT PRIMARY KEY NOT NULL, imported_at TEXT NOT NULL
  )`);
  const legacy = await new SQLiteConnectionRepository(db).list();
  const selections = new SQLiteModelSelectionRepository(db);
  await selections.initialize();
  for (const connection of legacy) {
    const kind = modelConnectionKind(connection.kind);
    if (!kind) continue;
    if (
      await db.getFirstAsync(
        "SELECT connection_id FROM connection_catalog_imports_local WHERE connection_id=?",
        connection.id,
      )
    )
      continue;
    await db.withTransactionAsync(async (transaction) => {
      const scoped = transaction ?? db;
      const catalog = new SQLiteChatProviderRegistry(scoped);
      if (!(await catalog.get(connection.id))) {
        const modelId = await new SQLiteModelSelectionRepository(
          scoped,
        ).modelForConnection(connection.id);
        await catalog.save({
          id: connection.id,
          label: connection.name,
          kind,
          endpoint: connection.host,
          modelId: modelId ?? "model-discovery",
          ...(connection.credentialRef
            ? { credentialRef: connection.credentialRef as SecretRef }
            : {}),
          ...(connection.customHeadersEnabled && connection.headerRefs.length
            ? { headerRefs: connection.headerRefs as SecretRef[] }
            : {}),
          cleartextAuthorized: false,
          allowCrossProviderRouting: false,
        });
      }
      await scoped.runAsync(
        "INSERT INTO connection_catalog_imports_local(connection_id,imported_at) VALUES(?,?) ON CONFLICT(connection_id) DO NOTHING",
        connection.id,
        new Date().toISOString(),
      );
    });
  }
  return registry;
}
