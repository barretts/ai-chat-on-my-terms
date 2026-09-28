import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  BlobStore,
  SQLiteBlobCatalog,
  type BlobFilePort,
} from "@locallab/storage-blobs";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { SQLiteSemanticSearch } from "@locallab/search-semantic";
import { SQLiteGenerationLifecycle } from "@locallab/generation-lifecycle-ios";
import { AttachmentError, type ExtractionPort } from "@locallab/attachments";
import type { RunEvent } from "@locallab/contracts/run-events";
import { ChatIntegration, ChatIntegrationError } from "../src/index.js";
import {
  SQLiteChatAttachments,
  ChatAttachmentIntakeError,
  prepareChatAttachments,
  readSelectedSearchSnapshot,
  createSQLiteChatFeatureBindings,
} from "../src/features.js";

const timestamp = "2026-09-26T10:00:00.000Z";
const runId = "018f0000-0000-7000-8000-000000000499";
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

function files(root: string): BlobFilePort {
  return {
    readExternal: async (uri) => new Uint8Array(await readFile(uri)),
    readManaged: async (path) =>
      new Uint8Array(await readFile(join(root, path))),
    async writeManaged(path, bytes) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), bytes);
    },
    moveManaged: (from, to) => rename(join(root, from), join(root, to)),
    removeManaged: (path) => rm(join(root, path), { force: true }),
    async listManaged(prefix) {
      try {
        return (await readdir(join(root, dirname(prefix))))
          .map((name) => `${dirname(prefix).replaceAll("\\", "/")}/${name}`)
          .filter((path) => path.startsWith(prefix));
      } catch {
        return [];
      }
    },
  };
}

const textExtraction: ExtractionPort = {
  async text(uri, maxBytes, maxCharacters, signal) {
    signal.throwIfAborted();
    const bytes = await readFile(uri);
    if (bytes.length > maxBytes) throw new Error("fixture size exceeded");
    return bytes.toString("utf8").slice(0, maxCharacters);
  },
  async pdf() {
    throw new Error("No PDF codec in this fixture");
  },
  async xlsx() {
    throw new Error("No spreadsheet codec in this fixture");
  },
};

async function attachmentStore(root: string, database: DatabaseSync) {
  const db = adapter(database);
  const catalog = new SQLiteBlobCatalog(db);
  await catalog.initialize();
  const blobs = new BlobStore(files(root), catalog);
  const attachments = new SQLiteChatAttachments(db, blobs, {
    managedUri: (path) => join(root, path),
  });
  await attachments.initialize();
  return { db, catalog, blobs, attachments };
}

test("managed descriptors, draft/message/conversation owners and original bytes survive canceled extraction and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "locallab-chat-attachments-"));
  const dbPath = join(root, "state.sqlite");
  let database = new DatabaseSync(dbPath);
  try {
    database.exec("PRAGMA foreign_keys=ON");
    const initial = await attachmentStore(root, database);
    const source = join(root, "original.txt");
    await writeFile(source, "original attached document");
    const controller = new AbortController();
    let retainedId = "";
    await assert.rejects(
      initial.attachments.importPicked(
        {
          name: "original.txt",
          mimeType: "text/plain",
          byteLength: 26,
          sourceUri: source,
        },
        "draft:chat-1",
        {
          ...textExtraction,
          async text() {
            controller.abort();
            throw new DOMException("Canceled", "AbortError");
          },
        },
        { signal: controller.signal },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ChatAttachmentIntakeError);
        assert.equal(error.code, "canceled");
        assert.ok(error.attachment);
        retainedId = error.attachment.id;
        return true;
      },
    );
    const descriptor = await initial.attachments.get(retainedId);
    assert.ok(descriptor);
    assert.equal(descriptor.extractedText, null);
    assert.equal(
      (await initial.attachments.listForOwner("draft:chat-1")).length,
      1,
    );
    await initial.attachments.retain("message:user-1", retainedId);
    const features = createSQLiteChatFeatureBindings({
      db: initial.db,
      attachments: initial.attachments,
    });
    const integration = new ChatIntegration(async () => {
      throw Object.assign(new Error("host stopped"), { code: "host-stopped" });
    }, features);
    await assert.rejects(
      integration.send({
        conversationId: "chat-1",
        text: "hello",
        attachmentRefs: [retainedId],
      }),
      (error: unknown) =>
        error instanceof ChatIntegrationError && error.code === "host-stopped",
    );
    await initial.attachments.release("draft:chat-1", retainedId);
    database.close();
    database = new DatabaseSync(dbPath);
    database.exec("PRAGMA foreign_keys=ON");
    const reopened = await attachmentStore(root, database);
    assert.equal(
      (await reopened.attachments.listForOwner("conversation:chat-1"))[0]?.id,
      retainedId,
    );
    assert.equal(
      (await reopened.attachments.listForOwner("message:user-1"))[0]?.id,
      retainedId,
    );
    const restored = await reopened.attachments.read(retainedId);
    assert.equal(
      new TextDecoder().decode(restored.bytes),
      "original attached document",
    );
    assert.equal(
      (await reopened.catalog.references(restored.metadata.id)).find(
        (ref) => ref.ownerId === "message:user-1",
      )?.ownerType,
      "message",
    );
    assert.equal(await readFile(source, "utf8"), "original attached document");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("text attachments prepare bounded context while image data is emitted only for verified media transports", async () => {
  const root = await mkdtemp(join(tmpdir(), "locallab-chat-context-"));
  const database = new DatabaseSync(":memory:");
  try {
    const { attachments } = await attachmentStore(root, database);
    const textPath = join(root, "note.txt");
    await writeFile(textPath, "abcdefghij");
    const document = await attachments.importPicked(
      {
        name: "note.txt",
        mimeType: "text/plain",
        byteLength: 10,
        sourceUri: textPath,
      },
      "draft:chat-1",
      textExtraction,
    );
    const text = await prepareChatAttachments(attachments, {
      refs: [document.id, document.id],
      text: "Summarize",
      capabilities: {},
      transport: "text",
      maxExtractedCharacters: 5,
    });
    assert.deepEqual(text.attachmentRefs, [document.id]);
    assert.deepEqual(text.userParts, [
      { type: "text", text: "Summarize" },
      { type: "file", attachmentId: document.id },
    ]);
    assert.equal(
      text.providerContext[0]?.value,
      "Summarize\n\n[Attachment: note.txt]\nabcde",
    );
    assert.deepEqual(text.truncatedAttachmentIds, [document.id]);
    assert.equal(
      (await attachments.get(document.id))?.extractedText,
      "abcdefghij",
    );
    const imagePath = join(root, "picture.png");
    const imageBytes = new Uint8Array([0, 1, 2, 254, 255]);
    await writeFile(imagePath, imageBytes);
    const image = await attachments.importPicked(
      {
        name: "picture.png",
        mimeType: "image/png",
        byteLength: imageBytes.length,
        sourceUri: imagePath,
      },
      "draft:chat-1",
      textExtraction,
    );
    for (const vision of ["no", "unknown"] as const) {
      await assert.rejects(
        prepareChatAttachments(attachments, {
          refs: [image.id],
          text: "",
          capabilities: { vision },
          transport: "openai-responses",
        }),
        (error: unknown) =>
          error instanceof AttachmentError &&
          error.code === "vision-unsupported",
      );
    }
    const media = await prepareChatAttachments(attachments, {
      refs: [image.id],
      text: "Describe",
      capabilities: { vision: "yes" },
      transport: "openai-responses",
    });
    assert.deepEqual(media.userParts.at(-1), {
      type: "image",
      attachmentId: image.id,
    });
    assert.deepEqual(media.providerContext[0]?.value, {
      content: [
        { type: "input_text", text: "Describe" },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}`,
          detail: "auto",
        },
      ],
    });
    await assert.rejects(
      prepareChatAttachments(attachments, {
        refs: [image.id],
        text: "",
        capabilities: { vision: "yes" },
        transport: "text",
      }),
      (error: unknown) =>
        error instanceof AttachmentError && error.code === "vision-unsupported",
    );
    await assert.rejects(
      prepareChatAttachments(attachments, {
        refs: [image.id],
        text: "",
        capabilities: { vision: "yes" },
        transport: "chat-completions",
        maxImageBytes: 4,
      }),
      (error: unknown) =>
        error instanceof AttachmentError && error.code === "too-large",
    );
    assert.equal((await attachments.listForOwner("draft:chat-1")).length, 2);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal hooks persist lifecycle and index selected saved variants across conversations using fixture local embeddings", async () => {
  const root = await mkdtemp(join(tmpdir(), "locallab-chat-search-"));
  const dbPath = join(root, "chat.sqlite");
  let database = new DatabaseSync(dbPath);
  try {
    database.exec(
      await readFile(
        new URL("../../../schema/core/001_core.sql", import.meta.url),
        "utf8",
      ),
    );
    database.exec(
      `CREATE TABLE response_variants(id TEXT PRIMARY KEY,message_id TEXT,content_json TEXT,created_at TEXT,selected INTEGER);`,
    );
    const initial = await attachmentStore(root, database);
    for (const id of ["chat-1", "chat-2"])
      await initial.db.runAsync(
        "INSERT INTO conversations(id,created_at,updated_at) VALUES(?,?,?)",
        id,
        timestamp,
        timestamp,
      );
    for (const [id, conversationId, role, text] of [
      ["user-1", "chat-1", "user", "Tell me about cats"],
      ["assistant-1", "chat-1", "assistant", "obsolete dog response"],
      ["assistant-2", "chat-2", "assistant", "other conversation dog response"],
    ])
      await initial.db.runAsync(
        "INSERT INTO messages(id,conversation_id,role,parts_json,sequence,created_at) VALUES(?,?,?,?,?,?)",
        id!,
        conversationId!,
        role!,
        JSON.stringify([
          { type: "text", text },
          { type: "reasoning", text: "private hidden trace" },
        ]),
        role === "user" ? 0 : 1,
        timestamp,
      );
    await initial.db.runAsync(
      "INSERT INTO response_variants VALUES(?,?,?,?,?)",
      "variant-1",
      "assistant-1",
      JSON.stringify([{ type: "text", text: "selected cat response" }]),
      timestamp,
      1,
    );
    await initial.db.runAsync(
      "INSERT INTO response_variants VALUES(?,?,?,?,?)",
      "variant-2",
      "assistant-1",
      JSON.stringify([{ type: "text", text: "new selected dog response" }]),
      timestamp,
      0,
    );
    const lifecycle = new SQLiteGenerationLifecycle(initial.db);
    await lifecycle.initialize();
    const search = new SQLiteSemanticSearch(
      initial.db,
      {
        model: {
          id: "fixture-local-embedding",
          revision: "test-only",
          dimensions: 2,
          local: true,
          installed: true,
        },
        embed: async (texts) =>
          texts.map((text) => (text.includes("cat") ? [1, 0] : [0, 1])),
      },
      2,
    );
    await search.initialize();
    const features = createSQLiteChatFeatureBindings({
      ...initial,
      lifecycle,
      search,
    });
    const handle = {
      runId,
      async stop() {},
      events: {
        async *[Symbol.asyncIterator](): AsyncGenerator<RunEvent> {
          yield { type: "RunStarted", runId, sequence: 0, timestamp };
          yield {
            type: "TextDelta",
            runId,
            sequence: 1,
            timestamp,
            text: "durable output",
          };
          yield { type: "RunCompleted", runId, sequence: 2, timestamp };
        },
      },
    };
    await features.beginRun(handle, "chat-1");
    const integration = new ChatIntegration(async () => handle, features);
    const run = await integration.send({
      conversationId: "chat-1",
      text: "hello",
    });
    for await (const _event of run.events) {
    }
    const snapshot = await readSelectedSearchSnapshot(initial.db);
    assert.equal(
      snapshot.find((item) => item.messageId === "assistant-1")?.variantId,
      "variant-1",
    );
    assert.ok(snapshot.some((item) => item.conversationId === "chat-2"));
    assert.equal(
      JSON.stringify(snapshot).includes("private hidden trace"),
      false,
    );
    assert.equal((await search.search("cat"))[0]?.variantId, "user-1");
    const indexed = await initial.db.getAllAsync<{ variant_id: string }>(
      "SELECT variant_id FROM semantic_search_documents",
    );
    assert.ok(indexed.some((item) => item.variant_id === "variant-1"));
    await initial.db.runAsync(
      "UPDATE response_variants SET selected=0 WHERE message_id='assistant-1'",
    );
    await initial.db.runAsync(
      "UPDATE response_variants SET selected=1 WHERE id='variant-2'",
    );
    await features.indexConversation!("chat-1");
    assert.equal(
      (
        await initial.db.getAllAsync<{ variant_id: string }>(
          "SELECT variant_id FROM semantic_search_documents",
        )
      ).some((item) => item.variant_id === "variant-1"),
      false,
    );
    database.close();
    database = new DatabaseSync(dbPath);
    const reopened = new SQLiteGenerationLifecycle(adapter(database));
    assert.equal((await reopened.get(runId))?.state, "completed");
    assert.equal((await reopened.get(runId))?.partialText, "durable output");
    assert.equal(
      (await readSelectedSearchSnapshot(adapter(database))).find(
        (item) => item.messageId === "assistant-1",
      )?.variantId,
      "variant-2",
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
