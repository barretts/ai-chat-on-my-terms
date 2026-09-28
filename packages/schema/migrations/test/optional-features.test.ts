import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { OPTIONAL_FEATURES_MIGRATION } from "../../extensions/register.js";
import { migrateSQLite, type SQLiteMigrationAdapter } from "../runner.js";

function adapter(database: DatabaseSync): SQLiteMigrationAdapter {
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

test("optional feature migration registers after core and supports local records", async () => {
  assert.equal(OPTIONAL_FEATURES_MIGRATION.version, 2);
  const db = new DatabaseSync(":memory:");
  try {
    assert.equal(await migrateSQLite(adapter(db)), 2);
    db.prepare(
      "INSERT INTO personas (id, name, is_default) VALUES (?, ?, ?)",
    ).run("persona", "Helpful", 1);
    db.prepare("INSERT INTO local_groups (id, name) VALUES (?, ?)").run(
      "group",
      "Family",
    );
    db.prepare(
      "INSERT INTO group_members (group_id, participant_id, display_name, role) VALUES (?, ?, ?, ?)",
    ).run("group", "device-a", "A", "owner");
    db.prepare("INSERT INTO sync_cursors (peer_device_id) VALUES (?)").run(
      "device-a",
    );
    db.prepare(
      "INSERT INTO media_assets (id, media_type, local_uri, mime_type, byte_length) VALUES (?, ?, ?, ?, ?)",
    ).run("asset", "image", "file:///private/photo", "image/jpeg", 12);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM group_members").get()?.n,
      1,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n,
      2,
    );
  } finally {
    db.close();
  }
});

test("upgrades a populated core-v1 database without losing messages", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const core = await readFile(
      new URL("../../core/001_core.sql", import.meta.url),
      "utf8",
    );
    db.exec(core);
    db.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
    db.prepare(
      "INSERT INTO schema_migrations (version, name) VALUES (1, '0001-core')",
    ).run();
    db.prepare(
      "INSERT INTO providers (id, kind, name) VALUES ('p', 'local', 'Fixture')",
    ).run();
    db.prepare(
      "INSERT INTO models (id, provider_id, name) VALUES ('m', 'p', 'model')",
    ).run();
    db.prepare(
      "INSERT INTO conversations (id, title) VALUES ('c', 'Existing')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, parts_json, sequence) VALUES ('msg', 'c', 'user', '[]', 0)",
    ).run();

    assert.equal(await migrateSQLite(adapter(db)), 2);
    assert.equal(
      db.prepare("SELECT title FROM conversations WHERE id = 'c'").get()?.title,
      "Existing",
    );
    assert.equal(
      db.prepare("SELECT parts_json FROM messages WHERE id = 'msg'").get()
        ?.parts_json,
      "[]",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("PostgreSQL service schema persists relay routing metadata without chat history", async () => {
  const sql = await readFile(
    new URL(
      "../../../../services/api/schema/001_services.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE locallab\.pairing_routes/);
  assert.match(sql, /CREATE TABLE locallab\.relay_connections/);
  assert.match(sql, /CREATE TABLE locallab\.sync_device_cursors/);
  assert.doesNotMatch(
    sql,
    /CREATE TABLE\s+(?:locallab\.)?(?:messages|conversations|chat_history|relay_frames)\b/i,
  );
  assert.match(sql, /end-to-end encrypted/i);
});
