import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { RunEvent } from "@locallab/contracts/run-events";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { SQLiteGenerationLifecycle } from "../src/index.js";

// Exercise the app's actual operation queue, including its scoped transaction facade.
const { sharedMobileDatabase } = createRequire(import.meta.url)(
  "../../../../apps/mobile/platform/database.ts",
) as {
  sharedMobileDatabase(database: SQLiteDatabasePort): SQLiteDatabasePort;
};

const runId = "018f0000-0000-7000-8000-000000000201";
const conversationId = "018f0000-0000-7000-8000-000000000202";

function createDb(): { db: SQLiteDatabasePort; close(): void } {
  const native = new DatabaseSync(":memory:");
  return {
    close: () => native.close(),
    db: {
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
    },
  };
}

function event(type: RunEvent["type"], sequence: number): RunEvent {
  const base = {
    runId,
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  switch (type) {
    case "RunStarted":
      return { ...base, type };
    case "TextDelta":
      return { ...base, type, text: "private answer" };
    case "ReasoningDelta":
      return { ...base, type, text: "private thought" };
    case "RunCompleted":
      return { ...base, type };
    default:
      throw new Error(`Unsupported test event: ${type}`);
  }
}

describe("SQLite generation lifecycle", () => {
  it("retains the stop callback when start and suspension overlap behind a held shared DB transaction", async () => {
    const { db: rawDb, close } = createDb();
    const db = sharedMobileDatabase(rawDb);
    let entered!: () => void;
    let release!: () => void;
    const insideTransaction = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopped = 0;
    let blocked: Promise<void> | undefined;
    let started: Promise<unknown> | undefined;
    let suspended: Promise<unknown> | undefined;
    try {
      const lifecycle = new SQLiteGenerationLifecycle(db);
      await lifecycle.initialize();
      blocked = db.withTransactionAsync(async (transaction) => {
        assert.ok(transaction);
        await transaction.getFirstAsync("SELECT 1");
        entered();
        await held;
      });
      await insideTransaction;
      let startSettled = false;
      let suspendSettled = false;
      started = lifecycle
        .start({
          runId,
          conversationId,
          execution: "local",
          stop: () => {
            stopped += 1;
          },
        })
        .then((snapshot) => {
          startSettled = true;
          return snapshot;
        });
      suspended = lifecycle.suspend(runId).then((snapshot) => {
        suspendSettled = true;
        assert.equal(snapshot?.state, "interrupted");
        return snapshot;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(startSettled, false);
      assert.equal(suspendSettled, false);
      assert.equal(stopped, 0);
      release();
      await Promise.all([blocked, started, suspended]);
      assert.equal(stopped, 1);
      assert.equal((await lifecycle.get(runId))?.state, "interrupted");
      assert.equal((await lifecycle.suspend(runId))?.state, "interrupted");
      assert.equal(stopped, 1);
    } finally {
      release();
      await Promise.allSettled([blocked, started, suspended]);
      close();
    }
  });

  it("persists partial text and marks local work interrupted without a fake terminal", async () => {
    const { db, close } = createDb();
    const notifications: unknown[] = [];
    let stopped = 0;
    try {
      const lifecycle = new SQLiteGenerationLifecycle(db, {
        notifications: {
          publish: (item) => {
            notifications.push(item);
          },
        },
        stopLocal: async () => {
          stopped += 1;
        },
        now: () => "2026-01-01T00:00:00.000Z",
        progressCharacterInterval: 1,
      });
      await lifecycle.initialize();
      await lifecycle.start({
        runId,
        conversationId,
        execution: "local",
        stop: async () => {
          stopped += 1;
        },
      });
      assert.equal(await lifecycle.record(event("RunStarted", 0)), true);
      assert.equal(await lifecycle.record(event("TextDelta", 1)), true);
      assert.equal(await lifecycle.record(event("TextDelta", 1)), false);
      assert.deepEqual(await lifecycle.suspend(runId), {
        runId,
        conversationId,
        execution: "local",
        state: "interrupted",
        lastSequence: 1,
        partialText: "private answer",
        partialReasoning: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      assert.equal(stopped, 1);
      assert.ok(notifications.length >= 2);
      assert.equal(
        JSON.stringify(notifications).includes("private answer"),
        false,
      );
      assert.equal(await lifecycle.record(event("RunCompleted", 2)), false);
      assert.equal((await lifecycle.get(runId))?.state, "interrupted");
    } finally {
      close();
    }
  });

  it("clamps the iOS short window and records expiration honestly", async () => {
    const { db, close } = createDb();
    let expire: (() => Promise<void>) | undefined;
    let duration = 0;
    let ended = 0;
    let finishWork!: () => void;
    try {
      const lifecycle = new SQLiteGenerationLifecycle(db, {
        backgroundExecution: {
          async begin(input) {
            expire = input.onExpiration;
            duration = input.maximumDurationMs;
            return "token";
          },
          end(token) {
            assert.equal(token, "token");
            ended += 1;
          },
        },
      });
      await lifecycle.initialize();
      await lifecycle.start({ runId, conversationId, execution: "local" });
      const operation = lifecycle.withShortBackgroundWindow(
        runId,
        () => new Promise<void>((resolve) => (finishWork = resolve)),
        60_000,
      );
      await Promise.resolve();
      assert.equal(duration, 25_000);
      await expire?.();
      finishWork();
      await assert.rejects(operation, /window expired/);
      assert.equal(ended, 1);
      assert.equal((await lifecycle.get(runId))?.state, "interrupted");
    } finally {
      close();
    }
  });

  it("keeps remote jobs resumable, reconciles once, and accepts one terminal", async () => {
    const { db, close } = createDb();
    let remoteStop = 0;
    try {
      const lifecycle = new SQLiteGenerationLifecycle(db, {
        remoteRuns: {
          async *reconcile(jobId) {
            assert.equal(jobId, "job-123");
            yield event("TextDelta", 1);
            yield event("RunCompleted", 2);
          },
        },
      });
      await lifecycle.initialize();
      await lifecycle.start({
        runId,
        conversationId,
        execution: "remote",
        remoteJobId: "job-123",
        stop: () => {
          remoteStop += 1;
        },
      });
      await lifecycle.record(event("RunStarted", 0));
      assert.equal((await lifecycle.suspend(runId))?.state, "remote_pending");
      assert.equal(remoteStop, 0);
      assert.equal((await lifecycle.resume(runId))?.state, "completed");
      assert.equal((await lifecycle.cancel(runId))?.state, "completed");
      assert.equal(remoteStop, 0);
      assert.equal((await lifecycle.get(runId))?.partialText, "private answer");
    } finally {
      close();
    }
  });

  it("interrupts and stops remote streams without a durable job ID", async () => {
    const { db, close } = createDb();
    let stopped = 0;
    let reconciled = 0;
    try {
      const lifecycle = new SQLiteGenerationLifecycle(db, {
        remoteRuns: {
          async *reconcile() {
            reconciled += 1;
            yield event("RunCompleted", 2);
          },
        },
      });
      await lifecycle.initialize();
      await lifecycle.start({
        runId,
        conversationId,
        execution: "remote",
        stop: () => {
          stopped += 1;
        },
      });
      await lifecycle.record(event("RunStarted", 0));
      await lifecycle.record(event("TextDelta", 1));
      const suspended = await lifecycle.suspend(runId);
      assert.equal(suspended?.execution, "remote");
      assert.equal(suspended?.state, "interrupted");
      assert.equal(suspended?.partialText, "private answer");
      assert.equal(suspended?.remoteJobId, undefined);
      assert.equal(stopped, 1);
      assert.equal((await lifecycle.suspend(runId))?.state, "interrupted");
      assert.equal(stopped, 1);
      assert.equal((await lifecycle.resume(runId))?.state, "interrupted");
      assert.equal(reconciled, 0);
      assert.equal(await lifecycle.record(event("RunCompleted", 2)), false);
      assert.equal((await lifecycle.get(runId))?.state, "interrupted");
    } finally {
      close();
    }
  });
});
