import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChatEngine } from "@locallab/chat-engine-core";
import { SQLiteGenerationLifecycle } from "@locallab/generation-lifecycle-ios";
import type { ProviderPort } from "@locallab/contracts/ports";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import type { RunEvent } from "@locallab/contracts/run-events";
import {
  ChatIntegration,
  ChatIntegrationError,
  toRecoverableChatError,
  type IntegratedRunHandle,
} from "../src/index.js";

const runId = "018f0000-0000-7000-8000-000000000401";

function events(): AsyncIterable<RunEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "RunStarted",
        runId,
        sequence: 0,
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      yield {
        type: "TextDelta",
        runId,
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        text: "hello",
      };
      yield {
        type: "RunCompleted",
        runId,
        sequence: 2,
        timestamp: "2026-01-01T00:00:00.000Z",
      };
    },
  };
}

describe("chat integration facade", () => {
  it("retains attachments before send and indexes only after terminal output", async () => {
    const order: string[] = [];
    const integration = new ChatIntegration(
      async (input) => {
        order.push(`send:${input.attachmentRefs?.join(",")}`);
        return {
          runId,
          events: events(),
          async stop() {},
        } satisfies IntegratedRunHandle;
      },
      {
        async retainAttachments(ownerId, refs) {
          order.push(`retain:${ownerId}:${refs.join(",")}`);
        },
        async onEvent(_conversationId, event) {
          order.push(`event:${event.type}`);
        },
        async indexConversation(id) {
          order.push(`index:${id}`);
        },
      },
    );
    const run = await integration.send({
      conversationId: "chat-1",
      text: "hello",
      attachmentRefs: ["file-1", "file-1"],
    });
    const streamed: string[] = [];
    for await (const event of run.events) streamed.push(event.type);
    assert.deepEqual(streamed, ["RunStarted", "TextDelta", "RunCompleted"]);
    assert.deepEqual(order, [
      "retain:conversation:chat-1:file-1",
      "send:file-1",
      "event:RunStarted",
      "event:TextDelta",
      "event:RunCompleted",
      "index:chat-1",
    ]);
  });

  it("retains attachments after engine failure and rejects empty sends", async () => {
    let retained = false;
    const integration = new ChatIntegration(
      async () => {
        throw Object.assign(new Error("worker stopped"), {
          code: "host-stopped",
        });
      },
      {
        retainAttachments: async () => {
          retained = true;
        },
      },
    );
    await assert.rejects(
      integration.send({
        conversationId: "chat-1",
        text: "try again",
        attachmentRefs: ["file-1"],
      }),
      (error: unknown) =>
        error instanceof ChatIntegrationError && error.code === "host-stopped",
    );
    assert.equal(retained, true);
    await assert.rejects(
      integration.send({ conversationId: "chat-1", text: "  " }),
      (error: unknown) =>
        error instanceof ChatIntegrationError && error.code === "empty-message",
    );
  });

  it("maps runtime/context/authorization failures to key-safe recovery messages", () => {
    assert.equal(
      toRecoverableChatError(new Error("missing-model")).code,
      "missing-model",
    );
    assert.equal(
      toRecoverableChatError(
        new Error("A conversation model binding is required"),
      ).code,
      "missing-model",
    );
    assert.equal(
      toRecoverableChatError(new Error("context-window exceeded")).code,
      "context-full",
    );
    assert.equal(
      toRecoverableChatError({
        code: "provider-error",
        message: "context length exceeded",
      }).code,
      "context-full",
    );
    const auth = toRecoverableChatError(new Error("401 secret-value"));
    assert.equal(auth.code, "unauthorized");
    assert.equal(auth.message.includes("secret-value"), false);
    assert.equal(
      toRecoverableChatError({ code: "forbidden", message: "secret-value" })
        .code,
      "unauthorized",
    );
  });

  it("preserves run metadata and binds prototype stop methods to the engine handle", async () => {
    class EngineRun implements IntegratedRunHandle {
      readonly runId = runId;
      readonly userMessageId = "user-1";
      readonly assistantMessageId = "assistant-1";
      readonly contextUsage = { inputTokens: 3 };
      readonly events = events();
      stopReason: string | undefined;

      async stop(reason?: string) {
        this.stopReason = reason;
      }
    }
    const source = new EngineRun();
    const integration = new ChatIntegration(async () => source, {
      async retainAttachments() {},
    });
    const run = await integration.send({
      conversationId: "chat-1",
      text: "hello",
    });
    assert.equal(run.userMessageId, "user-1");
    assert.equal(run.assistantMessageId, "assistant-1");
    assert.deepEqual(run.contextUsage, { inputTokens: 3 });
    await run.stop("Stopped by user");
    assert.equal(source.stopReason, "Stopped by user");
  });

  it("sanitizes streamed provider failures before observers and consumers receive them", async () => {
    const observed: RunEvent[] = [];
    let indexed = false;
    const integration = new ChatIntegration(
      async () => ({
        runId,
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "RunFailed" as const,
              runId,
              sequence: 0,
              timestamp: "2026-01-01T00:00:00.000Z",
              error: {
                code: "provider-error",
                message: "401 secret-value",
                recoverable: false,
              },
            };
          },
        },
        async stop() {},
      }),
      {
        async retainAttachments() {},
        onEvent(_id, event) {
          observed.push(event);
        },
        async indexConversation() {
          indexed = true;
        },
      },
    );
    const run = await integration.send({
      conversationId: "chat-1",
      text: "hello",
    });
    const streamed: RunEvent[] = [];
    for await (const event of run.events) streamed.push(event);
    assert.equal(indexed, true);
    assert.deepEqual(observed, streamed);
    assert.equal(JSON.stringify(streamed).includes("secret-value"), false);
    const failure = streamed[0];
    assert.equal(failure?.type, "RunFailed");
    if (failure?.type !== "RunFailed")
      assert.fail("Expected a terminal failure");
    assert.equal(failure.error.code, "unauthorized");
    assert.equal(failure.error.recoverable, false);
  });

  it("sanitizes exceptions thrown during stream iteration", async () => {
    const integration = new ChatIntegration(
      async () => ({
        runId,
        events: {
          async *[Symbol.asyncIterator](): AsyncGenerator<RunEvent> {
            throw new Error("connection failed for secret-value");
          },
        },
        async stop() {},
      }),
      { async retainAttachments() {} },
    );
    const run = await integration.send({
      conversationId: "chat-1",
      text: "hello",
    });
    await assert.rejects(
      async () => {
        for await (const _event of run.events) {
        }
      },
      (error: unknown) =>
        error instanceof ChatIntegrationError &&
        error.code === "network" &&
        !error.message.includes("secret-value"),
    );
  });

  it("settles SQLite, lifecycle, and indexing after observer failure or consumer closure while preserving completed output", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "locallab-integration-observer-"),
    );
    const path = join(root, "chat.sqlite");
    let database: DatabaseSync | undefined;
    let reopened: DatabaseSync | undefined;
    const conversationId = "018f0000-0000-7000-8000-000000000510";
    const dbPort = (native: DatabaseSync): SQLiteDatabasePort => ({
      execAsync: async (sql) => native.exec(sql),
      runAsync: async (sql, ...params: SqliteBindValue[]) =>
        native.prepare(sql).run(...params),
      getFirstAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
        (native.prepare(sql).get(...params) as T | undefined) ?? null,
      getAllAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
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
    });
    try {
      database = new DatabaseSync(path);
      database.exec(
        await readFile(
          new URL("../../../schema/core/001_core.sql", import.meta.url),
          "utf8",
        ),
      );
      database.exec(
        "INSERT INTO providers(id,kind,name) VALUES('p','fixture','Fixture'); INSERT INTO models(id,provider_id,name) VALUES('m','p','Fixture');",
      );
      database
        .prepare("INSERT INTO conversations(id) VALUES(?)")
        .run(conversationId);
      const db = dbPort(database);
      const lifecycle = new SQLiteGenerationLifecycle(db);
      await lifecycle.initialize();
      let nextId = 600;
      const engine = new ChatEngine({
        db,
        createId: () =>
          `018f0000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`,
      });
      const provider: ProviderPort = {
        listModels: async () => ({ ok: true, value: ["fixture"] }),
        getCapabilities: async () => ({ ok: true, value: {} }),
        async *startRun(request) {
          yield {
            type: "RunStarted",
            runId: request.runId,
            sequence: 0,
            timestamp: "2026-01-01T00:00:00.000Z",
          };
          yield {
            type: "TextDelta",
            runId: request.runId,
            sequence: 1,
            timestamp: "2026-01-01T00:00:00.000Z",
            text: "saved output",
          };
          yield {
            type: "RunCompleted",
            runId: request.runId,
            sequence: 2,
            timestamp: "2026-01-01T00:00:00.000Z",
          };
        },
      };
      const binding = {
        providerId: "fixture",
        providerConnectionId: "018f0000-0000-7000-8000-000000000599",
        modelRecordId: "m",
        modelId: "fixture",
        port: provider,
      };
      const settled: { runId: string; status: string }[] = [];
      for (const failure of [
        "delta",
        "terminal",
        "index",
        "consumer-close",
      ] as const) {
        let indexed = 0;
        const integration = new ChatIntegration(
          (input) => engine.send({ ...input, binding }),
          {
            async retainAttachments() {},
            async onEvent(_id, event) {
              if (!(await lifecycle.get(event.runId)))
                await lifecycle.start({
                  runId: event.runId,
                  conversationId,
                  execution: "local",
                });
              await lifecycle.record(event);
              if (
                (failure === "delta" && event.type === "TextDelta") ||
                (failure === "terminal" && event.type === "RunCompleted")
              )
                throw new Error("observer secret-value");
            },
            async indexConversation() {
              indexed += 1;
              if (failure === "index") throw new Error("index secret-value");
            },
          },
        );
        const run = await integration.send({ conversationId, text: failure });
        const consume = async () => {
          for await (const event of run.events) {
            if (failure === "consumer-close" && event.type === "TextDelta")
              break;
          }
        };
        if (failure === "consumer-close") await consume();
        else
          await assert.rejects(
            consume,
            (error: unknown) =>
              error instanceof ChatIntegrationError &&
              error.code === "feature-failed" &&
              !error.message.includes("secret-value"),
          );
        const status =
          failure === "delta" || failure === "consumer-close"
            ? "canceled"
            : "completed";
        settled.push({ runId: run.runId, status });
        assert.equal(
          database.prepare("SELECT status FROM runs WHERE id=?").get(run.runId)
            ?.status,
          status,
        );
        assert.equal((await lifecycle.get(run.runId))?.state, status);
        assert.equal(
          (await lifecycle.get(run.runId))?.partialText,
          "saved output",
        );
        assert.equal(indexed, 1);
      }
      database.close();
      database = undefined;
      reopened = new DatabaseSync(path);
      const restored = await new ChatEngine({
        db: dbPort(reopened),
      }).getProjection(conversationId);
      assert.deepEqual(
        restored.messages.map((message) => message.status),
        settled.map((item) => item.status),
      );
      assert.ok(restored.cursors.every((cursor) => cursor.terminal));
      assert.ok(
        restored.messages.every((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text === "saved output",
          ),
        ),
      );
      for (const item of settled) {
        const row = reopened
          .prepare("SELECT parameters_json FROM runs WHERE id=?")
          .get(item.runId) as { parameters_json: string };
        const events = (
          JSON.parse(row.parameters_json) as { events: RunEvent[] }
        ).events;
        assert.equal(
          events.filter((event) =>
            ["RunCompleted", "RunCanceled", "RunFailed"].includes(event.type),
          ).length,
          1,
        );
        assert.equal(row.parameters_json.includes("secret-value"), false);
      }
    } finally {
      database?.close();
      reopened?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
