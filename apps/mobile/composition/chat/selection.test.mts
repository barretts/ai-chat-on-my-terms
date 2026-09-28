import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { ChatEngine } from "@locallab/chat-engine-core";
import type { ProviderPort } from "@locallab/contracts/ports";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { readFallbackChatSelection } from "./selection";

const localProviderId = "00000000-0000-7000-8000-000000000026";
const openAIProviderId = "00000000-0000-7000-8000-000000000021";
const savedOpenAIConnectionId = "018f0000-0000-7000-8000-000000000901";
const localBlobId = "018f0000-0000-7000-8000-000000000902";
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

const port: ProviderPort = {
  listModels: async () => ({ ok: true, value: [] }),
  getCapabilities: async () => ({ ok: true, value: {} }),
  async *startRun(request) {
    yield {
      type: "RunStarted",
      runId: request.runId,
      sequence: 0,
      timestamp,
    };
    yield {
      type: "RunCompleted",
      runId: request.runId,
      sequence: 1,
      timestamp,
    };
  },
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "locallab-chat-selection-"));
  const filename = join(directory, "chat.sqlite");
  let native = new DatabaseSync(filename);
  let db = adapter(native);
  native.exec("PRAGMA foreign_keys=ON");
  native.exec(
    await readFile(
      new URL("../../../../packages/schema/core/001_core.sql", import.meta.url),
      "utf8",
    ),
  );
  let nextId = 1;
  const createId = () =>
    `018f0000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`;
  const engine = new ChatEngine({ db, createId, now: () => timestamp });
  return {
    get db() {
      return db;
    },
    async persistRun(
      conversationId: string,
      providerId: string,
      modelId: string,
      connectionId: string,
      createdAt: string,
    ) {
      const modelRecordId = createId();
      await db.runAsync(
        "INSERT OR IGNORE INTO providers(id,kind,name) VALUES(?,?,?)",
        providerId,
        "fixture",
        providerId,
      );
      await db.runAsync(
        "INSERT INTO models(id,provider_id,name) VALUES(?,?,?)",
        modelRecordId,
        providerId,
        modelId,
      );
      await db.runAsync(
        "INSERT OR IGNORE INTO conversations(id,title) VALUES(?,?)",
        conversationId,
        conversationId,
      );
      const run = await engine.send({
        conversationId,
        text: "Fixture saved message",
        binding: {
          providerId,
          modelId,
          modelRecordId,
          providerConnectionId: connectionId,
          port,
        },
      });
      for await (const event of run.events) {
        if (event.type === "RunFailed") assert.fail(event.error.message);
      }
      // Make saved chronology deterministic independently of SQLite's clock.
      await db.runAsync(
        "UPDATE runs SET created_at=? WHERE id=?",
        createdAt,
        run.runId,
      );
    },
    reopen() {
      native.close();
      native = new DatabaseSync(filename);
      native.exec("PRAGMA foreign_keys=ON");
      db = adapter(native);
      return db;
    },
    async dispose() {
      native.close();
      assert.equal(dirname(directory), tmpdir());
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("saved fallback chat selection", () => {
  it("reopens an earlier OpenAI chat with its exact last model and connection after using Offline", async () => {
    const f = await fixture();
    const openAIChatId = "018f0000-0000-7000-8000-000000000911";
    const offlineChatId = "018f0000-0000-7000-8000-000000000912";
    try {
      await f.persistRun(
        openAIChatId,
        openAIProviderId,
        "gpt-previous-model",
        "018f0000-0000-7000-8000-000000000900",
        "2026-09-26T10:00:00.000Z",
      );
      await f.persistRun(
        openAIChatId,
        openAIProviderId,
        "gpt-exact-saved-model-2026-09-26",
        savedOpenAIConnectionId,
        "2026-09-26T11:00:00.000Z",
      );
      await f.persistRun(
        offlineChatId,
        localProviderId,
        `blob:${localBlobId}`,
        localProviderId,
        timestamp,
      );
      const offlineSelection = {
        mode: "local",
        modelId: `blob:${localBlobId}`,
        connectionId: localProviderId,
      };
      assert.deepEqual(
        await readFallbackChatSelection(f.db, offlineChatId),
        offlineSelection,
      );

      const reopened = f.reopen();
      assert.deepEqual(
        await readFallbackChatSelection(reopened, offlineChatId),
        offlineSelection,
      );
      assert.deepEqual(
        await readFallbackChatSelection(reopened, openAIChatId),
        {
          mode: "openai",
          modelId: "gpt-exact-saved-model-2026-09-26",
          connectionId: savedOpenAIConnectionId,
        },
      );
    } finally {
      await f.dispose();
    }
  });

  it("does not guess a fallback for a newest registered or unknown run", async () => {
    const f = await fixture();
    const registeredChatId = "018f0000-0000-7000-8000-000000000921";
    const unknownChatId = "018f0000-0000-7000-8000-000000000922";
    try {
      await f.persistRun(
        registeredChatId,
        openAIProviderId,
        "gpt-old-fallback",
        savedOpenAIConnectionId,
        "2026-09-26T10:00:00.000Z",
      );
      await f.persistRun(
        registeredChatId,
        "018f0000-0000-7000-8000-000000000923",
        "gpt-registered-model",
        "018f0000-0000-7000-8000-000000000924",
        timestamp,
      );
      await f.persistRun(
        unknownChatId,
        "018f0000-0000-7000-8000-000000000925",
        `blob:${localBlobId}`,
        "018f0000-0000-7000-8000-000000000926",
        timestamp,
      );
      const reopened = f.reopen();
      assert.equal(
        await readFallbackChatSelection(reopened, registeredChatId),
        undefined,
      );
      assert.equal(
        await readFallbackChatSelection(reopened, unknownChatId),
        undefined,
      );
      assert.equal(
        await readFallbackChatSelection(
          reopened,
          "018f0000-0000-7000-8000-000000000927",
        ),
        undefined,
      );
    } finally {
      await f.dispose();
    }
  });
});
