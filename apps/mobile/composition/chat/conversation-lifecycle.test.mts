import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  initializeChatHistory,
  SQLiteChatHistory,
} from "@locallab/chat-history";
import {
  initializeConversationLibrary,
  SQLiteConversationLibrary,
} from "@locallab/conversation-library";
import {
  BlobStore,
  SQLiteBlobCatalog,
  type BlobFilePort,
} from "@locallab/storage-blobs";
import { SQLiteChatAttachments } from "../../../../packages/chat/integration/src/features";
import { migrateSQLite } from "../../../../packages/schema/migrations/full";
import { sharedMobileDatabase } from "../../platform/database";
import { mobileMigrationDatabase } from "../../platform/migrations";
import {
  deleteConversation,
  runConversationCleanups,
  type ConversationCleanupPorts,
} from "./conversation-lifecycle";
import { SQLiteChatProviderRegistry } from "./providers";
import { readActiveChat, saveActiveChat } from "./selection";
import { SQLiteChatSettingsStore } from "./settings-store";
import {
  SQLiteGroupConfigStore,
  defaultGroupRoomSettings,
  emptyGroupParticipant,
} from "@locallab/groups-config";

const uuid = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const A = uuid(1); // deleted
const B = uuid(2); // kept
const R = uuid(3); // replacement "new chat"

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
  const native = new DatabaseSync(":memory:");
  const db = sharedMobileDatabase(adapter(native));
  await migrateSQLite({
    ...mobileMigrationDatabase(db),
    readMigrationSource: (source) => readFile(source, "utf8"),
  });
  await db.execAsync("PRAGMA foreign_keys=ON");
  await initializeChatHistory(db);
  await initializeConversationLibrary(db);
  await SQLiteChatSettingsStore.initialize(db);
  await new SQLiteChatProviderRegistry(db).initialize();
  await readActiveChat(db);
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS first_run_chat_settings (
      mode TEXT PRIMARY KEY NOT NULL CHECK (mode IN ('local', 'openai')),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      model_record_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
      connection_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS generation_lifecycle (
      run_id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL,
      execution TEXT NOT NULL, remote_job_id TEXT, state TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT -1, partial_text TEXT NOT NULL DEFAULT '',
      partial_reasoning TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
      last_notified_characters INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS semantic_search_documents (
      document_key TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
      variant_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, active INTEGER NOT NULL,
      updated_at TEXT NOT NULL, vector_json TEXT NOT NULL, identity TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_search_fts USING fts5(document_key UNINDEXED, text, tokenize='unicode61');
  `);

  const files = new Map<string, Uint8Array>();
  const filePort: BlobFilePort = {
    readExternal: async () => new Uint8Array(),
    readManaged: async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      return bytes;
    },
    writeManaged: async (path, bytes) => void files.set(path, bytes),
    moveManaged: async (source, destination) => {
      const bytes = files.get(source);
      if (bytes) files.set(destination, bytes);
      files.delete(source);
    },
    removeManaged: async (path) => void files.delete(path),
    listManaged: async (prefix) =>
      [...files.keys()].filter((key) => key.startsWith(prefix)),
  };
  const catalog = new SQLiteBlobCatalog(db);
  await catalog.initialize();
  const blobs = new BlobStore(filePort, catalog, "blobs", {
    randomUUID,
    sha256: async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  });
  const attachments = new SQLiteChatAttachments(db, blobs);
  await attachments.initialize();
  const history = new SQLiteChatHistory(db);
  const ports: ConversationCleanupPorts = {
    releaseAttachment: (ownerId, id) => attachments.release(ownerId, id),
    removeBlobReference: (blobId, owner) =>
      blobs.removeReference(blobId, owner),
  };

  async function attachment(n: number, text: string) {
    const id = uuid(1000 + n);
    const blob = await blobs.importBytes(new TextEncoder().encode(text), {
      mimeType: "text/plain",
      owner: { ownerType: "other", ownerId: `attachment:${id}` },
    });
    await attachments.save({
      id,
      blobRef: blob.id,
      name: `note-${n}.txt`,
      mimeType: "text/plain",
      kind: "text",
      byteLength: blob.byteLength,
      sha256: blob.sha256,
      extractedText: text,
      metadata: {},
    });
    return { id, blobId: blob.id, path: blob.managedPath };
  }

  return { native, db, files, blobs, attachments, history, ports, attachment };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const pendingCleanups = (f: Fixture) =>
  (
    f.native
      .prepare("SELECT COUNT(*) AS n FROM conversation_delete_cleanups")
      .get() as { n: number }
  ).n;

async function seed(f: Fixture) {
  const { db, history } = f;
  const now = "2026-09-28T10:00:00.000Z";
  await history.allocateConversation({
    allocationKey: "first-run-chat:local:v1",
    id: A,
    now,
    title: "Offline chat",
  });
  await history.allocateConversation({
    allocationKey: `new-chat:${B}`,
    id: B,
    now,
    title: "Keep me",
  });
  await history.allocateConversation({
    allocationKey: `new-chat:${R}`,
    id: R,
    now,
  });
  await db.runAsync(
    "INSERT INTO providers(id,kind,name) VALUES(?,?,?)",
    uuid(10),
    "fixture",
    "Fixture",
  );
  await db.runAsync(
    "INSERT INTO models(id,provider_id,name) VALUES(?,?,?)",
    uuid(11),
    uuid(10),
    "fixture-model",
  );
  const msg = (
    id: string,
    conversation: string,
    role: string,
    sequence: number,
    text: string,
    run: string | null,
  ) =>
    db.runAsync(
      "INSERT INTO messages(id,conversation_id,role,parts_json,sequence,run_id) VALUES(?,?,?,?,?,?)",
      id,
      conversation,
      role,
      JSON.stringify([{ type: "text", text }]),
      sequence,
      run,
    );
  for (const [run, conversation] of [
    ["run-a", A],
    ["run-b", B],
  ] as const)
    await db.runAsync(
      "INSERT INTO runs(id,conversation_id,model_id,status) VALUES(?,?,?,?)",
      run,
      conversation,
      uuid(11),
      "completed",
    );
  await msg("a-user", A, "user", 0, "Where are the cedar waxwings?", "run-a");
  await msg("a-bot", A, "assistant", 1, "Near the berry bushes.", "run-a");
  await msg("b-user", B, "user", 0, "Keep this", "run-b");
  await db.runAsync(
    "INSERT INTO jobs(id,run_id,kind,status) VALUES('job-a','run-a','generate','completed')",
  );
  await db.runAsync(
    "INSERT INTO jobs(id,run_id,kind,status) VALUES('job-b','run-b','generate','completed')",
  );
  for (const [id, message] of [
    ["variant-a", "a-bot"],
    ["variant-b", "b-user"],
  ])
    await db.runAsync(
      "INSERT INTO response_variants(id,message_id,generation,content_json,model_id,created_at,selected) VALUES(?,?,0,'[]','m',?,1)",
      id,
      message,
      now,
    );
  await db.runAsync(
    "INSERT INTO server_continuations(message_id,provider_id,model_id,handle,context_fingerprint,updated_at) VALUES('a-bot','p','m','h','f',?)",
    now,
  );
  await db.runAsync(
    "INSERT INTO memory_extraction_runs(run_id,scope_key,state,claim_token,updated_at) VALUES('run-a','s','completed','t',?)",
    now,
  );
  await db.runAsync(
    "INSERT INTO generation_lifecycle(run_id,conversation_id,execution,state,updated_at) VALUES('run-a',?,'local','completed',?)",
    A,
    now,
  );
  await db.runAsync(
    "INSERT INTO tool_engine_invocations(id,run_id,conversation_id,entity_json) VALUES('tool-a','run-a',?,'{}')",
    A,
  );
  await db.runAsync(
    "INSERT INTO semantic_search_documents VALUES('doc-a',?,'a-user','v','user','cedar waxwings',1,?,'[]','i')",
    A,
    now,
  );
  await db.runAsync(
    "INSERT INTO semantic_search_documents VALUES('doc-b',?,'b-user','v','user','keep this',1,?,'[]','i')",
    B,
    now,
  );
  await db.runAsync(
    "INSERT INTO semantic_search_fts(document_key,text) VALUES('doc-a','cedar waxwings'),('doc-b','keep this')",
  );
  await db.runAsync(
    "INSERT INTO chat_parameter_presets(scope,conversation_id,values_json) VALUES('chat',?,'{}'),('global','','{}')",
    A,
  );
  await db.runAsync(
    "INSERT INTO chat_appearance(conversation_id,appearance_json) VALUES(?,'{}')",
    A,
  );
  await db.runAsync(
    "INSERT INTO chat_context_policies(conversation_id,policy) VALUES(?,'roll')",
    A,
  );
  await db.runAsync(
    "INSERT INTO chat_provider_connections(id,registration_json,updated_at) VALUES('conn','{}',?)",
    now,
  );
  await db.runAsync(
    "INSERT INTO chat_provider_selections(conversation_id,connection_id) VALUES(?,'conn')",
    A,
  );
  await db.runAsync(
    "INSERT INTO first_run_chat_settings(mode,conversation_id,model_id,model_record_id,connection_id) VALUES('local',?,'gguf:saved-model',?,'c')",
    A,
    uuid(11),
  );
  await db.runAsync(
    "INSERT INTO conversation_personas(conversation_id,persona_id,selected_at) VALUES(?,NULL,?)",
    A,
    now,
  );
  await db.runAsync(
    "INSERT INTO persona_run_snapshots(run_id,conversation_id,snapshot_json,captured_at) VALUES('run-a',?,'{}',?)",
    A,
    now,
  );
  await db.runAsync(
    "INSERT INTO memory_items(id,content,source_conversation_id) VALUES('memory-a','Likes waxwings',?)",
    A,
  );
  await db.runAsync(
    "INSERT INTO arena_sessions(id,conversation_id,status) VALUES('arena-a',?,'completed')",
    A,
  );
  await db.runAsync(
    "INSERT INTO conversation_archive_state(conversation_id,archived_at) VALUES(?,?)",
    A,
    now,
  );
  const library = new SQLiteConversationLibrary(db);
  const folder = await library.createFolder({
    id: uuid(20),
    name: "Birds",
    color: "#123ABC",
    now,
  });
  await library.moveConversation(A, folder.id);
  await saveActiveChat(db, A);

  const sent = await f.attachment(1, "sent with a message");
  await f.attachments.retain("message:a-user", sent.id);
  await f.attachments.retain(`conversation:${A}`, sent.id);
  const shared = await f.attachment(2, "also in chat B");
  await f.attachments.retain("message:a-user", shared.id);
  await f.attachments.retain("message:b-user", shared.id);
  const draft = await f.attachment(3, "draft only");
  await f.attachments.retain(`draft:${A}`, draft.id);
  const persona = await f.attachment(4, "persona photo");
  await f.attachments.retain("persona-run:run-a", persona.id);
  // Archive import references raw blobs with the bare message id.
  const raw = await f.blobs.importBytes(new TextEncoder().encode("raw image"), {
    owner: { ownerType: "message", ownerId: "a-bot" },
  });
  return { sent, shared, draft, persona, raw };
}

async function referencesTo(db: SQLiteDatabasePort, values: readonly string[]) {
  const hits: string[] = [];
  const tables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'semantic_search_fts_%'",
  );
  for (const { name } of tables) {
    const columns = await db.getAllAsync<{ name: string }>(
      `PRAGMA table_info(${name})`,
    );
    for (const column of columns) {
      if (
        !/(^id$|conversation_id|message_id|run_id|owner_id|document_key)/.test(
          column.name,
        )
      )
        continue;
      if (name === "conversation_delete_cleanups") continue;
      const row = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${name} WHERE ${column.name} IN (${values.map(() => "?").join(",")})`,
        ...values,
      );
      if (row?.n) hits.push(`${name}.${column.name}`);
    }
  }
  return hits;
}

describe("conversation delete", () => {
  it("removes the conversation and everything linked, keeps other chats, and leaves valid foreign keys", async () => {
    const f = await fixture();
    try {
      const seeded = await seed(f);
      assert.equal(await deleteConversation(f.db, A, { reassignTo: R }), true);
      const cleanup = await runConversationCleanups(f.db, f.ports);
      assert.equal(cleanup.failed, 0);

      assert.deepEqual(
        await referencesTo(f.db, [
          A,
          "a-user",
          "a-bot",
          "run-a",
          "job-a",
          "variant-a",
          "doc-a",
          "tool-a",
          `draft:${A}`,
          `conversation:${A}`,
          "message:a-user",
          "message:a-bot",
          "persona-run:run-a",
        ]),
        [],
      );
      assert.deepEqual(f.native.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(pendingCleanups(f), 0);

      // Managed files for A are gone; bytes still shared with chat B survive.
      for (const gone of [seeded.sent, seeded.draft, seeded.persona])
        assert.equal(f.files.has(gone.path), false, gone.id);
      assert.equal(f.files.has(seeded.raw.managedPath), false);
      assert.equal(f.files.has(seeded.shared.path), true);
      assert.deepEqual(
        (await f.attachments.listForOwner("message:b-user")).map((a) => a.id),
        [seeded.shared.id],
      );

      // Chat B untouched.
      for (const [sql, n] of [
        ["SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?", 1],
        ["SELECT COUNT(*) AS n FROM runs WHERE conversation_id=?", 1],
        [
          "SELECT COUNT(*) AS n FROM semantic_search_documents WHERE conversation_id=?",
          1,
        ],
      ] as const)
        assert.equal((f.native.prepare(sql).get(B) as { n: number }).n, n, sql);
      assert.equal(
        (
          f.native
            .prepare(
              "SELECT COUNT(*) AS n FROM response_variants WHERE id='variant-b'",
            )
            .get() as { n: number }
        ).n,
        1,
      );
      assert.equal(
        (
          f.native
            .prepare(
              "SELECT COUNT(*) AS n FROM semantic_search_fts WHERE document_key='doc-b'",
            )
            .get() as { n: number }
        ).n,
        1,
      );
      assert.equal(
        (
          f.native
            .prepare(
              "SELECT COUNT(*) AS n FROM chat_parameter_presets WHERE scope='global'",
            )
            .get() as { n: number }
        ).n,
        1,
      );

      // Memories and arena results are kept, unlinked.
      assert.deepEqual(
        {
          ...f.native
            .prepare(
              "SELECT source_conversation_id FROM memory_items WHERE id='memory-a'",
            )
            .get(),
        },
        { source_conversation_id: null },
      );
      assert.deepEqual(
        {
          ...f.native
            .prepare(
              "SELECT conversation_id FROM arena_sessions WHERE id='arena-a'",
            )
            .get(),
        },
        { conversation_id: null },
      );

      // App pointers move to the replacement chat instead of resetting setup.
      assert.equal(await readActiveChat(f.db), R);
      assert.deepEqual(
        {
          ...f.native
            .prepare(
              "SELECT conversation_id,model_id FROM first_run_chat_settings WHERE mode='local'",
            )
            .get(),
        },
        { conversation_id: R, model_id: "gguf:saved-model" },
      );
      const relaunch = await f.history.allocateConversation({
        allocationKey: "first-run-chat:local:v1",
        id: uuid(99),
        now: "2026-09-29T00:00:00.000Z",
      });
      assert.deepEqual(
        [relaunch.conversation.id, relaunch.created],
        [R, false],
      );

      // Idempotent.
      assert.equal(await deleteConversation(f.db, A, { reassignTo: R }), false);
      assert.deepEqual(await runConversationCleanups(f.db, f.ports), {
        released: 0,
        failed: 0,
      });
    } finally {
      f.native.close();
    }
  });

  it("without a replacement, the next launch allocates a fresh chat instead of crashing", async () => {
    const f = await fixture();
    try {
      await seed(f);
      await deleteConversation(f.db, A);
      await runConversationCleanups(f.db, f.ports);
      assert.equal(await readActiveChat(f.db), undefined);
      assert.equal(
        f.native.prepare("SELECT 1 FROM first_run_chat_settings").get(),
        undefined,
      );
      const relaunch = await f.history.allocateConversation({
        allocationKey: "first-run-chat:local:v1",
        id: uuid(98),
        now: "2026-09-29T00:00:00.000Z",
      });
      assert.deepEqual(
        [relaunch.conversation.id, relaunch.created],
        [uuid(98), true],
      );
      assert.deepEqual(f.native.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      f.native.close();
    }
  });

  it("file cleanup resumes after a failure without losing track of owners", async () => {
    const f = await fixture();
    try {
      const seeded = await seed(f);
      await deleteConversation(f.db, A, { reassignTo: R });
      const failing: ConversationCleanupPorts = {
        releaseAttachment: async () => {
          throw new Error("disk busy");
        },
        removeBlobReference: async () => {
          throw new Error("disk busy");
        },
      };
      const first = await runConversationCleanups(f.db, failing);
      assert.ok(first.failed > 0);
      assert.equal(f.files.has(seeded.sent.path), true);
      const resumed = await runConversationCleanups(f.db, f.ports);
      assert.equal(resumed.failed, 0);
      assert.equal(f.files.has(seeded.sent.path), false);
      assert.equal(f.files.has(seeded.raw.managedPath), false);
      assert.equal(f.files.has(seeded.shared.path), true);
      assert.equal(pendingCleanups(f), 0);
    } finally {
      f.native.close();
    }
  });

  it("rolls back entirely when a step fails mid-delete", async () => {
    const f = await fixture();
    try {
      await seed(f);
      f.native.exec(
        "CREATE TRIGGER block_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'blocked'); END",
      );
      await assert.rejects(
        deleteConversation(f.db, A, { reassignTo: R }),
        /blocked/,
      );
      assert.equal(
        (
          f.native
            .prepare(
              "SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?",
            )
            .get(A) as { n: number }
        ).n,
        2,
      );
      assert.equal(pendingCleanups(f), 0);
      assert.equal(await readActiveChat(f.db), A);
    } finally {
      f.native.close();
    }
  });

  it("deleting a group room's chat deletes the room, never an orphan", async () => {
    const f = await fixture();
    try {
      await seed(f);
      await SQLiteGroupConfigStore.initialize(f.db);
      const config = new SQLiteGroupConfigStore(f.db);
      let minted = 30;
      const createId = () => uuid(minted++);
      const conversationId = uuid(20);
      const roomId = await config.saveRoom(
        {
          id: null,
          name: "War room",
          scenario: "Ship-day standup",
          userDisplayName: "Barrett",
          conversationId,
          settings: defaultGroupRoomSettings(),
          participants: [
            { ...emptyGroupParticipant(), displayName: "Ada" },
          ],
        },
        createId,
      );
      const library = new SQLiteConversationLibrary(f.db);
      const listed = await library.listHistory();
      const roomRow = listed.find((entry) => entry.id === conversationId);
      assert.equal(roomRow?.kind, "group");
      assert.equal(roomRow?.title, "War room");
      assert.deepEqual(await config.roomForConversation(conversationId), {
        id: roomId,
        name: "War room",
      });

      assert.equal(await deleteConversation(f.db, conversationId), true);
      assert.equal(
        (f.native.prepare("SELECT COUNT(*) AS n FROM group_rooms").get() as { n: number }).n,
        0,
      );
      assert.equal(
        (
          f.native
            .prepare("SELECT COUNT(*) AS n FROM group_room_conversations")
            .get() as { n: number }
        ).n,
        0,
      );
      assert.equal(await config.roomForConversation(conversationId), null);
      assert.ok(
        !(await library.listHistory()).some((entry) => entry.id === conversationId),
      );
      // The untouched solo chats still read as solo.
      const kept = (await library.listHistory()).find((entry) => entry.id === B);
      assert.equal(kept?.kind, "solo");
    } finally {
      f.native.close();
    }
  });
});
describe("conversation avatar ownership", () => {
  it("replacing a conversation avatar leaves historical persona-run leases intact", async () => {
    const f = await fixture();
    try {
      const photo = await f.attachment(5, "persona photo bytes");
      const replacement = await f.attachment(6, "replacement avatar bytes");
      // Historical run snapshots lease the persona photo (persona-run retain).
      await f.attachments.retain("persona-run:run-a", photo.id);
      // The conversation avatar is chat-owned under the namespaced key (T177).
      const avatarOwner = `chat-avatar:${A}`;
      await f.attachments.retain(avatarOwner, photo.id);
      // Replace: durable swap first (retain new, then release the old chat ref).
      await f.attachments.retain(avatarOwner, replacement.id);
      await f.attachments.release(avatarOwner, photo.id);
      // The replaced photo survives while the historical run lease stands.
      assert.deepEqual(
        (await f.attachments.read(photo.id)).bytes,
        new TextEncoder().encode("persona photo bytes"),
      );
      assert.deepEqual(
        (await f.attachments.read(replacement.id)).bytes,
        new TextEncoder().encode("replacement avatar bytes"),
      );
      // Releasing the last lease collects the photo; the new avatar stays.
      await f.attachments.release("persona-run:run-a", photo.id);
      await assert.rejects(() => f.attachments.read(photo.id));
      assert.equal(f.files.has(photo.path), false);
      assert.ok(f.files.has(replacement.path));
    } finally {
      f.native.close();
    }
  });
});
