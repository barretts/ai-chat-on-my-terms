import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { ExtensionSQLiteRepositories } from "../src/index.js";
import {
  migrateSQLite,
  type SQLiteMigrationAdapter,
} from "../../../../schema/migrations/full.js";

function port(database: DatabaseSync): SQLiteDatabasePort {
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

function migrationPort(database: DatabaseSync): SQLiteMigrationAdapter {
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

const id = (n: string) => `018f0000-0000-7000-8000-${n.padStart(12, "0")}`;

test("optional persona, memory and group records round-trip with sync tombstones", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    await migrateSQLite(migrationPort(db));
    const repos = new ExtensionSQLiteRepositories(port(db));
    await repos.savePersona({
      id: id("1"),
      name: "Guide",
      prompt: "Be clear",
      isDefault: true,
    });
    assert.deepEqual((await repos.listPersonas())[0], {
      id: id("1"),
      name: "Guide",
      description: null,
      prompt: "Be clear",
      isDefault: true,
      createdAt: (await repos.listPersonas())[0]!.createdAt,
      updatedAt: (await repos.listPersonas())[0]!.updatedAt,
    });
    await repos.saveMemory({
      id: id("2"),
      content: "Prefers concise answers",
      metadata: { source: "user" },
    });
    const saved = await repos.getMemory(id("2"));
    assert.equal(saved?.content, "Prefers concise answers");
    assert.deepEqual(saved?.metadata, { source: "user" });
    await repos.createGroup({ id: id("3"), name: "Household" });
    await repos.addGroupMember({
      groupId: id("3"),
      participantId: id("4"),
      displayName: "Alex",
      role: "owner",
    });
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM group_members WHERE group_id = ?")
        .get(id("3"))?.n,
      1,
    );

    const tombstone = {
      id: id("5"),
      entityType: "memory",
      entityId: id("2"),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      revision: { wallMs: 1, counter: 0, deviceId: id("6") },
    };
    assert.equal(await repos.tombstoneMemory(tombstone), true);
    assert.equal(await repos.getMemory(id("2")), null);
    assert.equal(
      (await repos.getMemory(id("2"), true))?.deletedAt !== null,
      true,
    );
    assert.equal(await repos.tombstoneMemory(tombstone), false);

    await repos.advanceSyncCursor(id("7"), 8);
    await repos.advanceSyncCursor(id("7"), 3);
    assert.equal(
      db
        .prepare(
          "SELECT last_sequence FROM sync_cursors WHERE peer_device_id = ?",
        )
        .get(id("7"))?.last_sequence,
      8,
    );
    await repos.saveLocalAccount({ id: id("12"), accountType: "local" });
    await repos.saveConsent({
      id: id("8"),
      accountId: id("12"),
      purpose: "analytics",
      granted: false,
      policyVersion: "v1",
    });
    assert.equal(
      db
        .prepare("SELECT granted FROM consent_records WHERE id = ?")
        .get(id("8"))?.granted,
      0,
    );
    await repos.createArenaSession({
      id: id("9"),
      status: "ready",
      config: { participants: 2 },
    });
    await repos.createPairingSession({
      id: id("10"),
      state: "pending",
      expiresAt: "2026-12-01T00:00:00Z",
    });
    await repos.recordSyncOperation({
      id: id("11"),
      peerDeviceId: id("7"),
      sequence: 1,
      entityType: "memory",
      entityId: id("2"),
      operation: "tombstone",
      revision: { wallMs: 1, counter: 0, deviceId: id("6") },
    });
    assert.equal(
      db.prepare("SELECT status FROM arena_sessions WHERE id = ?").get(id("9"))
        ?.status,
      "ready",
    );
    assert.equal(
      db
        .prepare("SELECT state FROM pairing_sessions WHERE id = ?")
        .get(id("10"))?.state,
      "pending",
    );
    assert.equal(
      db
        .prepare("SELECT operation FROM sync_operations WHERE id = ?")
        .get(id("11"))?.operation,
      "tombstone",
    );
  } finally {
    db.close();
  }
});

test("media and embedded attachment metadata commit atomically", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    await migrateSQLite(migrationPort(db));
    const repos = new ExtensionSQLiteRepositories(port(db));
    await assert.rejects(
      repos.saveMediaAsset({
        id: id("10"),
        mediaType: "invalid" as "image",
        localUri: "file:///asset",
        mimeType: "image/png",
        byteLength: 12,
        attachment: { id: id("11"), extractedText: "caption" },
      }),
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM media_assets").get()?.n,
      0,
    );
    await repos.saveMediaAsset({
      id: id("10"),
      mediaType: "image",
      localUri: "file:///asset",
      mimeType: "image/png",
      byteLength: 12,
      attachment: { id: id("11"), extractedText: "caption" },
    });
    const row = db
      .prepare("SELECT metadata_json FROM media_assets WHERE id = ?")
      .get(id("10")) as { metadata_json: string };
    assert.deepEqual(JSON.parse(row.metadata_json), {
      attachment: { id: id("11"), extractedText: "caption" },
    });
  } finally {
    db.close();
  }
});

test("core v1 chat migrates to optional records without changing IDs or message bodies", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const core = await readFile(
      new URL("../../../../schema/core/001_core.sql", import.meta.url),
      "utf8",
    );
    db.exec(core);
    db.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL CHECK (version > 0), name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
    db.prepare(
      "INSERT INTO schema_migrations (version, name) VALUES (1, '0001-core')",
    ).run();
    db.prepare(
      "INSERT INTO providers (id, kind, name) VALUES ('p', 'local', 'Local')",
    ).run();
    db.prepare(
      "INSERT INTO models (id, provider_id, name) VALUES ('m', 'p', 'model')",
    ).run();
    db.prepare(
      "INSERT INTO conversations (id, title) VALUES ('c', 'Keep this')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, parts_json, sequence) VALUES ('message-unchanged', 'c', 'user', '[{\"type\":\"text\",\"text\":\"preserve\"}]', 0)",
    ).run();

    assert.equal(await migrateSQLite(migrationPort(db)), 7);
    const preserved = db
      .prepare("SELECT id, parts_json FROM messages")
      .get() as {
      id: string;
      parts_json: string;
    };
    assert.equal(preserved.id, "message-unchanged");
    assert.equal(preserved.parts_json, '[{"type":"text","text":"preserve"}]');
    assert.equal(
      db.prepare("SELECT title FROM conversations WHERE id = 'c'").get()?.title,
      "Keep this",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
