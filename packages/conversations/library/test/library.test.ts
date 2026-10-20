import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  initializeConversationLibrary,
  SQLiteConversationLibrary,
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

async function setup(path: string): Promise<DatabaseSync> {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(
    await readFile(
      new URL("../../../schema/core/001_core.sql", import.meta.url),
      "utf8",
    ),
  );
  await initializeConversationLibrary(adapter(db));
  db.exec(`CREATE TABLE chat_history_metadata (conversation_id TEXT PRIMARY KEY, model_id TEXT, last_used_at TEXT);
    CREATE TABLE managed_blobs (id TEXT PRIMARY KEY, managed_path TEXT NOT NULL);`);
  db.exec(`CREATE TABLE chat_appearance (conversation_id TEXT PRIMARY KEY, appearance_json TEXT NOT NULL);
    CREATE TABLE group_room_conversations (conversation_id TEXT PRIMARY KEY, group_room_id TEXT NOT NULL);
    CREATE TABLE conversation_personas (conversation_id TEXT PRIMARY KEY, persona_id TEXT);
    CREATE TABLE persona_profiles (persona_id TEXT PRIMARY KEY, photo_attachment_id TEXT);`);
  return db;
}

test("folders, covers, moves, local text search and deletion tombstones survive database reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locallab-library-"));
  const path = join(dir, "chat.sqlite");
  try {
    const db = await setup(path);
    const library = new SQLiteConversationLibrary(adapter(db));
    await db
      .prepare(
        "INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)",
      )
      .run("chat-1", "Trip notes", "2026-01-01", "2026-02-01");
    await db
      .prepare(
        "INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)",
      )
      .run("chat-2", "Dinner", "2026-01-02", "2026-02-02");
    await db
      .prepare("INSERT INTO chat_history_metadata VALUES (?,?,?)")
      .run("chat-1", "local-model", "2026-02-01");
    await db
      .prepare(
        "INSERT INTO messages (id,conversation_id,role,parts_json,sequence) VALUES (?,?,?,?,?)",
      )
      .run(
        "msg-1",
        "chat-1",
        "user",
        JSON.stringify([{ type: "text", text: "A quiet cabin by the lake" }]),
        0,
      );
    await db
      .prepare("INSERT INTO managed_blobs VALUES (?,?)")
      .run("cover-1", "blobs/cover-1");
    await db
      .prepare("INSERT INTO managed_blobs VALUES (?,?)")
      .run("unrelated", "blobs/unrelated");
    const folder = await library.createFolder({
      id: "folder-1",
      name: "  Travel   ideas ",
      color: "#123abc",
      coverBlobId: "cover-1",
      now: "2026-02-03",
    });
    assert.equal(folder.name, "Travel ideas");
    await library.moveConversation("chat-1", folder.id);
    assert.deepEqual(
      await library
        .search("quiet cabin", folder.id)
        .then((result) =>
          result.conversations.map((chat) => [
            chat.id,
            chat.modelId,
            chat.snippet,
          ]),
        ),
      [["chat-1", "local-model", "A quiet cabin by the lake"]],
    );
    db.close();

    const reopened = new DatabaseSync(path);
    try {
      const restored = new SQLiteConversationLibrary(adapter(reopened));
      assert.deepEqual(await restored.listFolders(), [
        {
          id: "folder-1",
          name: "Travel ideas",
          color: "#123ABC",
          coverBlobId: "cover-1",
          createdAt: "2026-02-03",
          updatedAt: "2026-02-03",
        },
      ]);
      assert.equal(
        (await restored.listConversations(folder.id))[0]?.lastUsedAt,
        "2026-02-01",
      );
      await restored.deleteFolder(folder.id, "2026-02-04");
      assert.deepEqual(await restored.listConversations(), [
        {
          id: "chat-2",
          title: "Dinner",
          folderId: null,
          modelId: null,
          lastUsedAt: null,
          archivedAt: null,
          kind: "solo",
          avatarAttachmentId: null,
          personaPhotoAttachmentId: null,
          createdAt: "2026-01-02",
          updatedAt: "2026-02-02",
        },
        {
          id: "chat-1",
          title: "Trip notes",
          folderId: null,
          modelId: "local-model",
          lastUsedAt: "2026-02-01",
          archivedAt: null,
          kind: "solo",
          avatarAttachmentId: null,
          personaPhotoAttachmentId: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-02-01",
        },
      ]);
      assert.equal(await restored.getFolder(folder.id), undefined);
      assert.equal(
        (
          reopened
            .prepare("SELECT deleted_at FROM conversation_folders WHERE id=?")
            .get(folder.id) as { deleted_at: string }
        ).deleted_at,
        "2026-02-04",
      );
      assert.equal(
        (
          reopened.prepare("SELECT count(*) AS n FROM conversations").get() as {
            n: number;
          }
        ).n,
        2,
      );
      assert.equal(
        (
          reopened.prepare("SELECT count(*) AS n FROM managed_blobs").get() as {
            n: number;
          }
        ).n,
        2,
      );
      assert.equal(
        (await restored.search("nothing here")).emptyState,
        "query-no-results",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects invalid folder values and prevents moves into a deleted folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locallab-library-validation-"));
  const db = await setup(join(dir, "chat.sqlite"));
  try {
    const library = new SQLiteConversationLibrary(adapter(db));
    await assert.rejects(
      library.createFolder({ id: "bad", name: "  ", now: "now" }),
      /cannot be empty/,
    );
    await assert.rejects(
      library.createFolder({
        id: "bad-color",
        name: "valid",
        color: "purple",
        now: "now",
      }),
      /six-digit hex/,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("search reflects selected response text and excludes nested tools, reasoning and superseded responses after reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locallab-library-projection-"));
  const path = join(dir, "chat.sqlite");
  let db = await setup(path);
  try {
    db.exec(`CREATE TABLE response_variants (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, selected INTEGER NOT NULL,
      content_json TEXT NOT NULL
    ); INSERT INTO conversations(id,title,created_at,updated_at) VALUES('chat','Search fixture','now','now')`);
    const insert = db.prepare(
      "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES(?,?,?,?,?)",
    );
    insert.run(
      "user",
      "chat",
      "user",
      JSON.stringify([
        { type: "text", text: "Cof" },
        { kind: "text", text: "fee question" },
      ]),
      0,
    );
    insert.run(
      "assistant",
      "chat",
      "assistant",
      JSON.stringify([
        { type: "text", text: "Superseded answer" },
        { type: "reasoning", text: "private reasoning marker" },
        { type: "tool-result", output: { text: "private tool marker" } },
      ]),
      1,
    );
    insert.run(
      "system",
      "chat",
      "system",
      JSON.stringify([{ type: "text", text: "private system marker" }]),
      2,
    );
    db.prepare("INSERT INTO response_variants VALUES(?,?,?,?)").run(
      "old",
      "assistant",
      0,
      JSON.stringify([{ type: "text", text: "Older variant marker" }]),
    );
    db.prepare("INSERT INTO response_variants VALUES(?,?,?,?)").run(
      "selected",
      "assistant",
      1,
      JSON.stringify([
        { type: "text", text: "Selected answer" },
        { type: "reasoning", text: "private selected reasoning marker" },
        {
          type: "tool-call",
          arguments: { text: "private selected tool marker" },
        },
      ]),
    );
    const library = new SQLiteConversationLibrary(adapter(db));
    assert.equal(
      (await library.search("coffee")).conversations[0]?.snippet,
      "Coffee question",
    );
    assert.equal(
      (await library.search("selected answer")).conversations[0]?.snippet,
      "Selected answer",
    );
    for (const query of [
      "superseded",
      "older variant",
      "reasoning marker",
      "tool marker",
      "system marker",
    ])
      assert.deepEqual((await library.search(query)).conversations, []);
    db.close();
    db = new DatabaseSync(path);
    const restored = new SQLiteConversationLibrary(adapter(db));
    assert.equal(
      (await restored.search("selected answer")).conversations[0]?.snippet,
      "Selected answer",
    );
    db.prepare(
      "UPDATE response_variants SET content_json=? WHERE id='selected'",
    ).run(JSON.stringify([{ type: "text", text: "Edited selected answer" }]));
    assert.equal(
      (await restored.search("edited selected")).conversations[0]?.snippet,
      "Edited selected answer",
    );
    db.prepare("DELETE FROM messages WHERE id='assistant'").run();
    assert.deepEqual(
      (await restored.search("edited selected")).conversations,
      [],
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive hides a conversation from Recent, lists it under Archived, and unarchive restores it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locallab-library-archive-"));
  const path = join(dir, "chat.sqlite");
  const db = await setup(path);
  try {
    const library = new SQLiteConversationLibrary(adapter(db));
    const insert = db.prepare(
      "INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)",
    );
    insert.run("chat-a", "Owl survey", "2026-03-01", "2026-03-01");
    insert.run("chat-b", null, "2026-03-02", "2026-03-02");
    const message = db.prepare(
      "INSERT INTO messages (id,conversation_id,role,parts_json,sequence) VALUES (?,?,?,?,?)",
    );
    message.run(
      "a-1",
      "chat-a",
      "user",
      JSON.stringify([{ type: "text", text: "Barred owl calls?" }]),
      0,
    );
    message.run(
      "a-2",
      "chat-a",
      "assistant",
      JSON.stringify([{ type: "text", text: "  Who cooks\n for you  " }]),
      1,
    );
    message.run(
      "a-3",
      "chat-a",
      "assistant",
      JSON.stringify([{ type: "reasoning", text: "hidden" }]),
      2,
    );

    const recent = await library.listHistory();
    assert.deepEqual(
      recent.map((c) => [c.id, c.preview, c.archivedAt]),
      [
        ["chat-b", null, null],
        ["chat-a", "Who cooks for you", null],
      ],
    );

    await library.archiveConversation("chat-a", "2026-03-05T10:00:00.000Z");
    // Archiving twice keeps the original timestamp rather than failing.
    await library.archiveConversation("chat-a", "2026-03-06T10:00:00.000Z");
    assert.deepEqual(
      (await library.listConversations()).map((c) => c.id),
      ["chat-b"],
    );
    assert.deepEqual(
      (await library.listHistory({ query: "owl" })).map((c) => c.id),
      [],
    );
    const archived = await library.listHistory({ archived: true });
    assert.deepEqual(
      archived.map((c) => [c.id, c.archivedAt]),
      [["chat-a", "2026-03-05T10:00:00.000Z"]],
    );
    assert.deepEqual(
      (await library.listHistory({ archived: true, query: "barred" })).map(
        (c) => c.id,
      ),
      ["chat-a"],
    );
    assert.equal(await library.countArchived(), 1);
    // Messages are untouched by archiving.
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM messages WHERE conversation_id='chat-a'",
          )
          .get() as { n: number }
      ).n,
      3,
    );

    await library.unarchiveConversation("chat-a");
    assert.deepEqual(
      (await library.listConversations()).map((c) => c.id).sort(),
      ["chat-a", "chat-b"],
    );
    assert.deepEqual(await library.listHistory({ archived: true }), []);
    assert.equal(await library.countArchived(), 0);

    await assert.rejects(
      library.archiveConversation("missing", "2026-03-07"),
      /Conversation not found/,
    );

    await library.archiveConversation("chat-b", "2026-03-08");
    db.prepare("DELETE FROM conversations WHERE id='chat-b'").run();
    assert.equal(await library.countArchived(), 0);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conversation_archive_state")
          .get() as { n: number }
      ).n,
      0,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("conversation rows carry avatar, group, and persona photo fields from side tables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locallab-library-avatars-"));
  const path = join(dir, "chat.sqlite");
  const db = await setup(path);
  try {
    const library = new SQLiteConversationLibrary(adapter(db));
    for (const id of ["solo-avatar", "group-room", "solo-persona", "plain"]) {
      db.prepare("INSERT INTO conversations (id,title) VALUES (?,?)").run(
        id,
        id,
      );
    }
    db.prepare(
      "INSERT INTO chat_appearance (conversation_id,appearance_json) VALUES (?,?)",
    ).run("solo-avatar", JSON.stringify({ avatarAttachmentId: "blob-1" }));
    db.prepare(
      "INSERT INTO chat_appearance (conversation_id,appearance_json) VALUES (?,?)",
    ).run("group-room", JSON.stringify({ avatarAttachmentId: "blob-2" }));
    db.prepare(
      "INSERT INTO group_room_conversations (conversation_id,group_room_id) VALUES (?,?)",
    ).run("group-room", "room-1");
    db.prepare(
      "INSERT INTO conversation_personas (conversation_id,persona_id) VALUES (?,?)",
    ).run("solo-persona", "persona-9");
    db.prepare(
      "INSERT INTO persona_profiles (persona_id,photo_attachment_id) VALUES (?,?)",
    ).run("persona-9", "photo-7");
    const rows = await library.listConversations();
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get("solo-avatar")?.kind, "solo");
    assert.equal(byId.get("solo-avatar")?.avatarAttachmentId, "blob-1");
    assert.equal(byId.get("solo-avatar")?.personaPhotoAttachmentId, null);
    assert.equal(byId.get("group-room")?.kind, "group");
    assert.equal(byId.get("group-room")?.avatarAttachmentId, "blob-2");
    assert.equal(byId.get("solo-persona")?.personaPhotoAttachmentId, "photo-7");
    assert.equal(byId.get("plain")?.kind, "solo");
    assert.equal(byId.get("plain")?.avatarAttachmentId, null);
    const history = new Map(
      (await library.listHistory()).map((row) => [row.id, row]),
    );
    assert.equal(history.get("solo-avatar")?.kind, "solo");
    assert.equal(history.get("solo-avatar")?.avatarAttachmentId, "blob-1");
    assert.equal(history.get("group-room")?.kind, "group");
    assert.equal(
      history.get("solo-persona")?.personaPhotoAttachmentId,
      "photo-7",
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
