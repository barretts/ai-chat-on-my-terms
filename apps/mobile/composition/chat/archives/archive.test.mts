import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import {
  exportAllChatsZip,
  importAllChatsZip,
  type ArchiveConversation,
} from "@locallab/archives";
import {
  BlobStore,
  SQLiteBlobCatalog,
  type BlobFilePort,
} from "@locallab/storage-blobs";
import {
  initializeChatHistory,
  SQLiteChatHistory,
} from "@locallab/chat-history";
import { SQLiteChatAttachments } from "../../../../../packages/chat/integration/src/features";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { importLMStudioFile } from "../../../features/archives";
import { createMobileArchivePorts } from "./index";
import { sharedMobileDatabase } from "../../../platform/database";
import { mobileArchiveZip } from "./zip";
import { conversationPdfHtml } from "./native";
import type { ArchiveFilePort } from "./types";

const enc = new TextEncoder();
const dec = new TextDecoder();
const now = "2026-09-26T15:00:00.000Z";

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

async function open(directory: string, initialize = true) {
  const native = new DatabaseSync(join(directory, "chat.sqlite"));
  const db = sharedMobileDatabase(adapter(native));
  await db.execAsync("PRAGMA foreign_keys=ON");
  if (initialize)
    await db.execAsync(
      await readFile(
        new URL(
          "../../../../../packages/schema/core/001_core.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  await initializeChatHistory(db);
  const catalog = new SQLiteBlobCatalog(db);
  await catalog.initialize();
  const files: BlobFilePort = {
    readExternal: (uri) => readFile(uri),
    readManaged: (path) => readFile(join(directory, path)),
    writeManaged: async (path, bytes) => {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), bytes);
    },
    moveManaged: (source, dest) =>
      rename(join(directory, source), join(directory, dest)),
    removeManaged: (path) => rm(join(directory, path), { force: true }),
    listManaged: async () => [],
  };
  const blobs = new BlobStore(files, catalog, "blobs", {
    randomUUID,
    sha256: async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  });
  const attachments = new SQLiteChatAttachments(db, blobs);
  await attachments.initialize();
  return { native, db, blobs, attachments, catalog };
}

function picker(bytes?: Uint8Array) {
  const shared: Array<{ name: string; mimeType: string; bytes: Uint8Array }> =
    [];
  const port: ArchiveFilePort = {
    pick: async () => bytes,
    share: async (file) => {
      shared.push(file);
    },
  };
  return { shared, port };
}

describe("mobile chat archive composition", () => {
  it("imports LM Studio JSON into new IDs, reopens SQLite and shares TXT/PDF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "locallab-archive-lm-"));
    let fixture = await open(directory);
    try {
      const io = picker(
        enc.encode(
          JSON.stringify({
            version: 1,
            conversations: [
              {
                id: "old-conversation",
                title: "Imported 日本語",
                messages: [
                  { id: "old-message", role: "user", content: "Hello" },
                ],
              },
            ],
          }),
        ),
      );
      let selected: string | undefined;
      const imported: string[] = [];
      const ports = createMobileArchivePorts({
        ...fixture,
        files: io.port,
        zip: mobileArchiveZip,
        selectedConversationId: () => selected,
        now: () => now,
        onImported(ids) {
          imported.push(...ids);
          selected = ids[0];
        },
      });
      assert.equal(await importLMStudioFile(ports), 1);
      assert.notEqual(imported[0], "old-conversation");
      fixture.native.close();
      fixture = await open(directory, false);
      const saved = await fixture.db.getFirstAsync<{ title: string }>(
        "SELECT title FROM conversations WHERE id=?",
        selected!,
      );
      assert.equal(saved?.title, "Imported 日本語");
      const messages = await fixture.db.getAllAsync<{
        id: string;
        parts_json: string;
      }>(
        "SELECT id,parts_json FROM messages WHERE conversation_id=?",
        selected!,
      );
      assert.notEqual(messages[0]?.id, "old-message");
      assert.deepEqual(JSON.parse(messages[0]!.parts_json), [
        { type: "text", text: "Hello" },
      ]);
      const reopened = createMobileArchivePorts({
        ...fixture,
        files: io.port,
        zip: mobileArchiveZip,
        selectedConversationId: () => selected,
        now: () => now,
      });
      await reopened.exportSelected("txt");
      await reopened.exportSelected("pdf");
      assert.match(dec.decode(io.shared[0]!.bytes), /Hello/);
      assert.equal(io.shared[0]!.mimeType, "text/plain");
      assert.match(dec.decode(io.shared[1]!.bytes), /^%PDF/);
      const badVersion = createMobileArchivePorts({
        ...fixture,
        files: picker(enc.encode('{"version":99,"conversations":[]}')).port,
        zip: mobileArchiveZip,
        selectedConversationId: () => selected,
      });
      await assert.rejects(
        importLMStudioFile(badVersion),
        /Unsupported LM Studio/,
      );
      assert.equal(
        (
          await fixture.db.getFirstAsync<{ n: number }>(
            "SELECT COUNT(*) n FROM conversations",
          )
        )?.n,
        1,
      );
    } finally {
      fixture.native.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("round trips real ZIP, selected variants and attachment bytes without secrets or ID replacement", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "locallab-archive-roundtrip-"),
    );
    let fixture = await open(directory);
    try {
      const conversationId = randomUUID();
      const userId = randomUUID();
      const assistantId = randomUUID();
      const attachmentId = randomUUID();
      const bytes = new Uint8Array([1, 9, 3, 4]);
      const blob = await fixture.blobs.importBytes(bytes, {
        mimeType: "image/png",
      });
      const preview = await fixture.blobs.importBytes(
        new Uint8Array([3, 2, 1]),
        { mimeType: "image/png" },
      );
      await fixture.attachments.save({
        id: attachmentId,
        blobRef: blob.id,
        previewRef: preview.id,
        name: "image.png",
        mimeType: "image/png",
        kind: "image",
        byteLength: bytes.length,
        sha256: blob.sha256,
        extractedText: null,
        metadata: { apiKey: "descriptor-secret", orientation: 1 },
      });
      await fixture.attachments.retain(
        `conversation:${conversationId}`,
        attachmentId,
      );
      await fixture.blobs.addReference(preview.id, {
        ownerType: "message",
        ownerId: userId,
      });
      await fixture.db.runAsync(
        "INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)",
        conversationId,
        "A chat",
        now,
        now,
      );
      await fixture.db.runAsync(
        "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES(?,?,?,?,0)",
        userId,
        conversationId,
        "user",
        JSON.stringify([
          { type: "text", text: "Look", apiKey: "message-secret" },
          { type: "image", attachmentId },
        ]),
      );
      await fixture.db.runAsync(
        "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES(?,?,?,?,1)",
        assistantId,
        conversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: "First" }]),
      );
      const history = new SQLiteChatHistory(fixture.db);
      await history.addVariant({
        id: randomUUID(),
        messageId: assistantId,
        modelId: "model-a",
        content: [{ type: "text", text: "First" }],
        createdAt: now,
      });
      const selected = randomUUID();
      await history.addVariant({
        id: selected,
        messageId: assistantId,
        modelId: "model-b",
        content: [
          { type: "text", text: "Second" },
          {
            type: "tool-result",
            output: { password: "variant-secret", value: "safe" },
          },
        ],
        createdAt: now,
      });
      await history.selectVariant(assistantId, selected);
      const output = picker();
      const exporter = createMobileArchivePorts({
        ...fixture,
        files: output.port,
        zip: mobileArchiveZip,
        selectedConversationId: () => conversationId,
        now: () => now,
      });
      await exporter.exportAll();
      const zipped = output.shared[0]!.bytes;
      assert.deepEqual([...zipped.subarray(0, 2)], [80, 75]);
      const decoded = await importAllChatsZip(zipped, mobileArchiveZip);
      assert.equal(
        decoded.conversations[0]?.messages[1]?.variants?.[1]?.selected,
        true,
      );
      const serialized =
        JSON.stringify(decoded.conversations) +
        decoded.assets
          .filter((a) => a.path.endsWith(".json"))
          .map((a) => dec.decode(a.bytes))
          .join("");
      assert.doesNotMatch(
        serialized,
        /descriptor-secret|message-secret|variant-secret/,
      );
      assert.equal(decoded.assets.length, 3);
      let importedId: string | undefined;
      const importer = createMobileArchivePorts({
        ...fixture,
        files: picker(zipped).port,
        zip: mobileArchiveZip,
        selectedConversationId: () => conversationId,
        now: () => now,
        onImported(ids) {
          importedId = ids[0];
        },
      });
      assert.equal(await importer.importAll(), 1);
      assert.notEqual(importedId, conversationId);
      fixture.native.close();
      fixture = await open(directory, false);
      assert.equal(
        (
          await fixture.db.getFirstAsync<{ n: number }>(
            "SELECT COUNT(*) n FROM conversations",
          )
        )?.n,
        2,
      );
      const importedMessages = await fixture.db.getAllAsync<{
        id: string;
        parts_json: string;
      }>(
        "SELECT id,parts_json FROM messages WHERE conversation_id=? ORDER BY sequence",
        importedId!,
      );
      const importedAttachment = JSON.parse(importedMessages[0]!.parts_json)[1]
        .attachmentId as string;
      assert.notEqual(importedAttachment, attachmentId);
      const descriptor = await fixture.attachments.get(importedAttachment);
      assert.ok(descriptor);
      assert.notEqual(descriptor.blobRef, blob.id);
      assert.deepEqual(
        [...(await fixture.blobs.read(descriptor.blobRef)).bytes],
        [...bytes],
      );
      assert.deepEqual(
        [...(await fixture.blobs.read(descriptor.previewRef!)).bytes],
        [3, 2, 1],
      );
      assert.deepEqual(descriptor.metadata, { orientation: 1 });
      const variants = await new SQLiteChatHistory(fixture.db).listVariants(
        importedMessages[1]!.id,
      );
      assert.deepEqual(
        variants.map((v) => v.selected),
        [false, true],
      );
      assert.equal(
        (variants[1]!.content[0] as { text: string }).text,
        "Second",
      );
      assert.equal(
        (await fixture.attachments.listForOwner(`conversation:${importedId}`))
          .length,
        1,
      );
      assert.equal(
        (
          await fixture.attachments.listForOwner(
            `message:${importedMessages[0]!.id}`,
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await fixture.db.getFirstAsync<{ n: number }>(
            "SELECT COUNT(*) n FROM blob_references WHERE owner_id LIKE 'archive-import:%'",
          )
        )?.n,
        0,
      );
    } finally {
      fixture.native.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects incomplete asset imports before persistence and discards staged copies", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "locallab-archive-invalid-"),
    );
    const fixture = await open(directory);
    try {
      const sourceId = randomUUID();
      const conversations: ArchiveConversation[] = [
        {
          id: "source",
          title: "Missing asset",
          messages: [
            {
              id: "message",
              role: "user",
              parts: [{ type: "image", blobRef: sourceId }],
            },
          ],
        },
      ];
      const bytes = await exportAllChatsZip(
        conversations,
        [
          {
            path: `blobs/${randomUUID()}`,
            mimeType: "image/png",
            bytes: new Uint8Array([4]),
          },
        ],
        mobileArchiveZip,
      );
      const ports = createMobileArchivePorts({
        ...fixture,
        files: picker(bytes).port,
        zip: mobileArchiveZip,
        selectedConversationId: () => undefined,
      });
      await assert.rejects(
        ports.importAll(),
        /missing a required managed asset/,
      );
      assert.equal(
        (
          await fixture.db.getFirstAsync<{ n: number }>(
            "SELECT COUNT(*) n FROM conversations",
          )
        )?.n,
        0,
      );
      assert.equal((await fixture.blobs.list()).length, 0);
      const invalid = createMobileArchivePorts({
        ...fixture,
        files: picker().port,
        zip: mobileArchiveZip,
        selectedConversationId: () => undefined,
      });
      await assert.rejects(
        invalid.saveImported([
          {
            id: "c",
            title: "bad",
            messages: [{ id: "m", role: "invalid-role", parts: [] }],
          },
        ]),
        /Invalid archived message/,
      );
      await assert.rejects(invalid.exportSelected("txt"), /Select a chat/);
      assert.equal(await invalid.importAll(), 0);
    } finally {
      fixture.native.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe and duplicate real ZIP entries and escapes Unicode PDF HTML", async () => {
    const { zipSync } = await import("fflate");
    const unsafe = zipSync({ "../outside": enc.encode("bad") });
    await assert.rejects(
      mobileArchiveZip.decode(unsafe),
      /Unsafe archive path/,
    );
    const duplicate = zipSync({
      "a/b": enc.encode("one"),
      "a\\b": enc.encode("two"),
    });
    await assert.rejects(
      mobileArchiveZip.decode(duplicate),
      /Duplicate archive entry/,
    );
    const intact = zipSync(
      { "asset.bin": new Uint8Array([1, 2, 3]) },
      { level: 0 },
    );
    await assert.rejects(
      mobileArchiveZip.decode(intact.subarray(0, intact.length - 1)),
      /malformed or incomplete/,
    );
    const corrupt = intact.slice();
    const view = new DataView(corrupt.buffer);
    const payload = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    corrupt[payload] = corrupt[payload]! ^ 1;
    await assert.rejects(mobileArchiveZip.decode(corrupt), /integrity check/);
    const html = conversationPdfHtml({
      id: "c",
      title: "日本語 <script>alert(1)</script>",
      messages: [
        {
          id: "m",
          role: "user",
          parts: [{ type: "text", text: "<img src=x onerror=alert(2)> 😀" }],
        },
      ],
    });
    assert.match(html, /日本語/);
    assert.match(html, /😀/);
    assert.doesNotMatch(html, /<script>|<img /);
    assert.match(html, /&lt;script&gt;/);
  });
});
