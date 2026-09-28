import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateSQLite, type SQLiteMigrationAdapter } from "../runner.js";

function makeAdapter(database: DatabaseSync): SQLiteMigrationAdapter {
  return {
    exec: async (sql) => database.exec(sql),
    all: async <T extends Record<string, unknown>>(sql: string) =>
      database.prepare(sql).all() as T[],
    transaction: async <T>(work: () => Promise<T>) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = await work();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    readMigrationSource: (source) => readFile(source, "utf8"),
  };
}

test("fresh database migrates deterministically and is idempotent", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const adapter = makeAdapter(database);
    assert.equal(await migrateSQLite(adapter), 1);
    assert.equal(await migrateSQLite(adapter), 1);

    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    assert.deepEqual(tables, [
      "conversations",
      "jobs",
      "messages",
      "models",
      "providers",
      "runs",
      "schema_migrations",
    ]);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("core schema persists structured assistant parts and interrupted jobs", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    await migrateSQLite(makeAdapter(database));
    database
      .prepare("INSERT INTO providers (id, kind, name) VALUES (?, ?, ?)")
      .run("p", "remote", "Fixture");
    database
      .prepare("INSERT INTO models (id, provider_id, name) VALUES (?, ?, ?)")
      .run("m", "p", "model");
    database
      .prepare("INSERT INTO conversations (id, title) VALUES (?, ?)")
      .run("c", "Smoke");
    database
      .prepare(
        "INSERT INTO runs (id, conversation_id, model_id, status) VALUES (?, ?, ?, ?)",
      )
      .run("r", "c", "m", "running");
    database
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, parts_json, sequence, run_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "msg",
        "c",
        "assistant",
        JSON.stringify([
          {
            type: "tool-call",
            name: "calculator",
            input: { expression: "1 + 1" },
          },
        ]),
        0,
        "r",
      );
    database
      .prepare(
        "INSERT INTO jobs (id, run_id, kind, status) VALUES (?, ?, ?, ?)",
      )
      .run("j", null, "interrupted-download", "running");

    const partsJson = database
      .prepare("SELECT parts_json FROM messages WHERE id = ?")
      .get("msg") as { parts_json: string };
    const job = database
      .prepare("SELECT status FROM jobs WHERE id = ?")
      .get("j") as { status: string };
    assert.equal(JSON.parse(partsJson.parts_json)[0].type, "tool-call");
    assert.equal(job.status, "running");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});
