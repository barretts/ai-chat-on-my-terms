import { describe, expect, it } from "vitest";
import { ModelLifecycleRegistry } from "@locallab/models-imports";
import { applyModelSelection, modelStatus } from "./index";
import { DatabaseSync } from "node:sqlite";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { SQLiteConnectionRepository } from "../connections";
import { SQLiteChatProviderRegistry } from "../../composition/chat/providers";
import { SQLiteModelSelectionRepository } from "./selection";
import { createConnectionModels } from "./connections";
import type { SecretStore } from "@locallab/security-secrets";

describe("model manager actions", () => {
  it("moves selection and retains downloaded/loaded server states", () => {
    const registry = new ModelLifecycleRegistry();
    applyModelSelection(registry, "old-model", {
      id: "old-model",
      installed: true,
      loaded: true,
      selected: true,
    });
    applyModelSelection(registry, "new-model", {
      id: "new-model",
      installed: true,
      loaded: false,
      selected: false,
    });
    expect(registry.get("old-model")?.selected).toBe(false);
    expect(registry.get("new-model")).toMatchObject({
      selected: true,
      downloaded: true,
      loaded: false,
    });
  });
  it("renders catalog and remote lifecycle states", () => {
    expect(modelStatus({})).toEqual(["Catalog"]);
    expect(modelStatus({ imported: true })).toEqual(["Imported"]);
    expect(
      modelStatus({ installed: true, loaded: true, selected: true }),
    ).toEqual(["Downloaded", "Loaded", "Selected"]);
  });
});

function sqlitePort(database: DatabaseSync): SQLiteDatabasePort {
  const port: SQLiteDatabasePort = {
    execAsync: async (sql) => {
      database.exec(sql);
    },
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      database.prepare(sql).run(...params),
    getAllAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      database.prepare(sql).all(...params) as T[],
    getFirstAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      (database.prepare(sql).get(...params) as T | undefined) ?? null,
    withTransactionAsync: async (work) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        await work(port);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return port;
}

describe("durable exact server/model binding", () => {
  it("updates linked chat settings, rejects moving credentials, invalidates changed kinds and deletes selections atomically", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE conversations(id TEXT PRIMARY KEY); INSERT INTO conversations VALUES('chat')",
    );
    try {
      const db = sqlitePort(database);
      const connections = new SQLiteConnectionRepository(
        db,
        () => "00000000-0000-7000-8000-000000000071",
      );
      const registry = new SQLiteChatProviderRegistry(db);
      const selection = new SQLiteModelSelectionRepository(db);
      await registry.initialize();
      await selection.initialize();
      const ref = "sec_00000000-0000-4000-8000-000000000001" as never;
      const saved = await connections.save({
        name: "Original",
        kind: "llama.cpp",
        host: "https://old.test",
        headerRefs: [ref],
        customHeadersEnabled: true,
      });
      await registry.save({
        id: saved.id,
        label: saved.name,
        kind: "compatible",
        endpoint: saved.host,
        modelId: "Exact/Case:tag",
        headerRefs: [ref],
      });
      await registry.select("chat", saved.id);
      await selection.chooseConnection(saved.id);
      await selection.selectModel(saved.id, "Exact/Case:tag");
      await expect(
        connections.save({
          id: saved.id,
          name: "Forbidden",
          kind: "llama.cpp",
          host: "https://new.test",
        }),
      ).rejects.toThrow("Credentials are bound");
      expect((await registry.selected("chat"))?.endpoint).toBe(
        "https://old.test",
      );
      await connections.save({
        id: saved.id,
        name: "Renamed",
        kind: "compatible",
        host: "https://old.test",
        headerRefs: [],
        customHeadersEnabled: false,
      });
      expect(await registry.selected("chat")).toMatchObject({
        label: "Renamed",
        modelId: "Exact/Case:tag",
      });
      expect((await registry.selected("chat"))?.headerRefs).toBeUndefined();
      await connections.save({
        id: saved.id,
        name: "Renamed",
        kind: "compatible",
        host: "https://new.test",
      });
      expect((await registry.selected("chat"))?.endpoint).toBe(
        "https://new.test",
      );
      expect((await selection.active())?.modelId).toBe("Exact/Case:tag");
      await connections.save({
        id: saved.id,
        name: "Ollama",
        kind: "ollama",
        host: "https://new.test",
      });
      expect(await registry.selected("chat")).toBeUndefined();
      expect(await registry.get(saved.id)).toBeUndefined();
      expect((await selection.active())?.modelId).toBeNull();
      await registry.save({
        id: saved.id,
        label: "Ollama",
        kind: "ollama",
        endpoint: "https://new.test",
        modelId: "new:tag",
      });
      await registry.select("chat", saved.id);
      await selection.selectModel(saved.id, "new:tag");
      await connections.delete(saved.id);
      expect(await registry.selected("chat")).toBeUndefined();
      expect(await registry.get(saved.id)).toBeUndefined();
      expect(await selection.active()).toBeNull();
      expect(await connections.list()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rolls back both connection and linked registration when a registry update fails", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      const db = sqlitePort(database);
      const connections = new SQLiteConnectionRepository(
        db,
        () => "00000000-0000-7000-8000-000000000072",
      );
      const registry = new SQLiteChatProviderRegistry(db);
      await registry.initialize();
      const saved = await connections.save({
        name: "Original",
        kind: "llama.cpp",
        host: "https://old.test",
      });
      await registry.save({
        id: saved.id,
        label: "Original",
        kind: "compatible",
        endpoint: saved.host,
        modelId: "exact",
      });
      database.exec(
        "CREATE TRIGGER reject_linked_update BEFORE UPDATE ON chat_provider_connections BEGIN SELECT RAISE(ABORT,'fixture registry refusal'); END",
      );
      await expect(
        connections.save({
          id: saved.id,
          name: "Blocked edit",
          kind: "llama.cpp",
          host: "https://new.test",
        }),
      ).rejects.toThrow("fixture registry refusal");
      expect((await connections.list())[0]).toMatchObject({
        name: "Original",
        host: "https://old.test",
      });
      expect(await registry.get(saved.id)).toMatchObject({
        label: "Original",
        endpoint: "https://old.test",
        modelId: "exact",
      });
    } finally {
      database.close();
    }
  });

  it("lists exact compatible IDs without inferring installed or loaded state and rejects mismatched connections", async () => {
    const requests: string[] = [];
    const secrets: SecretStore = {
      put: async () => {
        throw new Error("unused");
      },
      remove: async () => {},
      resolveHeaders: async () => ({}),
    };
    const port = createConnectionModels(
      {
        id: "server",
        name: "Server",
        kind: "llama.cpp",
        host: "https://server.test",
        credentialRef: null,
        headerRefs: [],
        customHeadersEnabled: false,
        position: 0,
        createdAt: "now",
        updatedAt: "now",
      },
      secrets,
      async (input) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({ data: [{ id: "Exact/Case:tag" }] }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );
    expect(await port.inventory("server", "Exact/Case:tag")).toEqual([
      { id: "Exact/Case:tag", available: true, selected: true },
    ]);
    expect(port.pull).toBeUndefined();
    expect(port.delete).toBeUndefined();
    await expect(port.inventory("wrong-server")).rejects.toThrow(
      "does not match",
    );
    expect(requests).toEqual(["https://server.test/v1/models"]);
  });
});
