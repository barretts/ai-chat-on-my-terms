import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { ChatEngine } from "@locallab/chat-engine-core";
import { SQLiteChatHistory } from "@locallab/chat-history";
import type { RunEvent } from "@locallab/contracts/run-events";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { createChatId, initializeFirstRunChat, readTranscript } from "./index";

const timestamp = "2026-09-26T12:00:00.000Z";
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
async function fixture(path = ":memory:") {
  const native = new DatabaseSync(path);
  const db = adapter(native);
  const history = await initializeFirstRunChat(db);
  const conversationId = createChatId();
  await history.allocateConversation({
    allocationKey: conversationId,
    id: conversationId,
    now: timestamp,
  });
  return { native, db, history, conversationId };
}
async function seedMessage(
  db: SQLiteDatabasePort,
  conversationId: string,
  sequence: number,
  input: {
    id?: string;
    role?: "user" | "assistant";
    parts: readonly unknown[];
    runId?: string;
  },
) {
  const id = input.id ?? createChatId();
  await db.runAsync(
    "INSERT INTO messages(id,conversation_id,role,parts_json,sequence,run_id) VALUES(?,?,?,?,?,?)",
    id,
    conversationId,
    input.role ?? "assistant",
    JSON.stringify(input.parts),
    sequence,
    input.runId ?? null,
  );
  return id;
}
async function seedRun(
  db: SQLiteDatabasePort,
  conversationId: string,
  status: string,
  text: string,
  terminal?: "RunCompleted" | "RunCanceled" | "RunFailed",
) {
  const providerId = createChatId();
  const modelId = createChatId();
  const runId = createChatId();
  await db.runAsync(
    "INSERT INTO providers(id,kind,name) VALUES(?,?,?)",
    providerId,
    "fixture",
    providerId,
  );
  await db.runAsync(
    "INSERT INTO models(id,provider_id,name) VALUES(?,?,?)",
    modelId,
    providerId,
    modelId,
  );
  const events: RunEvent[] = [
    { type: "RunStarted", runId, sequence: 0, timestamp },
    { type: "TextDelta", runId, sequence: 1, timestamp, text },
  ];
  if (terminal === "RunCompleted")
    events.push({ type: terminal, runId, sequence: 2, timestamp });
  if (terminal === "RunCanceled")
    events.push({
      type: terminal,
      runId,
      sequence: 2,
      timestamp,
      reason: "Stopped by user",
    });
  if (terminal === "RunFailed")
    events.push({
      type: terminal,
      runId,
      sequence: 2,
      timestamp,
      error: {
        code: "offline",
        message: "Safe connection failure",
        recoverable: true,
      },
    });
  await db.runAsync(
    "INSERT INTO runs(id,conversation_id,model_id,status,parameters_json) VALUES(?,?,?,?,?)",
    runId,
    conversationId,
    modelId,
    status,
    JSON.stringify({ events }),
  );
  return runId;
}

describe("durable transcript reader", () => {
  it("displays imported assistant rows and the selected variant after SQLite reopen", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "locallab-imported-transcript-"),
    );
    const path = join(directory, "chat.sqlite");
    const f = await fixture(path);
    let reopened: DatabaseSync | undefined;
    try {
      const userId = await seedMessage(f.db, f.conversationId, 0, {
        role: "user",
        parts: [{ type: "text", text: "Imported question" }],
      });
      const assistantId = await seedMessage(f.db, f.conversationId, 1, {
        parts: [{ type: "text", text: "Imported original" }],
      });
      await f.history.addVariant({
        id: createChatId(),
        messageId: assistantId,
        modelId: "archive:unknown",
        content: [{ type: "text", text: "Unselected variant" }],
        createdAt: timestamp,
      });
      const selected = createChatId();
      await f.history.addVariant({
        id: selected,
        messageId: assistantId,
        modelId: "archive:unknown",
        content: [
          { type: "reasoning", text: "Imported reasoning" },
          { type: "text", text: "Selected imported answer" },
          { type: "text", text: 42 },
          { type: "unknown", text: "not a renderer part" },
        ],
        createdAt: timestamp,
      });
      await f.history.selectVariant(assistantId, selected);
      const original = await readTranscript(
        f.db,
        new ChatEngine({ db: f.db }),
        f.conversationId,
      );
      assert.deepEqual(original.users, [
        { id: userId, role: "user", text: "Imported question", order: 0 },
      ]);
      assert.deepEqual(original.assistants, [
        {
          id: assistantId,
          role: "assistant",
          runId: assistantId,
          status: "completed",
          order: 1,
          parts: [
            { type: "reasoning", text: "Imported reasoning" },
            { type: "text", text: "Selected imported answer" },
          ],
        },
      ]);
      f.native.close();
      reopened = new DatabaseSync(path);
      const restoredDb = adapter(reopened);
      assert.deepEqual(
        await readTranscript(
          restoredDb,
          new ChatEngine({ db: restoredDb }),
          f.conversationId,
        ),
        original,
      );
      const history = new SQLiteChatHistory(restoredDb);
      assert.equal(
        (await history.listVariants(assistantId))[1]?.selected,
        true,
      );
    } finally {
      if (reopened) reopened.close();
      else f.native.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps live projected deltas and uses selected content for completed projected responses", async () => {
    const f = await fixture();
    try {
      const running = await seedRun(
        f.db,
        f.conversationId,
        "running",
        "Live projected delta",
      );
      const runningMessage = await seedMessage(f.db, f.conversationId, 0, {
        runId: running,
        parts: [{ type: "text", text: "Older durable copy" }],
      });
      await f.history.addVariant({
        id: createChatId(),
        messageId: runningMessage,
        modelId: "fixture",
        content: [{ type: "text", text: "Older selected content" }],
        createdAt: timestamp,
      });
      const completed = await seedRun(
        f.db,
        f.conversationId,
        "completed",
        "Projected original",
        "RunCompleted",
      );
      const completedMessage = await seedMessage(f.db, f.conversationId, 1, {
        runId: completed,
        parts: [{ type: "text", text: "Projected original" }],
      });
      await f.history.addVariant({
        id: createChatId(),
        messageId: completedMessage,
        modelId: "fixture",
        content: [{ type: "text", text: "Selected completed variant" }],
        createdAt: timestamp,
      });
      const canceled = await seedRun(
        f.db,
        f.conversationId,
        "canceled",
        "Preserved partial response",
        "RunCanceled",
      );
      await seedMessage(f.db, f.conversationId, 2, {
        runId: canceled,
        parts: [],
      });
      const failed = await seedRun(
        f.db,
        f.conversationId,
        "failed",
        "Partial failed response",
        "RunFailed",
      );
      await seedMessage(f.db, f.conversationId, 3, {
        runId: failed,
        parts: [],
      });
      const transcript = await readTranscript(
        f.db,
        new ChatEngine({ db: f.db }),
        f.conversationId,
      );
      assert.deepEqual(
        transcript.assistants.map((message) => message.status),
        ["running", "completed", "canceled", "failed"],
      );
      assert.deepEqual(
        transcript.assistants.map((message) => message.parts),
        [
          [{ type: "text", text: "Live projected delta" }],
          [{ type: "text", text: "Selected completed variant" }],
          [{ type: "text", text: "Preserved partial response" }],
          [{ type: "text", text: "Partial failed response" }],
        ],
      );
      assert.deepEqual(
        transcript.assistants.map((message) => message.order),
        [0, 1, 2, 3],
      );
      assert.deepEqual(transcript.assistants[3]?.error, {
        code: "offline",
        message: "Safe connection failure",
        recoverable: true,
      });
    } finally {
      f.native.close();
    }
  });
});
