import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8 } from "fflate";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import type { ToolExecutionContext } from "@locallab/tools-engine";
import {
  createChatId,
  initializeFirstRunChat,
} from "../../composition/first-run-chat";
import { deleteConversation } from "../../composition/chat/conversation-lifecycle";
import { mobileArchiveZip } from "../../composition/chat/archives/zip";
import { sharedMobileDatabase } from "../../platform/database";
import { registerDiagnosticSecret } from "../diagnostics/sanitization";
import {
  SQLiteWorkspaceFiles,
  WorkspaceFileError,
  validateWorkspacePath,
  type WorkspaceStorageLimits,
} from "./store";
import { createWorkspaceTools, WORKSPACE_READ_LIMITS } from "./tools";
import { exportWorkspaceFile, exportWorkspaceZip } from "./export";

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
      } catch (cause) {
        native.exec("ROLLBACK");
        throw cause;
      }
    },
  };
}

async function fixture(
  options: { filename?: string; limits?: Partial<WorkspaceStorageLimits> } = {},
) {
  const native = new DatabaseSync(options.filename ?? ":memory:");
  const raw = adapter(native);
  const db = sharedMobileDatabase(raw);
  const history = await initializeFirstRunChat(db);
  const conversationId = createChatId();
  const now = "2026-09-29T18:00:00.000Z";
  await history.allocateConversation({
    allocationKey: conversationId,
    id: conversationId,
    now,
  });
  const store = new SQLiteWorkspaceFiles(db, conversationId, {
    limits: options.limits,
    now: () => now,
  });
  await store.initialize();
  return { native, raw, db, history, store, conversationId, now };
}

function context(
  conversationId: string,
  signal = new AbortController().signal,
): ToolExecutionContext {
  return {
    conversationId,
    signal,
    invocationId: createChatId(),
    runId: createChatId(),
  };
}

describe("durable chat file workspace", () => {
  it("preserves complete Markdown, XML, Unicode and newlines, with content-free list metadata", async () => {
    const f = await fixture();
    try {
      const content =
        '# Résumé 🌻\n\n<persona attr="a & b">**Hello**</persona>\n```txt\n$HOME & %USERPROFILE%\n```\n';
      const saved = await f.store.write({ path: "notes/plan.md", content });
      expect(saved).toEqual({
        path: "notes/plan.md",
        kind: "markdown",
        content,
        byteLength: strToU8(content).byteLength,
        revision: 1,
        createdAt: f.now,
        updatedAt: f.now,
      });
      expect(await f.store.read(saved.path)).toEqual(saved);
      expect(await f.store.snapshot()).toEqual([saved]);
      const [listed] = await f.store.list();
      expect(listed).toMatchObject({
        path: saved.path,
        revision: 1,
        byteLength: saved.byteLength,
      });
      expect(listed).not.toHaveProperty("content");
      expect(
        await f.store.write({ path: "empty.txt", content: "" }),
      ).toMatchObject({ content: "", byteLength: 0, kind: "text" });
    } finally {
      f.native.close();
    }
  });

  it("requires a current revision to replace a file, preserving text on stale or accidental overwrites", async () => {
    const f = await fixture();
    try {
      await f.store.write({ path: "README.md", content: "first" });
      await expect(
        f.store.write({ path: "readme.md", content: "accidental" }),
      ).rejects.toMatchObject({ code: "conflict" });
      const second = await f.store.write({
        path: "readme.md",
        content: "second",
        expectedRevision: 1,
      });
      expect(second).toMatchObject({
        path: "README.md",
        content: "second",
        revision: 2,
        createdAt: f.now,
      });
      await expect(
        f.store.write({
          path: "README.md",
          content: "stale",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        f.store.write({
          path: "missing.txt",
          content: "new",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await f.store.read("readme.md")).toEqual(second);
      expect(await f.store.list()).toHaveLength(1);
    } finally {
      f.native.close();
    }
  });

  it("serializes simultaneous revision checks so only one writer can replace the same revision", async () => {
    const f = await fixture();
    try {
      await f.store.write({ path: "note.txt", content: "original" });
      const competing = new SQLiteWorkspaceFiles(f.db, f.conversationId);
      await competing.initialize();
      const writes = await Promise.allSettled([
        f.store.write({
          path: "note.txt",
          content: "manual edit",
          expectedRevision: 1,
        }),
        competing.write({
          path: "note.txt",
          content: "model edit",
          expectedRevision: 1,
        }),
      ]);
      expect(
        writes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        writes.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(await f.store.read("note.txt")).toMatchObject({
        content: "manual edit",
        revision: 2,
      });
    } finally {
      f.native.close();
    }
  });

  it("retains files after reopening SQLite and removes only the deleted chat's files through the actual lifecycle", async () => {
    const prefix = resolve(tmpdir(), "locallab-workspace-");
    const directory = await mkdtemp(prefix);
    const filename = join(directory, "chat.sqlite");
    const f = await fixture({ filename });
    const otherId = createChatId();
    let reopened: DatabaseSync | undefined;
    try {
      await f.history.allocateConversation({
        allocationKey: otherId,
        id: otherId,
        now: f.now,
      });
      await f.store.write({
        path: "saved.md",
        content: "kept across app launches",
      });
      const other = new SQLiteWorkspaceFiles(f.db, otherId);
      await other.write({ path: "saved.md", content: "another chat" });
      expect(f.native.prepare("PRAGMA foreign_keys").get()).toMatchObject({
        foreign_keys: 1,
      });
      f.native.close();
      reopened = new DatabaseSync(filename);
      const db = sharedMobileDatabase(adapter(reopened));
      await initializeFirstRunChat(db);
      const store = new SQLiteWorkspaceFiles(db, f.conversationId);
      expect(await store.read("saved.md")).toMatchObject({
        content: "kept across app launches",
        revision: 1,
      });
      expect(
        await deleteConversation(db, f.conversationId, { reassignTo: otherId }),
      ).toBe(true);
      expect(await store.list()).toEqual([]);
      expect(
        await new SQLiteWorkspaceFiles(db, otherId).read("saved.md"),
      ).toMatchObject({ content: "another chat" });
      await expect(
        store.write({ path: "resurrected.txt", content: "no" }),
      ).rejects.toMatchObject({ code: "missing-chat" });
      expect(await deleteConversation(db, f.conversationId)).toBe(false);
    } finally {
      if (reopened) reopened.close();
      else {
        try {
          f.native.close();
        } catch {
          /* Already closed before reopening. */
        }
      }
      // Only remove this test's generated directory under the verified temp prefix.
      if (!resolve(directory).startsWith(prefix))
        throw new Error("Unexpected test directory");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces UTF-8 per-file and total quotas without modifying saved files, including replacements", async () => {
    const f = await fixture({ limits: { fileBytes: 10, chatBytes: 12 } });
    try {
      await expect(
        f.store.write({ path: "unicode.txt", content: "🌻🌻🌻" }),
      ).rejects.toMatchObject({ code: "quota" });
      await f.store.write({ path: "a.txt", content: "12345678" });
      await f.store.write({ path: "b.txt", content: "1234" });
      await expect(
        f.store.write({ path: "b.txt", content: "12345", expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "quota" });
      expect(await f.store.read("b.txt")).toMatchObject({
        content: "1234",
        revision: 1,
      });
      await f.store.write({
        path: "a.txt",
        content: "12",
        expectedRevision: 1,
      });
      await f.store.write({
        path: "b.txt",
        content: "1234567890",
        expectedRevision: 1,
      });
      expect(
        (await f.store.list()).reduce(
          (bytes, entry) => bytes + entry.byteLength,
          0,
        ),
      ).toBe(12);
    } finally {
      f.native.close();
    }
  });

  it("enforces the per-chat count cap while allowing existing files to be updated", async () => {
    const f = await fixture({ limits: { fileCount: 1 } });
    try {
      await f.store.write({ path: "a.txt", content: "a" });
      await expect(
        f.store.write({ path: "b.txt", content: "b" }),
      ).rejects.toMatchObject({ code: "quota" });
      expect(
        await f.store.write({
          path: "a.txt",
          content: "updated",
          expectedRevision: 1,
        }),
      ).toMatchObject({ revision: 2 });
      expect(await f.store.list()).toHaveLength(1);
    } finally {
      f.native.close();
    }
  });

  it("rolls back a write canceled after SQL insertion and preserves the previous revision", async () => {
    const f = await fixture();
    try {
      await f.store.write({ path: "note.txt", content: "before" });
      const controller = new AbortController();
      const canceling = sharedMobileDatabase({
        ...f.raw,
        runAsync: async (sql: string, ...params: SqliteBindValue[]) => {
          const result = await f.raw.runAsync(sql, ...params);
          if (sql.startsWith("INSERT INTO chat_workspace_files"))
            controller.abort();
          return result;
        },
      });
      const store = new SQLiteWorkspaceFiles(canceling, f.conversationId);
      await expect(
        store.write(
          { path: "note.txt", content: "after", expectedRevision: 1 },
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "canceled" });
      expect(await f.store.read("note.txt")).toMatchObject({
        content: "before",
        revision: 1,
      });
      await expect(
        f.store.write({ path: "new.txt", content: "after" }, controller.signal),
      ).rejects.toMatchObject({ code: "canceled" });
      expect(await f.store.list()).toHaveLength(1);
    } finally {
      f.native.close();
    }
  });
});

describe("workspace path and tool boundaries", () => {
  it.each([
    "../secret.md",
    "/root.md",
    "a/../../secret.txt",
    "a//b.txt",
    "C:/secret.txt",
    "a\\secret.txt",
    "\\\\server\\secret.txt",
    ".hidden.md",
    "notes/..txt",
    "notes/CON.txt",
    "notes/com1.md",
    "notes/aux",
    "notes./a.md",
    "a%2fb.md",
    "https://example.com/a.md",
    "notes/a.json",
    "notes/a.md\n",
    "",
    "x".repeat(256) + ".md",
  ])("rejects unsafe or unsupported logical path %j", (path) => {
    expect(() => validateWorkspacePath(path)).toThrow(WorkspaceFileError);
  });

  it("registers complete tool schemas and executes list, read and revision-aware writes within one chat", async () => {
    const f = await fixture();
    try {
      const [list, read, write] = createWorkspaceTools(f.store);
      expect([list!.name, read!.name, write!.name]).toEqual([
        "workspace_list_files",
        "workspace_read_file",
        "workspace_write_file",
      ]);
      expect(write!.parameters).toMatchObject({
        type: "object",
        required: ["path", "content"],
        additionalProperties: false,
      });
      const ctx = context(f.conversationId);
      const content = "# Tool-created\n<xml>Hello 🌻</xml>\n";
      const created = await write!.execute(
        write!.parseInput({ path: "tool/result.md", content }),
        ctx,
      );
      expect(created).toMatchObject({
        ok: true,
        value: { saved: true, path: "tool/result.md", revision: 1 },
      });
      expect(created.ok && created.value).not.toHaveProperty("content");
      expect(await list!.execute(list!.parseInput({}), ctx)).toMatchObject({
        ok: true,
        value: { files: [{ path: "tool/result.md", revision: 1 }] },
      });
      expect(
        await read!.execute(read!.parseInput({ path: "tool/result.md" }), ctx),
      ).toMatchObject({ ok: true, value: { content, revision: 1 } });
      expect(
        await write!.execute(
          { path: "tool/result.md", content: "unsafe overwrite" },
          ctx,
        ),
      ).toMatchObject({
        ok: false,
        error: {
          code: "malformed",
          message: expect.stringContaining("revision 1"),
        },
      });
      expect(
        await write!.execute(
          { path: "tool/result.md", content: "updated", expectedRevision: 1 },
          ctx,
        ),
      ).toMatchObject({ ok: true, value: { revision: 2 } });
    } finally {
      f.native.close();
    }
  });

  it("rejects malformed/incomplete tool arguments before store access and rejects cross-chat/canceled calls", async () => {
    const f = await fixture();
    try {
      const [list, read, write] = createWorkspaceTools(f.store);
      for (const args of [
        null,
        [],
        "{}",
        { path: "a.md" },
        { path: "../a.md", content: "a" },
        { path: "a.md", content: {}, expectedRevision: 1 },
        { path: "a.md", content: "a", expectedRevision: 0 },
        { path: "a.md", content: "a", extra: true },
        Object.create({ path: "a.md", content: "a" }),
      ])
        expect(() => write!.parseInput(args)).toThrow(WorkspaceFileError);
      expect(() => list!.parseInput({ path: "a.md" })).toThrow(
        WorkspaceFileError,
      );
      expect(() => read!.parseInput({})).toThrow(WorkspaceFileError);
      for (const args of [
        { path: "a.md", offset: -1 },
        { path: "a.md", offset: 0.5 },
        { path: "a.md", maxCharacters: 0 },
        {
          path: "a.md",
          maxCharacters: WORKSPACE_READ_LIMITS.maxCharacters + 1,
        },
      ])
        expect(() => read!.parseInput(args)).toThrow(WorkspaceFileError);
      const wrong = context(createChatId());
      expect(
        await write!.execute(
          { path: "wrong.txt", content: "never saved" },
          wrong,
        ),
      ).toMatchObject({ ok: false, error: { code: "permission" } });
      const controller = new AbortController();
      controller.abort();
      expect(
        await write!.execute(
          { path: "canceled.txt", content: "never saved" },
          context(f.conversationId, controller.signal),
        ),
      ).toMatchObject({ ok: false, error: { code: "canceled" } });
      expect(await f.store.list()).toEqual([]);
      expect(
        await read!.execute({ path: "missing.md" }, context(f.conversationId)),
      ).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("does not exist") },
      });
    } finally {
      f.native.close();
    }
  });

  it("pages large tool reads without splitting Unicode characters while keeping full content in the store", async () => {
    const f = await fixture();
    try {
      const content = "🌻abc".repeat(10_000);
      const saved = await f.store.write({ path: "large.txt", content });
      const read = createWorkspaceTools(f.store)[1]!;
      const ctx = context(f.conversationId);
      const first = await read.execute({ path: "large.txt" }, ctx);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error(first.error.message);
      const part = first.value as {
        content: string;
        offset: number;
        totalCharacters: number;
        totalBytes: number;
        hasMore: boolean;
        nextOffset: number;
      };
      expect(Array.from(part.content)).toHaveLength(
        WORKSPACE_READ_LIMITS.defaultCharacters,
      );
      expect(part).toMatchObject({
        offset: 0,
        totalCharacters: 40_000,
        totalBytes: saved.byteLength,
        hasMore: true,
        nextOffset: WORKSPACE_READ_LIMITS.defaultCharacters,
      });
      const second = await read.execute(
        {
          path: "large.txt",
          offset: part.nextOffset,
          maxCharacters: WORKSPACE_READ_LIMITS.maxCharacters,
        },
        ctx,
      );
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error(second.error.message);
      const remainder = second.value as {
        content: string;
        hasMore: boolean;
        nextOffset: null;
      };
      expect(remainder).toMatchObject({ hasMore: false, nextOffset: null });
      expect(part.content + remainder.content).toBe(content);
      expect(await f.store.read("large.txt")).toEqual(saved);
      expect(
        await read.execute({ path: "large.txt", offset: 40_001 }, ctx),
      ).toMatchObject({ ok: false, error: { code: "malformed" } });
    } finally {
      f.native.close();
    }
  });
});

describe("workspace tool diagnostics", () => {
  it("redacts error details before model tool results without altering successful file content", async () => {
    const f = await fixture();
    try {
      const secret = "workspace-tool-test-credential-private";
      registerDiagnosticSecret(secret);
      await f.store.write({
        path: "content.txt",
        content: `User document containing ${secret}`,
      });
      const tools = createWorkspaceTools({
        conversationId: f.conversationId,
        initialize: () => f.store.initialize(),
        list: () => f.store.list(),
        read: (path) => f.store.read(path),
        snapshot: () => f.store.snapshot(),
        write: async () => {
          throw new Error(
            `Saving failed for credential ${secret}; revision 2 is still current.`,
          );
        },
      });
      const ctx = context(f.conversationId);
      expect(
        await tools[2]!.execute(
          { path: "content.txt", content: "new", expectedRevision: 1 },
          ctx,
        ),
      ).toMatchObject({
        ok: false,
        error: {
          message:
            "Saving failed for credential [REDACTED]; revision 2 is still current.",
        },
      });
      expect(
        await tools[1]!.execute({ path: "content.txt" }, ctx),
      ).toMatchObject({
        ok: true,
        value: { content: `User document containing ${secret}` },
      });
    } finally {
      f.native.close();
    }
  });
});

describe("workspace file exports", () => {
  it("exports exact UTF-8 file bytes and a safe basename through the injected native/web share port", async () => {
    const f = await fixture();
    try {
      const exports: { name: string; mimeType: string; bytes: Uint8Array }[] =
        [];
      const files = {
        share: async (file: (typeof exports)[number]) => {
          exports.push(file);
        },
      };
      const content = "# Résumé\n\n🌻 <xml>&quot;</xml>\n";
      await f.store.write({ path: "notes/document.md", content });
      await exportWorkspaceFile(f.store, "notes/document.md", files);
      expect(exports[0]).toMatchObject({
        name: "document.md",
        mimeType: "text/markdown",
      });
      expect(exports[0]!.bytes).toEqual(strToU8(content));
      await f.store.write({ path: "plain.txt", content: "plain\r\ntext\n" });
      await exportWorkspaceFile(f.store, "plain.txt", files);
      expect(exports[1]).toMatchObject({
        name: "plain.txt",
        mimeType: "text/plain",
      });
      expect(strFromU8(exports[1]!.bytes)).toBe("plain\r\ntext\n");
      await expect(
        exportWorkspaceFile(f.store, "missing.txt", files),
      ).rejects.toMatchObject({ code: "missing-file" });
      expect(exports).toHaveLength(2);
    } finally {
      f.native.close();
    }
  });

  it("exports a real ZIP with complete nested files from one snapshot, leaving saved content unchanged", async () => {
    const f = await fixture();
    try {
      const a = "# Markdown\n\n你好 🌻\n";
      const b = 'Text\r\n<xml attr="1" />\n';
      await f.store.write({ path: "notes/a.md", content: a });
      await f.store.write({ path: "outputs/b.txt", content: b });
      let exported:
        | { name: string; mimeType: string; bytes: Uint8Array }
        | undefined;
      await exportWorkspaceZip(
        f.store,
        {
          share: async (file) => {
            exported = file;
          },
        },
        mobileArchiveZip,
      );
      expect(exported).toMatchObject({
        name: "locallab-workspace.zip",
        mimeType: "application/zip",
      });
      expect(exported!.bytes.subarray(0, 4)).toEqual(
        Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
      );
      const decoded = await mobileArchiveZip.decode(exported!.bytes);
      expect(
        decoded.map((entry) => [entry.path, strFromU8(entry.bytes)]),
      ).toEqual([
        ["notes/a.md", a],
        ["outputs/b.txt", b],
      ]);
      expect(await f.store.read("notes/a.md")).toMatchObject({
        content: a,
        revision: 1,
      });
    } finally {
      f.native.close();
    }
  });

  it("does not create an empty ZIP or call share when no saved files exist", async () => {
    const f = await fixture();
    try {
      let shared = false;
      await expect(
        exportWorkspaceZip(
          f.store,
          {
            share: async () => {
              shared = true;
            },
          },
          mobileArchiveZip,
        ),
      ).rejects.toMatchObject({ code: "missing-file" });
      expect(shared).toBe(false);
    } finally {
      f.native.close();
    }
  });
});
