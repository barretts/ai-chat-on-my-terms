import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { HostScopedSecretStore } from "@locallab/security-secrets";
import { SQLiteConnectionRepository } from "../../features/connections";
import { SQLiteModelSelectionRepository } from "../../features/models/selection";
import { sharedMobileDatabase } from "../../platform/database";
import { openConnectionCatalog } from "./connection-catalog";
import { SQLiteChatProviderRegistry } from "./providers";

function queuedDatabase(native: DatabaseSync): SQLiteDatabasePort {
  const raw: SQLiteDatabasePort = {
    execAsync: async (sql) => native.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      native.prepare(sql).run(...params),
    getFirstAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      (native.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      native.prepare(sql).all(...params) as T[],
    withTransactionAsync: async () => {
      throw new Error("The production shared queue must own the transaction.");
    },
  };
  return sharedMobileDatabase(raw);
}

async function completes<T>(operation: Promise<T>): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    watchdog = setTimeout(
      () =>
        reject(
          new Error(
            "Connection migration stalled on the shared SQLite operation queue.",
          ),
        ),
      1500,
    );
  });
  try {
    return await Promise.race([operation, stalled]);
  } finally {
    clearTimeout(watchdog);
  }
}

test("legacy model and secure header references migrate using the real shared transaction queue", async () => {
  const native = new DatabaseSync(":memory:");
  const db = queuedDatabase(native);
  const values = new Map<string, string>();
  let sequence = 40;
  const secrets = new HostScopedSecretStore(
    {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    },
    "queue-catalog-fixture",
    () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
  );
  try {
    native.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE conversations(id TEXT PRIMARY KEY); INSERT INTO conversations VALUES('00000000-0000-7000-8000-000000000001');",
    );
    const credential = await secrets.put(
      "https://queue-fixture.invalid",
      "Authorization",
      "Bearer fixture-api-key",
    );
    const extra = await secrets.put(
      "https://queue-fixture.invalid",
      "X-Queue-Fixture",
      "fixture-custom-value",
    );
    const legacy = new SQLiteConnectionRepository(
      db,
      () => "00000000-0000-7000-8000-000000000041",
    );
    const saved = await legacy.save({
      name: "Queued old server",
      kind: "openai-compatible",
      host: "https://queue-fixture.invalid",
      credentialRef: credential.ref,
      headerRefs: [extra.ref],
      customHeadersEnabled: true,
    });
    const selection = new SQLiteModelSelectionRepository(db);
    await selection.initialize();
    await selection.chooseConnection(saved.id);
    await selection.selectModel(saved.id, "fixture-old-model");
    const registry = await completes(openConnectionCatalog(db));
    const adopted = await registry.get(saved.id);
    assert.equal(adopted?.modelId, "fixture-old-model");
    assert.equal(adopted?.credentialRef, credential.ref);
    assert.deepEqual(adopted?.headerRefs, [extra.ref]);
    assert.deepEqual(
      {
        ...(await secrets.resolveHeaders("https://queue-fixture.invalid", [
          adopted!.credentialRef!,
          ...adopted!.headerRefs!,
        ])),
      },
      {
        authorization: "Bearer fixture-api-key",
        "x-queue-fixture": "fixture-custom-value",
      },
    );
    const persisted = JSON.stringify(
      native.prepare("SELECT * FROM chat_provider_connections").all(),
    );
    assert.doesNotMatch(persisted, /fixture-api-key|fixture-custom-value/);
    await registry.remove(saved.id, "00000000-0000-7000-8000-000000000001");
    await completes(openConnectionCatalog(db));
    assert.equal(await registry.get(saved.id), undefined);
  } finally {
    native.close();
  }
});

test("failed queued migration leaves no import marker and succeeds on a later retry", async () => {
  const native = new DatabaseSync(":memory:");
  const db = queuedDatabase(native);
  try {
    native.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY);");
    const legacy = new SQLiteConnectionRepository(
      db,
      () => "00000000-0000-7000-8000-000000000042",
    );
    const saved = await legacy.save({
      name: "Retry old server",
      kind: "ollama",
      host: "http://192.168.50.45:11434",
    });
    await new SQLiteChatProviderRegistry(db).initialize();
    native.exec(
      "CREATE TRIGGER reject_catalog_fixture BEFORE INSERT ON chat_provider_connections BEGIN SELECT RAISE(ABORT, 'fixture migration write failed'); END;",
    );
    await assert.rejects(
      completes(openConnectionCatalog(db)),
      /fixture migration write failed/,
    );
    assert.equal(
      native
        .prepare("SELECT COUNT(*) AS n FROM connection_catalog_imports_local")
        .get()!.n,
      0,
    );
    assert.equal(
      native
        .prepare("SELECT COUNT(*) AS n FROM chat_provider_connections")
        .get()!.n,
      0,
    );
    native.exec("DROP TRIGGER reject_catalog_fixture");
    const registry = await completes(openConnectionCatalog(db));
    const adopted = await registry.get(saved.id);
    assert.equal(adopted?.modelId, "model-discovery");
    assert.equal(adopted?.cleartextAuthorized, false);
    assert.equal(
      native
        .prepare("SELECT COUNT(*) AS n FROM connection_catalog_imports_local")
        .get()!.n,
      1,
    );
  } finally {
    native.close();
  }
});
