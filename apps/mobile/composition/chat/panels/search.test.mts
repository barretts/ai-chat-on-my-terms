import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { initializeChatHistory } from "@locallab/chat-history";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  resolveSearchSource,
  searchLocalChat,
  searchSemanticChat,
  visibleSearchText,
} from "./search";
import type { ChatSemanticCandidate } from "./search";

async function fixture() {
  const native = new DatabaseSync(":memory:");
  const db: SQLiteDatabasePort = {
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
  await db.runAsync(
    "INSERT INTO conversations(id,title) VALUES(?,?)",
    "chat-a",
    "CAFÉ plans",
  );
  await db.runAsync(
    "INSERT INTO conversations(id,title) VALUES(?,?)",
    "chat-b",
    "Book notes",
  );
  await db.runAsync(
    "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES(?,?,?,?,?)",
    "user-a",
    "chat-a",
    "user",
    JSON.stringify([{ type: "text", text: "Meet for coffee" }]),
    0,
  );
  await db.runAsync(
    "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES(?,?,?,?,?)",
    "assistant-a",
    "chat-a",
    "assistant",
    JSON.stringify([
      { type: "text", text: "Old answer" },
      { type: "reasoning", text: "private reasoning secret" },
      { type: "tool-result", text: "private tool secret" },
    ]),
    1,
  );
  await db.runAsync(
    "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES(?,?,?,?,?)",
    "user-b",
    "chat-b",
    "user",
    JSON.stringify([{ type: "text", text: "Coffee chapter" }]),
    0,
  );
  return { native, db };
}

describe("mounted chat search source integration", () => {
  it("finds saved titles and message text with Unicode case handling and chat scope", async () => {
    const { native, db } = await fixture();
    try {
      const title = await searchLocalChat(db, "café");
      assert.equal(title.length, 1);
      assert.equal(title[0]?.role, "title");
      assert.equal(title[0]?.conversationId, "chat-a");
      const all = await searchLocalChat(db, "coffee");
      assert.equal(all.length, 2);
      assert.deepEqual(
        new Set(all.map((item) => item.source?.messageId)),
        new Set(["user-a", "user-b"]),
      );
      const scoped = await searchLocalChat(db, "coffee", {
        conversationId: "chat-b",
      });
      assert.equal(scoped.length, 1);
      assert.deepEqual(scoped[0]?.source, {
        conversationId: "chat-b",
        messageId: "user-b",
        variantId: "user-b",
      });
      assert.deepEqual(await searchLocalChat(db, "secret"), []);
      assert.deepEqual(await searchLocalChat(db, "' OR 1=1 --"), []);
    } finally {
      native.close();
    }
  });

  it("uses current selected variants and rejects superseded, foreign and deleted sources", async () => {
    const { native, db } = await fixture();
    try {
      const base = {
        conversationId: "chat-a",
        messageId: "assistant-a",
        variantId: "assistant-a",
      };
      assert.equal((await resolveSearchSource(db, base))?.text, "Old answer");
      await db.runAsync(
        "INSERT INTO response_variants(id,message_id,generation,content_json,model_id,created_at,selected) VALUES(?,?,?,?,?,?,?)",
        "variant-a",
        "assistant-a",
        1,
        JSON.stringify([{ type: "text", text: "Selected answer" }]),
        "model-a",
        "2026-09-01",
        1,
      );
      assert.equal(await resolveSearchSource(db, base), null);
      assert.deepEqual(await searchLocalChat(db, "old answer"), []);
      const [selected] = await searchLocalChat(db, "selected answer");
      assert.equal(selected?.source?.variantId, "variant-a");
      assert.equal(
        await resolveSearchSource(db, {
          ...base,
          conversationId: "chat-b",
          variantId: "variant-a",
        }),
        null,
      );
      assert.equal(
        await resolveSearchSource(
          db,
          { ...base, variantId: "variant-a" },
          "Outdated selected text",
        ),
        null,
      );
      await db.runAsync("DELETE FROM messages WHERE id=?", "assistant-a");
      assert.equal(
        await resolveSearchSource(db, { ...base, variantId: "variant-a" }),
        null,
      );
    } finally {
      native.close();
    }
  });

  it("resolves semantic references and omits stale, duplicate and inactive hits", async () => {
    const { native, db } = await fixture();
    try {
      const current: ChatSemanticCandidate = {
        conversationId: "chat-a",
        messageId: "user-a",
        variantId: "user-a",
        text: "Meet for coffee",
        active: true,
        score: 0.9,
        mode: "semantic",
      };
      const port = {
        async search() {
          return [
            { ...current, text: "old coffee text", messageId: "missing" },
            { ...current, text: "stale text" },
            current,
            current,
            {
              ...current,
              active: false,
              messageId: "user-b",
              conversationId: "chat-b",
              variantId: "user-b",
            },
          ];
        },
      };
      const results = await searchSemanticChat(db, port, "caffeine");
      assert.equal(results.length, 1);
      assert.equal(results[0]?.title, "CAFÉ plans");
      assert.equal(results[0]?.text, "Meet for coffee");
      assert.equal(results[0]?.mode, "semantic");
      assert.equal(results[0]?.score, 0.9);
    } finally {
      native.close();
    }
  });

  it("limits results, cancels cooperatively and leaves connection ownership with the host", async () => {
    const { native, db } = await fixture();
    try {
      assert.equal(
        (await searchLocalChat(db, "coffee", { limit: 1 })).length,
        1,
      );
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        searchLocalChat(db, "coffee", { signal: controller.signal }),
        /canceled/,
      );
      await assert.rejects(searchLocalChat(db, "x".repeat(501)), /500/);
      assert.equal(
        (
          await db.getFirstAsync<{ count: number }>(
            "SELECT COUNT(*) AS count FROM conversations",
          )
        )?.count,
        2,
      );
      assert.equal(
        visibleSearchText(
          '[{"type":"reasoning","text":"hidden"},{"kind":"text","text":"shown"}]',
        ),
        "shown",
      );
    } finally {
      native.close();
    }
  });
});
