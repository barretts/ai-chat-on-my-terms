import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import {
  exportAllChatsZip,
  importAllChatsZip,
  type ArchiveAsset,
  type ArchiveConversation,
} from "@locallab/archives";
import {
  BlobStore,
  SQLiteBlobCatalog,
  type BlobFilePort,
} from "@locallab/storage-blobs";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { sharedMobileDatabase } from "../../../platform/database";
import {
  SQLiteWorkspaceFiles,
  WORKSPACE_LIMITS,
  type WorkspaceFile,
} from "../../../features/workspace-files/store";
import { createMobileArchivePorts } from "./index";
import { mobileArchiveZip } from "./zip";

const timestamp = "2026-09-29T18:00:00.000Z";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function fixture() {
  const native = new DatabaseSync(":memory:");
  const adapter: SQLiteDatabasePort = {
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
      } catch (cause) {
        native.exec("ROLLBACK");
        throw cause;
      }
    },
  };
  const db = sharedMobileDatabase(adapter);
  await db.execAsync("PRAGMA foreign_keys=ON");
  await db.execAsync(
    await readFile(
      new URL(
        "../../../../../packages/schema/core/001_core.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const catalog = new SQLiteBlobCatalog(db);
  await catalog.initialize();
  const bytes = new Map<string, Uint8Array>();
  const files: BlobFilePort = {
    readExternal: async () => {
      throw new Error("No external blob reads");
    },
    readManaged: async (path) => bytes.get(path)!,
    writeManaged: async (path, value) => {
      bytes.set(path, value);
    },
    moveManaged: async (source, destination) => {
      bytes.set(destination, bytes.get(source)!);
      bytes.delete(source);
    },
    removeManaged: async (path) => {
      bytes.delete(path);
    },
    listManaged: async () => [...bytes.keys()],
  };
  const blobs = new BlobStore(files, catalog, "blobs", {
    randomUUID,
    sha256: async (value) => createHash("sha256").update(value).digest("hex"),
  });
  const addChat = async (title: string) => {
    const id = randomUUID();
    await db.runAsync(
      "INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)",
      id,
      title,
      timestamp,
      timestamp,
    );
    await db.runAsync(
      "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES(?,?,?,?,0)",
      randomUUID(),
      id,
      "user",
      JSON.stringify([
        { type: "text", text: "Keep this chat and its files together." },
      ]),
    );
    return id;
  };
  let picked: Uint8Array | undefined;
  const shared: Uint8Array[] = [];
  const imported: string[] = [];
  const ports = createMobileArchivePorts({
    db,
    blobs,
    zip: mobileArchiveZip,
    selectedConversationId: () => undefined,
    files: {
      pick: async () => picked,
      share: async (file) => {
        shared.push(file.bytes);
      },
    },
    now: () => timestamp,
    onImported: (ids) => {
      imported.push(...ids);
    },
  });
  return {
    native,
    db,
    addChat,
    ports,
    shared,
    imported,
    setPicked: (value: Uint8Array) => {
      picked = value;
    },
  };
}

function archivedFile(
  path = "notes/plan.md",
  content = "# Plan\n日本語 🦉\n<xml/>\n",
): WorkspaceFile {
  return {
    path,
    content,
    kind: /\.md$/i.test(path) ? "markdown" : "text",
    byteLength: encoder.encode(content).byteLength,
    revision: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function workspaceAsset(
  conversationId: string,
  files: readonly WorkspaceFile[],
  override: Record<string, unknown> = {},
): ArchiveAsset {
  return {
    path: `workspaces/${encodeURIComponent(conversationId)}.json`,
    mimeType: "application/json",
    bytes: encoder.encode(
      JSON.stringify({ version: 1, conversationId, files, ...override }),
    ),
  };
}

const importedChat = (id: string): ArchiveConversation => ({
  id,
  title: "Archived workspace",
  createdAt: timestamp,
  updatedAt: timestamp,
  messages: [
    {
      id: randomUUID(),
      role: "user",
      parts: [
        {
          type: "text",
          text: "Restore this message and its files atomically.",
        },
      ],
    },
  ],
});

it("backs up logical workspace files with their chats and restores them under new conversation IDs", async () => {
  const source = await fixture();
  try {
    const alpha = await source.addChat("Alpha");
    const beta = await source.addChat("Beta");
    const alphaFiles = new SQLiteWorkspaceFiles(source.db, alpha, {
      now: () => timestamp,
    });
    const betaFiles = new SQLiteWorkspaceFiles(source.db, beta, {
      now: () => timestamp,
    });
    await alphaFiles.write({ path: "notes/plan.md", content: "Old plan" });
    const latest = await alphaFiles.write({
      path: "notes/plan.md",
      content: "# Plan\n日本語 🦉\n<persona>keep exact text</persona>\n",
      expectedRevision: 1,
    });
    const betaFile = await betaFiles.write({
      path: "notes/plan.md",
      content: "A separate chat owns this file.",
    });
    await source.ports.exportAll();
    const archive = source.shared[0]!;
    const decoded = await importAllChatsZip(archive, mobileArchiveZip);
    assert.equal(decoded.assets.length, 2);
    for (const asset of decoded.assets) {
      assert.match(asset.path, /^assets\/workspaces\/[^/]+\.json$/);
      const snapshot = JSON.parse(decoder.decode(asset.bytes));
      assert.equal(snapshot.files[0].path, "notes/plan.md");
      assert.equal(
        snapshot.files[0].content,
        snapshot.conversationId === alpha ? latest.content : betaFile.content,
      );
    }
    source.setPicked(archive);
    assert.equal(await source.ports.importAll(), 2);
    assert.equal(source.imported.length, 2);
    for (const id of source.imported) {
      assert.notEqual(id, alpha);
      assert.notEqual(id, beta);
      const chat = await source.db.getFirstAsync<{ title: string }>(
        "SELECT title FROM conversations WHERE id=?",
        id,
      );
      const restored = await new SQLiteWorkspaceFiles(source.db, id).read(
        "notes/plan.md",
      );
      assert.deepEqual(restored, chat?.title === "Alpha" ? latest : betaFile);
    }
    assert.deepEqual(await alphaFiles.read("notes/plan.md"), latest);
    assert.deepEqual(await betaFiles.read("notes/plan.md"), betaFile);
    assert.equal(
      (
        await source.db.getFirstAsync<{ n: number }>(
          "SELECT COUNT(*) n FROM managed_blobs",
        )
      )?.n,
      0,
    );
  } finally {
    source.native.close();
  }
});

it("rejects unsafe paths, foreign bindings, duplicates and UTF-8 quotas before changing chat data", async () => {
  const source = await fixture();
  try {
    const existingId = await source.addChat("Existing chat");
    const files = new SQLiteWorkspaceFiles(source.db, existingId, {
      now: () => timestamp,
    });
    const existingFile = await files.write({
      path: "keep.md",
      content: "Keep this file.",
    });
    const conversation = importedChat(randomUUID());
    const badAssets = [
      workspaceAsset(conversation.id, [archivedFile("../escape.md")]),
      workspaceAsset(conversation.id, [
        archivedFile("notes/plan.md"),
        archivedFile("Notes/PLAN.MD"),
      ]),
      workspaceAsset(conversation.id, [archivedFile()], {
        conversationId: existingId,
      }),
      workspaceAsset(conversation.id, [{ ...archivedFile(), byteLength: 0 }]),
      workspaceAsset(conversation.id, [
        archivedFile(
          "large.md",
          "🦉".repeat(WORKSPACE_LIMITS.fileBytes / 4 + 1),
        ),
      ]),
      workspaceAsset(
        conversation.id,
        Array.from({ length: WORKSPACE_LIMITS.fileCount + 1 }, (_, index) =>
          archivedFile(`file-${index}.txt`, "x"),
        ),
      ),
      workspaceAsset(
        conversation.id,
        Array.from(
          {
            length: WORKSPACE_LIMITS.chatBytes / WORKSPACE_LIMITS.fileBytes + 1,
          },
          (_, index) =>
            archivedFile(
              `file-${index}.txt`,
              "x".repeat(WORKSPACE_LIMITS.fileBytes),
            ),
        ),
      ),
      workspaceAsset(conversation.id, [{ ...archivedFile(), revision: 0 }]),
    ];
    for (const asset of badAssets) {
      source.setPicked(
        await exportAllChatsZip([conversation], [asset], mobileArchiveZip),
      );
      await assert.rejects(source.ports.importAll(), /Workspace|workspace/);
      assert.equal(
        (
          await source.db.getFirstAsync<{ n: number }>(
            "SELECT COUNT(*) n FROM conversations",
          )
        )?.n,
        1,
      );
      assert.equal(
        (
          await source.db.getFirstAsync<{ n: number }>(
            "SELECT COUNT(*) n FROM chat_workspace_files",
          )
        )?.n,
        1,
      );
      assert.deepEqual(await files.read("keep.md"), existingFile);
      assert.deepEqual(source.imported, []);
    }
  } finally {
    source.native.close();
  }
});

it("rolls back restored files and new chats together if importing a message fails", async () => {
  const source = await fixture();
  try {
    const existingId = await source.addChat("Existing chat");
    const files = new SQLiteWorkspaceFiles(source.db, existingId, {
      now: () => timestamp,
    });
    const existingFile = await files.write({
      path: "keep.md",
      content: "Keep this file.",
    });
    const conversation = importedChat(randomUUID());
    source.setPicked(
      await exportAllChatsZip(
        [conversation],
        [workspaceAsset(conversation.id, [archivedFile()])],
        mobileArchiveZip,
      ),
    );
    await source.db.execAsync(
      "CREATE TEMP TRIGGER reject_imported_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'Injected message failure'); END;",
    );
    await assert.rejects(source.ports.importAll(), /Injected message failure/);
    assert.equal(
      (
        await source.db.getFirstAsync<{ n: number }>(
          "SELECT COUNT(*) n FROM conversations",
        )
      )?.n,
      1,
    );
    assert.equal(
      (
        await source.db.getFirstAsync<{ n: number }>(
          "SELECT COUNT(*) n FROM chat_workspace_files",
        )
      )?.n,
      1,
    );
    assert.deepEqual(await files.read("keep.md"), existingFile);
    assert.deepEqual(source.imported, []);
  } finally {
    source.native.close();
  }
});
