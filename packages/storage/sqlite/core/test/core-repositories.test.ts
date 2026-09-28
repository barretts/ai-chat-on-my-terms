import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CoreSQLiteRepositories,
  type SQLiteDatabasePort,
  type SqliteBindValue,
} from "../src/index.js";

function adapter(database: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => database.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      database.prepare(sql).run(...params),
    getFirstAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      (database.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      database.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        await work();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function createReadyDatabase(path: string): Promise<DatabaseSync> {
  const database = new DatabaseSync(path);
  const coreSql = await readFile(
    new URL("../../../../schema/core/001_core.sql", import.meta.url),
    "utf8",
  );
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(coreSql);
  database
    .prepare("INSERT INTO providers (id, kind, name) VALUES (?, ?, ?)")
    .run("provider", "fixture", "Fixture provider");
  database
    .prepare("INSERT INTO models (id, provider_id, name) VALUES (?, ?, ?)")
    .run("model", "provider", "Fixture model");
  return database;
}

test("conversation and streamed response survive database reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locallab-storage-"));
  const path = join(directory, "local.sqlite");
  try {
    const first = await createReadyDatabase(path);
    const repositories = new CoreSQLiteRepositories(adapter(first));
    await repositories.createConversation({
      id: "conversation",
      title: "Local",
    });
    await repositories.beginRun(
      "conversation",
      { id: "run", modelId: "model" },
      {
        id: "user-message",
        role: "user",
        parts: [{ type: "text", text: "Hi" }],
      },
    );
    await repositories.completeRun("run", {
      id: "assistant-message",
      role: "assistant",
      parts: [{ type: "text", text: "Hello from SQLite" }],
    });
    first.close();

    const reopened = new DatabaseSync(path);
    try {
      const persisted = await new CoreSQLiteRepositories(
        adapter(reopened),
      ).listMessages("conversation");
      assert.deepEqual(
        persisted.map((message) => message.role),
        ["user", "assistant"],
      );
      assert.deepEqual(persisted[1]?.parts, [
        { type: "text", text: "Hello from SQLite" },
      ]);
      assert.equal(
        (
          reopened
            .prepare("SELECT status FROM runs WHERE id = 'run'")
            .get() as { status: string }
        ).status,
        "completed",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed run cannot commit without assistant content", async () => {
  const database = await createReadyDatabase(":memory:");
  try {
    const repositories = new CoreSQLiteRepositories(adapter(database));
    await repositories.createConversation({ id: "conversation" });
    await repositories.beginRun(
      "conversation",
      { id: "run", modelId: "model" },
      {
        id: "user-message",
        role: "user",
        parts: [{ type: "text", text: "Hi" }],
      },
    );
    await assert.rejects(
      repositories.completeRun("run", {
        id: "empty-assistant",
        role: "assistant",
        parts: [],
      }),
      /persisted assistant content/,
    );
    assert.equal(
      (
        database.prepare("SELECT status FROM runs WHERE id = 'run'").get() as {
          status: string;
        }
      ).status,
      "running",
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM messages").get()?.count,
      1,
    );
  } finally {
    database.close();
  }
});
