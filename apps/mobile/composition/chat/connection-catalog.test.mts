import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { HostScopedSecretStore } from "@locallab/security-secrets";
import { SQLiteConnectionRepository } from "../../features/connections";
import { SQLiteModelSelectionRepository } from "../../features/models/selection";
import { openConnectionCatalog } from "./connection-catalog";
import { createRegisteredConnectionModels } from "../../features/models/registered-connections";

function database(native: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => native.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      native.prepare(sql).run(...params),
    getFirstAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      (native.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      native.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
      native.exec("BEGIN IMMEDIATE");
      try {
        await work();
        native.exec("COMMIT");
      } catch (cause) {
        native.exec("ROLLBACK");
        throw cause;
      }
    },
  };
}

describe("shared connection catalog", () => {
  it("adopts a legacy connection and its host-bound credentials once, without resurrecting removed entries", async () => {
    const native = new DatabaseSync(":memory:");
    const db = database(native);
    const values = new Map<string, string>();
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
      "catalog-test",
      () => "00000000-0000-7000-8000-000000000030",
    );
    try {
      native.exec(
        "CREATE TABLE conversations(id TEXT PRIMARY KEY); INSERT INTO conversations VALUES('00000000-0000-7000-8000-000000000001');",
      );
      const credential = await secrets.put(
        "https://fixture.example",
        "authorization",
        "Bearer fixture-only-secret",
      );
      const legacy = new SQLiteConnectionRepository(
        db,
        () => "00000000-0000-7000-8000-000000000031",
      );
      const saved = await legacy.save({
        name: "My previous server",
        kind: "openai-compatible",
        host: "https://fixture.example",
        credentialRef: credential.ref,
      });
      const selections = new SQLiteModelSelectionRepository(db);
      await selections.initialize();
      await selections.chooseConnection(saved.id);
      await selections.selectModel(saved.id, "model-before-upgrade");
      const catalog = await openConnectionCatalog(db);
      const adopted = await catalog.get(saved.id);
      assert.equal(adopted?.modelId, "model-before-upgrade");
      assert.equal(adopted?.credentialRef, credential.ref);
      assert.equal(
        (
          await secrets.resolveHeaders("https://fixture.example", [
            adopted!.credentialRef!,
          ])
        ).authorization,
        "Bearer fixture-only-secret",
      );
      await assert.rejects(
        () =>
          secrets.resolveHeaders("https://different.example", [
            adopted!.credentialRef!,
          ]),
        /different server/,
      );
      await catalog.save({ ...adopted!, modelId: "model-chosen-in-chat" });
      await openConnectionCatalog(db);
      assert.equal(
        (await catalog.get(saved.id))?.modelId,
        "model-chosen-in-chat",
      );
      const json = JSON.stringify(
        native.prepare("SELECT * FROM chat_provider_connections").all(),
      );
      assert.ok(!json.includes("fixture-only-secret"));
      await catalog.remove(saved.id, "00000000-0000-7000-8000-000000000001");
      await openConnectionCatalog(db);
      assert.equal(await catalog.get(saved.id), undefined);
      assert.equal((await legacy.list()).length, 1);
    } finally {
      native.close();
    }
  });

  it("loads Models from the exact saved chat endpoint using its secure headers", async () => {
    const native = new DatabaseSync(":memory:");
    try {
      native.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY)");
      const catalog = await openConnectionCatalog(database(native));
      await catalog.save({
        id: "00000000-0000-7000-8000-000000000032",
        label: "Chat server",
        kind: "compatible",
        modelId: "second-model",
        endpoint: "https://fixture.example/v1",
      });
      const saved = (await catalog.list())[0]!;
      const port = createRegisteredConnectionModels(
        saved,
        {
          put: async () => {
            throw new Error("No key should be written while browsing.");
          },
          remove: async () => {},
          resolveHeaders: async () => ({}),
        },
        async (url) => {
          assert.equal(String(url), "https://fixture.example/v1/models");
          return new Response(
            JSON.stringify({
              data: [{ id: "first-model" }, { id: "second-model" }],
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      );
      const models = await port.inventory(saved.id, "second-model");
      assert.deepEqual(
        models.map((item) => [item.id, item.selected]),
        [
          ["first-model", false],
          ["second-model", true],
        ],
      );
    } finally {
      native.close();
    }
  });
});
