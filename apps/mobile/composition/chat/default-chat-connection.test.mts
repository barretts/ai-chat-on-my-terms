import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { HostScopedSecretStore } from "@locallab/security-secrets";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { SQLiteModelSelectionRepository } from "../../features/models/selection";
import {
  STRATA_CONNECTION_ID,
  STRATA_DEFAULT_BASE_URL,
  STRATA_DEFAULT_MODEL_ID,
  seedDefaultChatConnection,
} from "./default-chat-connection";
import { SQLiteChatProviderRegistry } from "./providers";

const apiKey = "fixture-strata-key-never-persist";

function adapter(native: DatabaseSync): SQLiteDatabasePort {
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
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "locallab-default-conn-"));
  const filename = join(directory, "chat.sqlite");
  const native = new DatabaseSync(filename);
  const secureValues = new Map<string, string>();
  const secrets = new HostScopedSecretStore(
    {
      get: async (key) => secureValues.get(key) ?? null,
      set: async (key, value) => {
        secureValues.set(key, value);
      },
      delete: async (key) => {
        secureValues.delete(key);
      },
    },
    "default-connection-fixture",
  );
  return {
    db: adapter(native),
    secrets,
    filename,
    close: async () => {
      native.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("seedDefaultChatConnection", () => {
  it("seeds the strata connection as the default selection", async () => {
    const { db, secrets, filename, close } = await fixture();
    try {
      await seedDefaultChatConnection(db, secrets, { apiKey });
      const registry = new SQLiteChatProviderRegistry(db);
      const saved = await registry.get(STRATA_CONNECTION_ID);
      assert.ok(saved);
      assert.equal(saved.kind, "compatible");
      assert.equal(saved.endpoint, STRATA_DEFAULT_BASE_URL);
      assert.equal(saved.modelId, STRATA_DEFAULT_MODEL_ID);
      assert.equal(saved.cleartextAuthorized, true);
      assert.ok(saved.credentialRef);
      const headers = await secrets.resolveHeaders(
        new URL(STRATA_DEFAULT_BASE_URL).origin,
        [saved.credentialRef],
      );
      assert.equal(headers.authorization, `Bearer ${apiKey}`);
      const phoneChoice = await db.getFirstAsync<{ provider_id: string }>(
        "SELECT provider_id FROM phone_model_choice_local WHERE singleton=1",
      );
      assert.equal(phoneChoice?.provider_id, STRATA_CONNECTION_ID);
      const selection = await new SQLiteModelSelectionRepository(db).active();
      assert.deepEqual(selection, {
        connectionId: STRATA_CONNECTION_ID,
        modelId: STRATA_DEFAULT_MODEL_ID,
      });
      const onDisk = await readFile(filename);
      assert.ok(!onDisk.includes(Buffer.from(apiKey)));
    } finally {
      await close();
    }
  });

  it("does nothing without an API key", async () => {
    const { db, secrets, close } = await fixture();
    try {
      await seedDefaultChatConnection(db, secrets, {});
      const registry = new SQLiteChatProviderRegistry(db);
      await registry.initialize();
      assert.equal(await registry.get(STRATA_CONNECTION_ID), undefined);
    } finally {
      await close();
    }
  });

  it("never overwrites a saved connection or the user's model choice", async () => {
    const { db, secrets, close } = await fixture();
    try {
      await seedDefaultChatConnection(db, secrets, {
        apiKey,
        modelId: "first-model",
      });
      await db.runAsync(
        "UPDATE phone_model_choice_local SET provider_id=? WHERE singleton=1",
        STRATA_CONNECTION_ID,
      );
      const selections = new SQLiteModelSelectionRepository(db);
      await selections.chooseConnection(STRATA_CONNECTION_ID);
      await selections.selectModel(STRATA_CONNECTION_ID, "user-picked-model");
      await seedDefaultChatConnection(db, secrets, {
        apiKey: "second-key-never-persist",
        modelId: "second-model",
      });
      const saved = await new SQLiteChatProviderRegistry(db).get(
        STRATA_CONNECTION_ID,
      );
      assert.equal(saved?.modelId, "first-model");
      const headers = await secrets.resolveHeaders(
        new URL(STRATA_DEFAULT_BASE_URL).origin,
        [saved!.credentialRef!],
      );
      assert.equal(headers.authorization, `Bearer ${apiKey}`);
      assert.deepEqual(await selections.active(), {
        connectionId: STRATA_CONNECTION_ID,
        modelId: "user-picked-model",
      });
    } finally {
      await close();
    }
  });

  it("restores the credential in a new secret store without touching the row", async () => {
    const { db, secrets, close } = await fixture();
    try {
      await seedDefaultChatConnection(db, secrets, { apiKey });
      const registry = new SQLiteChatProviderRegistry(db);
      const before = await registry.get(STRATA_CONNECTION_ID);
      const otherValues = new Map<string, string>();
      const newTab = new HostScopedSecretStore(
        {
          get: async (key) => otherValues.get(key) ?? null,
          set: async (key, value) => {
            otherValues.set(key, value);
          },
          delete: async (key) => {
            otherValues.delete(key);
          },
        },
        "default-connection-fixture",
      );
      await seedDefaultChatConnection(db, newTab, { apiKey });
      const after = await registry.get(STRATA_CONNECTION_ID);
      assert.ok(after?.credentialRef);
      assert.notEqual(after?.credentialRef, before?.credentialRef);
      assert.equal(after?.modelId, before?.modelId);
      assert.equal(after?.endpoint, before?.endpoint);
      assert.equal(after?.kind, before?.kind);
      const headers = await newTab.resolveHeaders(
        new URL(STRATA_DEFAULT_BASE_URL).origin,
        [after!.credentialRef!],
      );
      assert.equal(headers.authorization, `Bearer ${apiKey}`);
    } finally {
      await close();
    }
  });
});
