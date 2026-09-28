import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { AdvancedChatEngine } from "../src/index.js";

const conversationId = "018f0000-0000-7000-8000-000000000100";
const binding = {
  providerConnectionId: "018f0000-0000-7000-8000-000000000101",
  providerId: "p",
  modelRecordId: "m",
  modelId: "model-v2",
};

function adapter(db: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      db.prepare(sql).run(...params),
    getFirstAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      (db.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      db.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        await work();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function createDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(
    await readFile(
      new URL(
        "../../../../../packages/schema/core/001_core.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  db.exec(
    "INSERT INTO providers(id,kind,name) VALUES ('p','cloud','provider'); INSERT INTO models(id,provider_id,name) VALUES ('m','p','model');",
  );
  db.prepare("INSERT INTO conversations(id,title) VALUES (?,NULL)").run(
    conversationId,
  );
  return db;
}

function event(
  request: RunRequest,
  type: RunEvent["type"],
  sequence: number,
  extra: Record<string, unknown> = {},
): RunEvent {
  return {
    type,
    runId: request.runId,
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...extra,
  } as RunEvent;
}

function createProvider(run: ProviderPort["startRun"]): ProviderPort {
  return {
    async listModels() {
      return { ok: true, value: ["model-v2"] };
    },
    async getCapabilities() {
      return { ok: true, value: {} };
    },
    startRun: run,
  };
}

const contextOptions = {
  tokenBudget: 256,
  reservedOutputTokens: 32,
  policy: "roll" as const,
  countTokens: (messages: readonly { parts: readonly { text?: string }[] }[]) =>
    messages.reduce((n, m) => n + (m.parts[0]?.text?.length ?? 0), 0),
};

describe("advanced chat engine", () => {
  it("packs conversation history, resolves the saved conversation binding and defers short greeting titles", async () => {
    const db = await createDb();
    try {
      let seenRequest: RunRequest | undefined;
      const provider = createProvider(async function* (request) {
        seenRequest = request;
        yield event(request, "RunStarted", 0);
        yield event(request, "TextDelta", 1, { text: "hello" });
        yield event(request, "RunCompleted", 2);
      });
      const engine = new AdvancedChatEngine({
        db: adapter(db),
        context: {
          ...contextOptions,
          tokenBudget: 18,
          reservedOutputTokens: 4,
        },
        resolveBinding: async (_id, saved) => {
          assert.equal(saved, "m");
          return { ...binding, port: provider };
        },
      });
      db.exec(
        "CREATE TABLE IF NOT EXISTS chat_history_metadata (conversation_id TEXT PRIMARY KEY, model_id TEXT, last_used_at TEXT)",
      );
      db.prepare(
        "INSERT INTO chat_history_metadata(conversation_id,model_id) VALUES (?, 'm')",
      ).run(conversationId);
      db.prepare(
        "INSERT INTO messages(id,conversation_id,role,parts_json,sequence) VALUES (?,?,?,?,?)",
      ).run(
        "018f0000-0000-7000-8000-000000000110",
        conversationId,
        "user",
        JSON.stringify([
          { type: "text", text: "old material that should be removed" },
        ]),
        0,
      );
      const run = await engine.send({ conversationId, text: "hello there" });
      const received: RunEvent[] = [];
      for await (const value of run.events) received.push(value);
      assert.equal(
        received.filter((value) => value.type === "RunCompleted").length,
        1,
      );
      assert.equal(seenRequest?.context.at(-1)?.kind, "user");
      assert.equal(seenRequest?.context.at(-1)?.value, "hello there");
      assert.equal(seenRequest?.context.length, 1);
      assert.deepEqual(run.contextUsage.omittedMessageIds, [
        "018f0000-0000-7000-8000-000000000110",
      ]);
      assert.equal(run.contextUsage.tokenBudget, 18);
      assert.equal(
        (
          db
            .prepare("SELECT title FROM conversations WHERE id=?")
            .get(conversationId) as { title: string | null }
        ).title,
        null,
      );
    } finally {
      db.close();
    }
  });

  it("generates one title and continues an abrupt response once without repeating partial output", async () => {
    const db = await createDb();
    try {
      let calls = 0;
      let continuationRequest: RunRequest | undefined;
      const port = createProvider(async function* (request) {
        calls++;
        yield event(request, "RunStarted", 0);
        if (calls === 1) {
          yield event(request, "TextDelta", 1, { text: "partial" });
          yield event(request, "RunCompleted", 2, { finishReason: "length" });
        } else {
          continuationRequest = request;
          yield event(request, "TextDelta", 1, { text: " answer" });
          yield event(request, "RunCompleted", 2, { finishReason: "stop" });
        }
      });
      let idSequence = 0x201;
      const engine = new AdvancedChatEngine({
        db: adapter(db),
        context: contextOptions,
        createId: () =>
          `018f0000-0000-7000-8000-${(idSequence++).toString(16).padStart(12, "0")}`,
        generateTitle: async () => "Generated title",
      });
      const run = await engine.send({
        conversationId,
        text: "Explain how context packing works",
        binding: { ...binding, port },
      });
      const received: RunEvent[] = [];
      for await (const value of run.events) received.push(value);
      assert.equal(calls, 2);
      assert.equal(
        received.filter((value) => value.type === "RunCompleted").length,
        1,
      );
      assert.deepEqual(
        received
          .filter((value) => value.type === "TextDelta")
          .map((value) => (value.type === "TextDelta" ? value.text : "")),
        ["partial", " answer"],
      );
      assert.ok(
        continuationRequest?.context.some(
          (value) => value.kind === "assistant" && value.value === "partial",
        ),
      );
      assert.equal(
        (
          db
            .prepare("SELECT title FROM conversations WHERE id=?")
            .get(conversationId) as { title: string }
        ).title,
        "Generated title",
      );
      const rows = db.prepare("SELECT status FROM runs").all() as Array<{
        status: string;
      }>;
      assert.deepEqual(
        rows.map((row) => row.status),
        ["completed"],
      );
    } finally {
      db.close();
    }
  });

  it("does not retry after an external tool call", async () => {
    const db = await createDb();
    try {
      let calls = 0;
      const port = createProvider(async function* (request) {
        calls++;
        yield event(request, "RunStarted", 0);
        yield event(request, "ToolCall", 1, {
          invocationId: "018f0000-0000-7000-8000-000000000202",
          name: "send_email",
          input: {},
        });
      });
      const engine = new AdvancedChatEngine({
        db: adapter(db),
        context: contextOptions,
      });
      const run = await engine.send({
        conversationId,
        text: "Please send this email now",
        binding: { ...binding, port },
      });
      const received: RunEvent[] = [];
      for await (const value of run.events) received.push(value);
      assert.equal(calls, 1);
      assert.equal(
        received.filter(
          (value) =>
            value.type === "RunCompleted" ||
            value.type === "RunFailed" ||
            value.type === "RunCanceled",
        ).length,
        1,
      );
      assert.equal(received.at(-1)?.type, "RunFailed");
    } finally {
      db.close();
    }
  });
});
