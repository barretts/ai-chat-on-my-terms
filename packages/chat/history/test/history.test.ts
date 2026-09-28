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
import { initializeChatHistory, SQLiteChatHistory } from "../src/index.js";

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
  await initializeChatHistory(adapter(db));
  return db;
}

test("allocation, selected regenerated variant, model metadata, and stale continuation survive reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locallab-history-"));
  const path = join(dir, "chat.sqlite");
  try {
    const db = await setup(path);
    const history = new SQLiteChatHistory(adapter(db));
    const first = await history.allocateConversation({
      allocationKey: "new-chat-1",
      id: "conversation-1",
      now: "2026-09-26T12:00:00Z",
    });
    const retry = await history.allocateConversation({
      allocationKey: "new-chat-1",
      id: "ignored-duplicate",
      now: "2026-09-26T12:01:00Z",
    });
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.conversation.id, first.conversation.id);
    await history.recordModelUse(
      "conversation-1",
      "model-a",
      "2026-09-26T12:02:00Z",
    );
    await history.addVariant({
      id: "variant-1",
      messageId: "assistant-1",
      modelId: "model-a",
      content: [{ type: "text", text: "Original" }],
      createdAt: "2026-09-26T12:03:00Z",
    });
    await history.addVariant({
      id: "variant-2",
      messageId: "assistant-1",
      modelId: "model-b",
      content: [{ type: "text", text: "Regenerated" }],
      createdAt: "2026-09-26T12:04:00Z",
    });
    await history.selectVariant("assistant-1", "variant-2");
    await history.saveContinuation({
      messageId: "assistant-1",
      providerId: "provider-a",
      modelId: "model-b",
      handle: "opaque-server-handle",
      contextFingerprint: "ctx-1",
      updatedAt: "2026-09-26T12:04:00Z",
    });
    db.close();

    const reopened = new DatabaseSync(path);
    try {
      const restored = new SQLiteChatHistory(adapter(reopened));
      assert.deepEqual(
        (await restored.getConversation("conversation-1")) && {
          modelId: (await restored.getConversation("conversation-1"))?.modelId,
          lastUsedAt: (await restored.getConversation("conversation-1"))
            ?.lastUsedAt,
        },
        { modelId: "model-a", lastUsedAt: "2026-09-26T12:02:00Z" },
      );
      const variants = await restored.listVariants("assistant-1");
      assert.deepEqual(
        variants.map((v) => [v.generation, v.content, v.selected]),
        [
          [0, [{ type: "text", text: "Original" }], false],
          [1, [{ type: "text", text: "Regenerated" }], true],
        ],
      );
      assert.equal(
        (
          await restored.getContinuation("assistant-1", {
            providerId: "provider-a",
            modelId: "model-b",
            contextFingerprint: "ctx-1",
          })
        )?.handle,
        "opaque-server-handle",
      );
      assert.equal(
        await restored.getContinuation("assistant-1", {
          providerId: "provider-a",
          modelId: "model-b",
          contextFingerprint: "changed-context",
        }),
        undefined,
      );
      assert.equal(
        (
          reopened
            .prepare(
              "SELECT stale FROM server_continuations WHERE message_id='assistant-1'",
            )
            .get() as { stale: number }
        ).stale,
        1,
      );
      const same = await restored.allocateConversation({
        allocationKey: "new-chat-1",
        id: "again",
        now: "later",
      });
      assert.equal(same.conversation.id, "conversation-1");
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
