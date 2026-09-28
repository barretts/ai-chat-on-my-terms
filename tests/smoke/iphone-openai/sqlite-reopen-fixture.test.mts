import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import type { FetchLike } from "@locallab/network-http";
import type { SecretStore } from "@locallab/security-secrets";
import { createOpenAIResponsesProvider } from "../../../packages/providers/openai-first-run/src/index.js";
import { SQLiteOpenAIEndpointSetupRepository } from "../../../apps/mobile/features/openai-endpoint-setup/index.js";
import {
  allocateChatConversation,
  createChatId,
  createFirstRunChatEngine,
  createProviderBinding,
  initializeFirstRunChat,
  managedBlobIdFromModelId,
  readTranscript,
} from "../../../apps/mobile/composition/first-run-chat/index.js";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function adapter(database: DatabaseSync): SQLiteDatabasePort {
  return {
    async execAsync(sql) {
      database.exec(sql);
    },
    async runAsync(sql, ...params: SqliteBindValue[]) {
      return database.prepare(sql).run(...params);
    },
    async getFirstAsync<T>(sql: string, ...params: SqliteBindValue[]) {
      return (database.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, ...params: SqliteBindValue[]) {
      return database.prepare(sql).all(...params) as T[];
    },
    async withTransactionAsync(work) {
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

describe("first-run OpenAI chat persistence fixture", () => {
  it("reopens the same conversation and streamed text from SQLite without storing the key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "iphone-chat-fixture-"));
    directories.push(directory);
    const path = join(directory, "locallab.db");
    let nativeDb = new DatabaseSync(path);
    databases.push(nativeDb);
    let db = adapter(nativeDb);
    const history = await initializeFirstRunChat(db);
    const first = await allocateChatConversation(
      history,
      "openai",
      createChatId,
    );
    const retry = await allocateChatConversation(
      history,
      "openai",
      createChatId,
    );
    expect(retry.conversation.id).toBe(first.conversation.id);

    const connectionId = "00000000-0000-7000-8000-000000000158";
    const setupRepo = new SQLiteOpenAIEndpointSetupRepository(db);
    // A real SecureStore credential is represented here by an opaque test ref.
    await setupRepo.save({
      connectionId,
      endpointUrl: "https://api.example.test/v1/responses",
      modelId: "gpt-fixture",
      apiKeyRef: "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as never,
    });
    const providerId = "00000000-0000-7000-8000-000000000021";
    const modelRecordId = createChatId();
    await db.runAsync(
      "INSERT INTO providers(id,kind,name,config_json) VALUES(?,?,?,?)",
      providerId,
      "cloud",
      "OpenAI Responses",
      "{}",
    );
    await db.runAsync(
      "INSERT INTO models(id,provider_id,name,runtime,format) VALUES(?,?,?,?,?)",
      modelRecordId,
      providerId,
      "gpt-fixture",
      "cloud",
      "openai-responses",
    );

    const localConversation = await allocateChatConversation(
      history,
      "local",
      createChatId,
    );
    const localProviderId = "00000000-0000-7000-8000-000000000026";
    const localBlobId = "018f0b1a-7b3c-7abc-8def-123456789abe";
    const localModelId = `blob:${localBlobId}`;
    const localModelRecordId = createChatId();
    await db.runAsync(
      "INSERT INTO providers(id,kind,name,config_json) VALUES(?,?,?,?)",
      localProviderId,
      "local",
      "local-gguf",
      "{}",
    );
    await db.runAsync(
      "INSERT INTO models(id,provider_id,name,runtime,format) VALUES(?,?,?,?,?)",
      localModelRecordId,
      localProviderId,
      localModelId,
      "llama.rn",
      "gguf",
    );
    await db.runAsync(
      "INSERT INTO first_run_chat_settings(mode,conversation_id,model_id,model_record_id,connection_id) VALUES(?,?,?,?,?)",
      "local",
      localConversation.conversation.id,
      localModelId,
      localModelRecordId,
      localProviderId,
    );

    const key = "controlled-fixture-key";
    const secrets: SecretStore = {
      put: async () => {
        throw new Error("unused");
      },
      remove: async () => {},
      resolveHeaders: async () => ({ authorization: key }),
    };
    let serializedInput: unknown;
    const fetcher: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input?: unknown };
      serializedInput = body.input;
      return new Response(
        [
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Fixture reply"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2}}}\n\n',
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const port = createOpenAIResponsesProvider({
      secrets,
      fetch: fetcher,
      resolveConnection: async (id) => {
        const saved = await setupRepo.get(id);
        if (!saved) throw new Error("missing setup");
        return {
          endpointUrl: saved.endpointUrl,
          modelId: saved.modelId,
          apiKeyRef: saved.apiKeyRef,
        };
      },
    });
    const engine = createFirstRunChatEngine(db);
    const run = await engine.send({
      conversationId: first.conversation.id,
      text: "Reply with a fixture response",
      binding: createProviderBinding({
        connectionId,
        providerId,
        modelRecordId,
        modelId: "gpt-fixture",
        port,
      }),
    });
    for await (const _event of run.events) {
      /* drain the persisted stream */
    }
    expect(serializedInput).toEqual([
      { role: "user", content: "Reply with a fixture response" },
    ]);
    const beforeRestart = await readTranscript(
      db,
      engine,
      first.conversation.id,
    );
    expect(beforeRestart.assistants[0]?.parts).toContainEqual({
      type: "text",
      text: "Fixture reply",
    });

    nativeDb.close();
    databases.splice(databases.indexOf(nativeDb), 1);
    const reopen = new DatabaseSync(path);
    databases.push(reopen);
    db = adapter(reopen);
    const reopened = await readTranscript(
      db,
      createFirstRunChatEngine(db),
      first.conversation.id,
    );
    expect(reopened.users).toMatchObject([
      { text: "Reply with a fixture response" },
    ]);
    expect(reopened.assistants[0]).toMatchObject({
      status: "completed",
      parts: [{ type: "text", text: "Fixture reply" }],
    });
    expect(JSON.stringify(reopened)).not.toContain(key);
    expect(
      await new SQLiteOpenAIEndpointSetupRepository(db).get(connectionId),
    ).toMatchObject({
      endpointUrl: "https://api.example.test/v1/responses",
      modelId: "gpt-fixture",
    });
    const restoredLocalSetting = await db.getFirstAsync<{ model_id: string }>(
      "SELECT model_id FROM first_run_chat_settings WHERE mode='local'",
    );
    expect(managedBlobIdFromModelId(restoredLocalSetting?.model_id)).toBe(
      localBlobId,
    );
  });
});
