import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  localFailureCause,
  retainLocalFailureCause,
} from "@locallab/contracts/local-failure-details";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { ChatEngine } from "../src/index.js";

const ids = [
  "018f0000-0000-7000-8000-000000000001",
  "018f0000-0000-7000-8000-000000000002",
  "018f0000-0000-7000-8000-000000000003",
  "018f0000-0000-7000-8000-000000000004",
  "018f0000-0000-7000-8000-000000000005",
  "018f0000-0000-7000-8000-000000000006",
  "018f0000-0000-7000-8000-000000000007",
  "018f0000-0000-7000-8000-000000000008",
  "018f0000-0000-7000-8000-000000000009",
];
const conversationId = "018f0000-0000-7000-8000-000000000100";

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

async function ready(path: string): Promise<DatabaseSync> {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(
    await readFile(
      new URL("../../../../schema/core/001_core.sql", import.meta.url),
      "utf8",
    ),
  );
  db.prepare(
    "INSERT INTO providers (id, kind, name) VALUES ('p','local','P')",
  ).run();
  db.prepare(
    "INSERT INTO models (id, provider_id, name) VALUES ('m','p','M')",
  ).run();
  db.prepare("INSERT INTO conversations (id, title) VALUES (?, 'Chat')").run(
    conversationId,
  );
  return db;
}

function provider(
  source: "local" | "remote",
  gate?: { promise: Promise<void> },
): ProviderPort {
  return {
    async listModels() {
      return { ok: true, value: [source] };
    },
    async getCapabilities() {
      return { ok: true, value: {} };
    },
    async *startRun(request: RunRequest, signal: AbortSignal) {
      yield {
        type: "RunStarted",
        runId: request.runId,
        sequence: 0,
        timestamp: new Date().toISOString(),
      } satisfies RunEvent;
      if (gate) await gate.promise;
      if (signal.aborted) return;
      yield {
        type: "TextDelta",
        runId: request.runId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        text: `${source} reply`,
      } satisfies RunEvent;
      yield {
        type: "RunCompleted",
        runId: request.runId,
        sequence: 2,
        timestamp: new Date().toISOString(),
      } satisfies RunEvent;
    },
  };
}

function binding(port: ProviderPort, providerId: string) {
  return {
    providerConnectionId: providerId === "local" ? ids[7]! : ids[8]!,
    providerId,
    modelRecordId: "m",
    modelId: `${providerId}-model`,
    port,
  };
}

describe("chat engine durable send pipeline", () => {
  it("streams local and remote provider replies through one engine and survives reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-engine-"));
    const path = join(dir, "db.sqlite");
    let db: DatabaseSync | undefined;
    let reopened: DatabaseSync | undefined;
    try {
      db = await ready(path);
      let index = 0;
      const engine = new ChatEngine({
        db: adapter(db),
        createId: () => ids[index++]!,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      for (const [name, port] of [
        ["local", provider("local")],
        ["remote", provider("remote")],
      ] as const) {
        const run = await engine.send({
          conversationId,
          text: `hello ${name}`,
          binding: binding(port, name),
        });
        const received: string[] = [];
        for await (const event of run.events)
          if (event.type === "TextDelta") received.push(event.text);
        assert.deepEqual(received, [`${name} reply`]);
      }
      db.close();
      db = undefined;
      reopened = new DatabaseSync(path);
      const rows = reopened
        .prepare(
          "SELECT role, parts_json, run_id FROM messages ORDER BY sequence",
        )
        .all() as Array<{
        role: string;
        parts_json: string;
        run_id: string | null;
      }>;
      assert.deepEqual(
        rows.map((row) => row.role),
        ["user", "assistant", "user", "assistant"],
      );
      assert.equal(JSON.parse(rows[1]!.parts_json)[0].text, "local reply");
      assert.equal(JSON.parse(rows[3]!.parts_json)[0].text, "remote reply");
      const saved = JSON.parse(
        (
          reopened
            .prepare(
              "SELECT parameters_json FROM runs ORDER BY created_at LIMIT 1",
            )
            .get() as { parameters_json: string }
        ).parameters_json,
      );
      assert.equal(saved.binding.providerConnectionId, ids[7]);
      assert.equal("apiKey" in saved, false);
      const restored = await new ChatEngine({
        db: adapter(reopened),
        createId: () => ids[8]!,
      }).getProjection(conversationId);
      assert.deepEqual(
        restored.messages.map((message) => message.parts),
        [
          [{ type: "text", text: "local reply" }],
          [{ type: "text", text: "remote reply" }],
        ],
      );
      assert.deepEqual(
        restored.cursors.map((cursor) => cursor.terminal),
        [true, true],
      );
    } finally {
      reopened?.close();
      db?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stop terminates once and regenerate reuses the same user row", async () => {
    const db = await ready(":memory:");
    try {
      let index = 0;
      let release!: () => void;
      const gate = {
        promise: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      const engine = new ChatEngine({
        db: adapter(db),
        createId: () => ids[index++]!,
      });
      const first = await engine.send({
        conversationId,
        text: "same prompt",
        binding: binding(provider("local", gate), "local"),
      });
      const iterator = first.events[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value?.type, "RunStarted");
      await first.stop();
      release();
      const terminal: string[] = [];
      for await (const event of { [Symbol.asyncIterator]: () => iterator })
        if (["RunCompleted", "RunCanceled", "RunFailed"].includes(event.type))
          terminal.push(event.type);
      assert.deepEqual(terminal, ["RunCanceled"]);
      const second = await engine.regenerate({
        conversationId,
        userMessageId: first.userMessageId,
        binding: binding(provider("remote"), "remote"),
      });
      for await (const _event of second.events) {
        /* drain */
      }
      const messages = db
        .prepare("SELECT role, run_id FROM messages ORDER BY sequence")
        .all() as Array<{ role: string; run_id: string }>;
      assert.equal(messages.filter((row) => row.role === "user").length, 1);
      assert.equal(
        messages.filter((row) => row.role === "assistant").length,
        2,
      );
      assert.notEqual(messages[1]!.run_id, messages[2]!.run_id);
      const regeneratedMetadata = JSON.parse(
        String(
          db
            .prepare("SELECT parameters_json FROM runs WHERE id=?")
            .get(second.runId)?.parameters_json,
        ),
      );
      assert.equal(regeneratedMetadata.userMessageId, first.userMessageId);
      assert.equal(
        regeneratedMetadata.assistantMessageId,
        second.assistantMessageId,
      );
      const snapshot = await engine.getProjection(conversationId);
      assert.equal(snapshot.messages.length, 2);
      assert.deepEqual(
        snapshot.messages.map((message) => message.status).sort(),
        ["canceled", "completed"],
      );
    } finally {
      db.close();
    }
  });

  it("keeps RunRequest free of credentials", async () => {
    const db = await ready(":memory:");
    try {
      let index = 0;
      let captured: RunRequest | undefined;
      const port = provider("local");
      const instrumented: ProviderPort = {
        ...port,
        async *startRun(request, signal) {
          captured = request;
          yield* port.startRun(request, signal);
        },
      };
      const engine = new ChatEngine({
        db: adapter(db),
        createId: () => ids[index++]!,
      });
      const run = await engine.send({
        conversationId,
        text: "hi",
        binding: binding(instrumented, "local"),
        parameters: { apiKey: "secret" },
      });
      for await (const _event of run.events) {
        /* drain */
      }
      assert.equal(JSON.stringify(captured).includes("secret"), false);
    } finally {
      db.close();
    }
  });

  it("persists one cancellation when stopped or closed before consumption and when a consumer leaves partial output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-engine-close-"));
    const path = join(dir, "db.sqlite");
    let db: DatabaseSync | undefined;
    let reopened: DatabaseSync | undefined;
    try {
      db = await ready(path);
      let index = 0;
      let providerStarts = 0;
      const fixture = provider("local");
      const port: ProviderPort = {
        ...fixture,
        startRun(request, signal) {
          providerStarts += 1;
          return fixture.startRun(request, signal);
        },
      };
      const engine = new ChatEngine({
        db: adapter(db),
        createId: () => ids[index++]!,
      });
      const first = await engine.send({
        conversationId,
        text: "before consumption",
        binding: binding(port, "local"),
      });
      await first.stop();
      assert.equal(providerStarts, 0);
      assert.equal(
        db.prepare("SELECT status FROM runs WHERE id=?").get(first.runId)
          ?.status,
        "canceled",
      );
      const firstEvents: RunEvent[] = [];
      for await (const event of first.events) firstEvents.push(event);
      assert.deepEqual(
        firstEvents.map((event) => event.type),
        ["RunCanceled"],
      );
      assert.equal(await engine.stop(first.runId), false);

      const second = await engine.send({
        conversationId,
        text: "before iterator starts",
        binding: binding(port, "local"),
      });
      await second.events[Symbol.asyncIterator]().return?.();
      assert.equal(providerStarts, 0);
      assert.equal(
        db.prepare("SELECT status FROM runs WHERE id=?").get(second.runId)
          ?.status,
        "canceled",
      );

      const third = await engine.send({
        conversationId,
        text: "keep partial response",
        binding: binding(port, "local"),
      });
      for await (const event of third.events) {
        if (event.type === "TextDelta") break;
      }
      assert.equal(providerStarts, 1);
      db.close();
      db = undefined;
      reopened = new DatabaseSync(path);
      const restoredEngine = new ChatEngine({ db: adapter(reopened) });
      const snapshot = await restoredEngine.getProjection(conversationId);
      assert.deepEqual(
        snapshot.messages.map((message) => message.status),
        ["canceled", "canceled", "canceled"],
      );
      assert.deepEqual(snapshot.messages[2]?.parts, [
        { type: "text", text: "local reply" },
      ]);
      assert.ok(snapshot.cursors.every((cursor) => cursor.terminal));
      const saved = reopened
        .prepare("SELECT status,parameters_json FROM runs ORDER BY id")
        .all() as { status: string; parameters_json: string }[];
      for (const row of saved) {
        assert.equal(row.status, "canceled");
        const events = (
          JSON.parse(row.parameters_json) as { events: RunEvent[] }
        ).events;
        assert.equal(
          events.filter((event) =>
            ["RunCanceled", "RunCompleted", "RunFailed"].includes(event.type),
          ).length,
          1,
        );
        assert.equal(events.at(-1)?.type, "RunCanceled");
      }
    } finally {
      db?.close();
      reopened?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops durably while a provider next call is pending and rejects late output", async () => {
    const db = await ready(":memory:");
    try {
      let index = 0;
      let release!: () => void;
      const gate = {
        promise: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      const engine = new ChatEngine({
        db: adapter(db),
        createId: () => ids[index++]!,
      });
      const run = await engine.send({
        conversationId,
        text: "pending provider",
        binding: binding(provider("local", gate), "local"),
      });
      const iterator = run.events[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value?.type, "RunStarted");
      const pending = iterator.next();
      await run.stop();
      assert.equal(
        db.prepare("SELECT status FROM runs WHERE id=?").get(run.runId)?.status,
        "canceled",
      );
      release();
      assert.equal((await pending).value?.type, "RunCanceled");
      assert.equal((await iterator.next()).done, true);
      assert.deepEqual(
        (await engine.getProjection(conversationId)).messages[0]?.parts,
        [],
      );
    } finally {
      db.close();
    }
  });

  it("persists a safe failure when the provider throws before creating an iterator", async () => {
    const db = await ready(":memory:");
    try {
      let index = 0;
      const originalFailure = new Error("connection rejected secret-value");
      const port: ProviderPort = {
        ...provider("remote"),
        startRun() {
          throw originalFailure;
        },
      };
      const engine = new ChatEngine({
        db: adapter(db),
        createId: () => ids[index++]!,
      });
      const run = await engine.send({
        conversationId,
        text: "failed provider",
        binding: binding(port, "remote"),
      });
      const output: RunEvent[] = [];
      for await (const event of run.events) output.push(event);
      assert.equal(output[0]?.type, "RunFailed");
      if (output[0]?.type !== "RunFailed")
        throw new Error("Expected a failed run");
      assert.equal(localFailureCause(output[0].error), originalFailure);
      assert.equal(JSON.stringify(output[0]).includes("secret-value"), false);
      const row = db
        .prepare("SELECT status,parameters_json FROM runs WHERE id=?")
        .get(run.runId);
      assert.equal(row?.status, "failed");
      assert.equal(
        String(row?.parameters_json).includes("secret-value"),
        false,
      );
      assert.equal(
        (await engine.getProjection(conversationId)).cursors[0]?.terminal,
        true,
      );
    } finally {
      db.close();
    }
  });

  it("preserves live full failure detail through the schema clone without writing it to SQLite or JSON", async () => {
    const db = await ready(":memory:");
    try {
      let index = 0;
      const body =
        "HTTP503 fixture response\n" +
        "private detail ".repeat(1600) +
        "LAST-PRIVATE-FIELD";
      const originalFailure = new Error(body);
      const publicFailure = {
        code: "quota",
        message: "Review provider setup and retry.",
        recoverable: true,
      };
      retainLocalFailureCause(publicFailure, originalFailure);
      const port: ProviderPort = {
        ...provider("remote"),
        async *startRun(request) {
          yield {
            type: "RunFailed",
            runId: request.runId,
            sequence: 0,
            timestamp: "2026-01-01T00:00:00.000Z",
            error: publicFailure,
          } satisfies RunEvent;
        },
      };
      const engine = new ChatEngine({
        db: adapter(db),
        createId: () => ids[index++]!,
      });
      const run = await engine.send({
        conversationId,
        text: "ephemeral failure fixture",
        binding: binding(port, "remote"),
      });
      const output: RunEvent[] = [];
      for await (const event of run.events) output.push(event);
      const failure = output[0];
      assert.equal(failure?.type, "RunFailed");
      if (failure?.type !== "RunFailed")
        throw new Error("Expected a failed run");
      assert.notEqual(
        failure.error,
        publicFailure,
        "Schema validation must clone the public error",
      );
      assert.equal(localFailureCause(failure.error), originalFailure);
      assert.equal(
        JSON.stringify(failure).includes("LAST-PRIVATE-FIELD"),
        false,
      );
      assert.equal(JSON.stringify(failure).includes("private detail"), false);
      const row = db
        .prepare("SELECT parameters_json FROM runs WHERE id=?")
        .get(run.runId);
      assert.equal(
        String(row?.parameters_json).includes("LAST-PRIVATE-FIELD"),
        false,
      );
      assert.equal(
        String(row?.parameters_json).includes("private detail"),
        false,
      );
      const saved = JSON.parse(String(row?.parameters_json)) as {
        events: RunEvent[];
      };
      const savedFailure = saved.events[0];
      assert.equal(savedFailure?.type, "RunFailed");
      if (savedFailure?.type !== "RunFailed")
        throw new Error("Expected a saved failed event");
      assert.equal(localFailureCause(savedFailure.error), savedFailure.error);
      assert.equal(
        JSON.stringify(await engine.getProjection(conversationId)).includes(
          "LAST-PRIVATE-FIELD",
        ),
        false,
      );
    } finally {
      db.close();
    }
  });
});
