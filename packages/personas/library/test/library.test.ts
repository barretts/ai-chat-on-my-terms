import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createRequire } from "node:module";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  migrateSQLite,
  type SQLiteMigrationAdapter,
} from "@locallab/schema/migrations";
import {
  DEFAULT_PERSONA_ID,
  STARTER_PERSONA_ID,
  PersonaLibraryError,
  SQLitePersonaLibrary,
} from "../src/index.js";
// The mobile app uses CommonJS under Node's tsx loader; load its real facade without copying it.
const { sharedMobileDatabase } = createRequire(import.meta.url)(
  "../../../../apps/mobile/platform/database.ts",
) as typeof import("../../../../apps/mobile/platform/database.js");

const id = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const deviceId = id(900);
const fixedNow = "2026-09-26T12:00:00.000Z";

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
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  };
}
function migrationAdapter(database: DatabaseSync): SQLiteMigrationAdapter {
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
function library(
  database: DatabaseSync,
  start = 100,
  now = () => new Date(fixedNow),
) {
  let sequence = start;
  return new SQLitePersonaLibrary(adapter(database), {
    createId: () => id(sequence++),
    deviceId,
    now,
  });
}
const errorCode = (code: PersonaLibraryError["code"]) => (cause: unknown) =>
  cause instanceof PersonaLibraryError && cause.code === code;

test("file-backed upgrade preserves legacy Default and never reseeds a deleted starter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locallab-personas-upgrade-"));
  const path = join(directory, "personas.sqlite");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    await migrateSQLite(migrationAdapter(database));
    database
      .prepare(
        "INSERT INTO personas (id,name,description,prompt,is_default,created_at,updated_at) VALUES (?,?,?,?,1,?,?)",
      )
      .run(
        id(3),
        "Existing Default",
        "Fixture profile",
        "Existing prompt",
        fixedNow,
        fixedNow,
      );
    const store = library(database);
    await store.initialize();
    const records = await store.list();
    assert.equal(records.length, 2);
    assert.equal(records[0]?.id, id(3));
    assert.equal(records[0]?.prompt, "Existing prompt");
    assert.equal(await store.get(DEFAULT_PERSONA_ID), null);
    await store.delete(STARTER_PERSONA_ID);
    assert.equal((await store.tombstones())[0]?.entityId, STARTER_PERSONA_ID);
    // Even an upgrade that retries seed installation sees the independent deletion marker.
    database
      .prepare(
        "DELETE FROM persona_library_state WHERE key='seed.locallab-assistant.v1'",
      )
      .run();
    database.close();
    database = new DatabaseSync(path);
    await migrateSQLite(migrationAdapter(database));
    const restored = library(database, 200);
    await restored.initialize();
    await restored.initialize();
    assert.deepEqual(
      (await restored.list()).map((record) => record.id),
      [id(3)],
    );
    assert.equal(
      database
        .prepare(
          "SELECT value FROM persona_library_state WHERE key='seed.locallab-assistant.deleted'",
        )
        .get()?.value,
      "deleted",
    );
    await assert.rejects(
      restored.create({ id: STARTER_PERSONA_ID, name: "Resurrection" }),
      errorCode("conflict"),
    );
    await assert.rejects(restored.delete(id(3)), errorCode("protected"));
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("file-backed CRUD retains avatar, appearance and profile fields with monotonic revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locallab-personas-crud-"));
  const path = join(directory, "personas.sqlite");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    await migrateSQLite(migrationAdapter(database));
    let time = new Date(fixedNow);
    const store = library(database, 100, () => time);
    await store.initialize();
    const created = await store.create({
      name: "  Fixture   Guide ",
      description: "A fixture guide",
      prompt: "Use fixture context.",
      photoAttachmentId: id(400),
      appearance: {
        accentColor: "#123ABC",
        backgroundColor: "#F0F0F0",
        avatarShape: "square",
      },
      profile: { biography: "Profile field retained", localOnly: true },
    });
    assert.equal(created.name, "Fixture Guide");
    assert.equal(created.revision.counter, 0);
    const edited = await store.update(created.id, {
      name: "Fixture Editor",
      prompt: "Updated fixture prompt.",
      expectedRevision: created.revision,
    });
    assert.equal(edited.photoAttachmentId, id(400));
    assert.deepEqual(edited.appearance, created.appearance);
    assert.equal(edited.profile.biography, "Profile field retained");
    assert.equal(edited.revision.counter, 1);
    await assert.rejects(
      store.update(created.id, {
        name: "Stale edit",
        expectedRevision: created.revision,
      }),
      errorCode("conflict"),
    );
    time = new Date("2026-09-25T12:00:00.000Z");
    const backwards = await store.update(created.id, {
      description: "Clock moved backwards",
    });
    assert.equal(backwards.revision.wallMs, edited.revision.wallMs);
    assert.equal(backwards.revision.counter, 2);
    await assert.rejects(
      store.update(created.id, {
        appearance: { accentColor: "https://invalid" },
      }),
      errorCode("invalid"),
    );
    await assert.rejects(
      store.update(created.id, {
        profile: { credentialRef: "fixture-disallowed" },
      }),
      errorCode("invalid"),
    );
    const expected = await store.get(created.id);
    database.close();
    database = new DatabaseSync(path);
    const restored = library(database, 300);
    await restored.initialize();
    assert.deepEqual(await restored.get(created.id), expected);
    await restored.delete(created.id);
    await restored.delete(created.id);
    assert.equal(await restored.get(created.id), null);
    assert.equal((await restored.tombstones())[0]?.revision.counter, 3);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("switching, editing and deleting Personas retain transcript and immutable run identity after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locallab-personas-context-"));
  const path = join(directory, "personas.sqlite");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    await migrateSQLite(migrationAdapter(database));
    const store = library(database);
    await store.initialize();
    database
      .prepare(
        "INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)",
      )
      .run(id(500), "Fixture conversation", fixedNow, fixedNow);
    database
      .prepare(
        "INSERT INTO messages (id,conversation_id,role,parts_json,sequence,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id(501),
        id(500),
        "user",
        JSON.stringify([{ type: "text", text: "Fixture persisted context" }]),
        0,
        fixedNow,
      );
    const transcriptBefore = database
      .prepare("SELECT * FROM messages WHERE conversation_id=?")
      .all(id(500));
    const persona = await store.create({
      name: "Fixture Character",
      prompt: "Original fixture instructions",
      photoAttachmentId: id(401),
    });
    const switched = await store.select(id(500), persona.id);
    assert.deepEqual(switched, {
      kind: "switch-persona",
      conversationId: id(500),
      personaId: persona.id,
      preserveTranscript: true,
      appliesTo: "next-run",
    });
    const first = await store.captureRun(id(500), id(600));
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.profile));
    await store.update(persona.id, {
      name: "Fixture Updated",
      prompt: "New fixture instructions",
      photoAttachmentId: null,
    });
    const duplicate = await store.captureRun(id(500), id(600));
    assert.deepEqual(duplicate, first);
    const next = await store.captureRun(id(500), id(601));
    assert.equal(next.name, "Fixture Updated");
    assert.equal(next.prompt, "New fixture instructions");
    assert.equal(first.prompt, "Original fixture instructions");
    // The engine may allocate runId after the profile was read and the provider started.
    const preSend = await store.snapshotForNextRun(id(500));
    await store.update(persona.id, { prompt: "Edited after provider start" });
    const capturedAfterStart = await store.captureRun(
      id(500),
      id(602),
      preSend,
    );
    assert.equal(capturedAfterStart.prompt, "New fixture instructions");
    await store.select(id(500), DEFAULT_PERSONA_ID);
    assert.equal(
      (await store.snapshotForNextRun(id(500))).personaId,
      DEFAULT_PERSONA_ID,
    );
    await store.select(id(500), persona.id);
    database.close();
    database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    const restored = library(database, 300);
    await restored.initialize();
    assert.equal((await restored.selected(id(500))).id, persona.id);
    assert.deepEqual(await restored.captureRun(id(500), id(600)), first);
    await restored.delete(persona.id);
    assert.equal((await restored.selected(id(500))).id, DEFAULT_PERSONA_ID);
    assert.deepEqual(await restored.captureRun(id(500), id(600)), first);
    assert.deepEqual(
      database
        .prepare("SELECT * FROM messages WHERE conversation_id=?")
        .all(id(500)),
      transcriptBefore,
    );
    assert.equal(
      database
        .prepare("SELECT updated_at FROM conversations WHERE id=?")
        .get(id(500))?.updated_at,
      fixedNow,
    );
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("launch intents keep stable Persona identity and validation rolls back malformed creates", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    await migrateSQLite(migrationAdapter(database));
    const store = library(database);
    await store.initialize();
    const chat = await store.chatIntent(STARTER_PERSONA_ID, id(700));
    const group = await store.groupIntent(STARTER_PERSONA_ID, id(800));
    assert.equal(chat.kind, "individual-chat");
    assert.equal(chat.conversationId, id(700));
    assert.equal(chat.identity.personaId, STARTER_PERSONA_ID);
    assert.equal(group.groupRoomId, id(800));
    assert.deepEqual(group.identity, chat.identity);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM conversations").get()
        ?.count,
      0,
    );
    await assert.rejects(
      store.create({ name: "", prompt: "Rejected fixture" }),
      errorCode("invalid"),
    );
    await assert.rejects(
      store.create({
        name: "Secret profile",
        profile: { nested: { apiKey: "fixture" } },
      }),
      errorCode("invalid"),
    );
    assert.equal((await store.list()).length, 2);
    await assert.rejects(
      store.select(id(700), STARTER_PERSONA_ID),
      errorCode("missing"),
    );
  } finally {
    database.close();
  }
});

test("real shared mobile facade isolates Persona reads and snapshots from an unrelated rollback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locallab-personas-shared-"));
  const path = join(directory, "personas.sqlite");
  const database = new DatabaseSync(path);
  try {
    await migrateSQLite(migrationAdapter(database));
    const db = sharedMobileDatabase(adapter(database));
    let sequence = 100;
    const store = new SQLitePersonaLibrary(db, {
      createId: () => id(sequence++),
      deviceId,
      now: () => new Date(fixedNow),
    });
    await store.initialize();
    const persona = await store.create({
      name: "Shared fixture",
      prompt: "Committed fixture prompt",
    });
    await db.runAsync(
      "INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)",
      id(500),
      "Shared fixture conversation",
      fixedNow,
      fixedNow,
    );
    await store.select(id(500), persona.id);
    let entered!: () => void, release!: () => void;
    const insideTransaction = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rollback = db.withTransactionAsync(async (transaction) => {
      assert.ok(transaction);
      await transaction.runAsync(
        "UPDATE personas SET prompt=? WHERE id=?",
        "Uncommitted fixture prompt",
        persona.id,
      );
      entered();
      await held;
      throw new Error("Fixture rollback");
    });
    const rollbackResult = assert.rejects(rollback, /Fixture rollback/);
    await insideTransaction;
    let readSettled = false;
    const read = store.get(persona.id).then((record) => {
      readSettled = true;
      return record;
    });
    const captured = store.captureRun(id(500), id(600));
    const updated = store.update(persona.id, {
      description: "Independent committed edit",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      readSettled,
      false,
      "An ordinary read must wait outside the unrelated transaction",
    );
    release();
    await rollbackResult;
    assert.equal((await read)?.prompt, "Committed fixture prompt");
    assert.equal((await captured).prompt, "Committed fixture prompt");
    assert.equal((await updated).description, "Independent committed edit");
    await store.delete(persona.id);
    assert.equal((await store.selected(id(500))).id, DEFAULT_PERSONA_ID);
    assert.equal(
      (await store.captureRun(id(500), id(600))).personaId,
      persona.id,
    );
    await store.initialize();
    assert.equal(await store.get(persona.id), null);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
