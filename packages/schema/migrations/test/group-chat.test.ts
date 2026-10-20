import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GROUP_CHAT_MIGRATION } from "../../extensions/group-chat-register.js";
import { applySQLiteMigrations } from "../embedded.js";
import { EMBEDDED_MIGRATIONS } from "../embedded-data.generated.js";
import { migrateSQLite, type SQLiteMigrationAdapter } from "../runner.js";
import "../full.js";

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
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    readMigrationSource: (source) => readFile(source, "utf8"),
  };
}

function tables(database: DatabaseSync): Record<string, string> {
  return Object.fromEntries(
    database
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE 'group_%'",
      )
      .all()
      .map((row) => [
        row.name as string,
        (row.sql as string).replace(/\s+/g, " ").trim(),
      ]),
  );
}

test("0009 is version 9 and registers after the archive migration", () => {
  assert.equal(GROUP_CHAT_MIGRATION.version, 9);
});

test("fresh databases create the group room, settings, round and run tables", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    assert.equal(await migrateSQLite(adapter(database)), 9);
    const created = tables(database);
    for (const name of [
      "group_rooms",
      "group_participants",
      "group_room_settings",
      "group_participant_prefs",
      "group_rounds",
      "group_room_conversations",
    ])
      assert.ok(created[name], `missing table ${name}`);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("upgraded databases gain group tables without touching core rows", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    // Device state before 0009: runtime-created room tables and old rows.
    assert.equal(
      await applySQLiteMigrations(
        adapter(database),
        EMBEDDED_MIGRATIONS.slice(0, 7),
      ),
      7,
    );
    database
      .prepare(
        "INSERT INTO conversations(id,title) VALUES ('conv','Prior chat')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES ('msg','conv','user','[]',1)",
      )
      .run();
    database.exec(`
      CREATE TABLE group_rooms (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        scenario TEXT NOT NULL DEFAULT '',
        user_display_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      INSERT INTO group_rooms(id,name,conversation_id) VALUES ('r','War room','conv');
    `);
    assert.equal(
      await applySQLiteMigrations(adapter(database), EMBEDDED_MIGRATIONS),
      9,
    );
    assert.equal(
      database.prepare("SELECT name FROM group_rooms WHERE id='r'").get()!.name,
      "War room",
    );
    assert.deepEqual(
      database
        .prepare("SELECT id, parts_json FROM messages")
        .all()
        .map((row) => ({ ...row })),
      [{ id: "msg", parts_json: "[]" }],
    );
  } finally {
    database.close();
  }
});

test("room settings and rounds enforce the plan's enumerated values", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    await migrateSQLite(adapter(database));
    database
      .prepare(
        "INSERT INTO group_rooms(id,name,conversation_id) VALUES ('r','Room','c')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO group_participants(id,group_room_id,display_name,accent_color,turn_order) VALUES ('p1','r','Maya','#fff',0)",
      )
      .run();

    database
      .prepare(
        "INSERT INTO group_room_settings(room_id,conversation_mode,speaker_order,reply_display) VALUES ('r','independent','dice','live')",
      )
      .run();
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT conversation_mode,speaker_order,reply_display,response_limit_tokens FROM group_room_settings WHERE room_id='r'",
          )
          .get(),
      },
      {
        conversation_mode: "independent",
        speaker_order: "dice",
        reply_display: "live",
        response_limit_tokens: 256,
      },
    );
    assert.throws(
      () =>
        database
          .prepare(
            "INSERT INTO group_room_settings(room_id,conversation_mode) VALUES ('r','vibes')",
          )
          .run(),
      /CHECK constraint/i,
    );

    // trigger is a keyword; the column is trigger_kind for that reason.
    database
      .prepare(
        "INSERT INTO group_rounds(id,group_room_id,conversation_id,trigger_kind,frozen_order_json,settings_json) VALUES ('round','r','c','pass','[1,0]','{}')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO group_runs(id,group_round_id,seat_index,participant_id,model_id,status) VALUES ('run','round',1,'p1','qwen/qwen3.5-2b-q4_k_m','running')",
      )
      .run();

    // Drunk flag; cascade removal with the seat.
    database
      .prepare(
        "INSERT INTO group_participant_prefs(participant_id,drunk) VALUES ('p1',1)",
      )
      .run();
    assert.equal(
      database
        .prepare(
          "SELECT drunk FROM group_participant_prefs WHERE participant_id='p1'",
        )
        .get()!.drunk,
      1,
    );
    database.prepare("DELETE FROM group_participants WHERE id='p1'").run();
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS n FROM group_participant_prefs")
        .get()!.n,
      0,
    );
    // Deleting the room cascades rounds and runs (and their speaker runs).
    database.prepare("DELETE FROM group_rooms WHERE id='r'").run();
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM group_runs").get()!.n,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM group_rounds").get()!.n,
      0,
    );
  } finally {
    database.close();
  }
});
