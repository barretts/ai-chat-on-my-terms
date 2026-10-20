import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import "../full.js";
import { getMigrations } from "../registry.js";
import { migrateSQLite, type SQLiteMigrationAdapter } from "../runner.js";

function adapter(database: DatabaseSync): SQLiteMigrationAdapter {
  return {
    exec: async (sql) => database.exec(sql),
    all: async <T extends Record<string, unknown>>(sql: string) =>
      database.prepare(sql).all() as T[],
    transaction: async <T>(work: () => Promise<T>) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const value = await work();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    readMigrationSource: (source) => readFile(source, "utf8"),
  };
}

test("full migration chain registers and applies the versioned feature tables", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(
      getMigrations().map(({ name }) => name),
      [
        "0001-core",
        "0002-optional-features",
        "0003-scheduled-jobs",
        "0004-persona-library",
        "0005-memory-extraction",
        "0006-arena-engine",
        "0007-tool-engine",
        "0008-conversation-archive",
        "0009-group-chat",
      ],
    );
    assert.equal(await migrateSQLite(adapter(database)), 9);
    assert.ok(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_jobs'",
        )
        .get(),
    );
    for (const name of [
      "persona_profiles",
      "memory_extraction_runs",
      "arena_runs",
      "tool_engine_invocations",
      "conversation_archive_state",
      "conversation_delete_cleanups",
      "group_rooms",
      "group_participants",
      "group_room_settings",
      "group_participant_prefs",
      "group_rounds",
      "group_runs",
      "group_room_conversations",
    ]) {
      assert.ok(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name),
      );
    }
    assert.equal(await migrateSQLite(adapter(database)), 9);
  } finally {
    database.close();
  }
});
