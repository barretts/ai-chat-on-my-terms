import assert from "node:assert/strict";
import { randomFillSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import {
  ChatEngine,
  type ChatGenerationOwner,
} from "@locallab/chat-engine-core";
import type { ProviderPort } from "@locallab/contracts/ports";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { sharedMobileDatabase } from "../../platform/database";
import { createNativeGenerationSession } from "../../platform/generation-session-core";
import { recoverInterruptedChatRuns } from "./recovery";
import { uuidv7 } from "../../platform/crypto-core";
import { SQLiteGenerationLifecycle } from "@locallab/generation-lifecycle-ios";

const now = "2026-09-27T18:00:00.000Z";
const entityId = () =>
  uuidv7((bytes) => {
    randomFillSync(bytes);
  });
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
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "locallab-chat-recovery-"));
  const path = join(directory, "chat.sqlite");
  let native = new DatabaseSync(path);
  let db = sharedMobileDatabase(adapter(native));
  await db.execAsync(
    await readFile(
      new URL("../../../../packages/schema/core/001_core.sql", import.meta.url),
      "utf8",
    ),
  );
  const providerId = entityId(),
    modelId = entityId(),
    conversationId = entityId();
  await db.runAsync(
    "INSERT INTO providers(id,kind,name) VALUES(?,'fixture','Fixture')",
    providerId,
  );
  await db.runAsync(
    "INSERT INTO models(id,provider_id,name) VALUES(?,?,'Fixture model')",
    modelId,
    providerId,
  );
  await db.runAsync(
    "INSERT INTO conversations(id,title) VALUES(?,'Recovery fixture')",
    conversationId,
  );
  // An accurately labeled fake producer permits stopping at an exact durable partial event.
  const port: ProviderPort = {
    async listModels() {
      return [];
    },
    async getCapabilities() {
      return {};
    },
    async *startRun(request) {
      yield {
        type: "RunStarted",
        runId: request.runId,
        sequence: 0,
        timestamp: now,
      };
      yield {
        type: "TextDelta",
        runId: request.runId,
        sequence: 1,
        timestamp: now,
        text: "Durable partial answer.",
      };
      yield {
        type: "ReasoningDelta",
        runId: request.runId,
        sequence: 2,
        timestamp: now,
        text: "Partial reasoning.",
      };
    },
  };
  const create = async (owner?: ChatGenerationOwner) => {
    const engine = new ChatEngine({
      db,
      createId: entityId,
      now: () => now,
      ...(owner ? { generationOwner: owner } : {}),
    });
    const run = await engine.send({
      conversationId,
      text: "Original question",
      binding: {
        providerConnectionId: providerId,
        providerId,
        modelRecordId: modelId,
        modelId: "fixture-model",
        port,
      },
    });
    const events = run.events[Symbol.asyncIterator]();
    await events.next();
    await events.next();
    await events.next();
    return run;
  };
  return {
    get db() {
      return db;
    },
    get native() {
      return native;
    },
    create,
    reopen() {
      native.close();
      native = new DatabaseSync(path);
      db = sharedMobileDatabase(adapter(native));
    },
    async close() {
      native.close();
      assert.equal(dirname(directory), tmpdir());
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const owner = (): ChatGenerationOwner => ({
  id: randomUUID(),
  scope: "mobile-chat",
  platform: "native",
});

describe("scoped interrupted generation recovery over reopened SQLite", () => {
  it("rolls back the terminal event when lifecycle reconciliation fails", async () => {
    const saved = await fixture();
    const checking = createNativeGenerationSession(randomUUID());
    try {
      const run = await saved.create(owner());
      const lifecycle = new SQLiteGenerationLifecycle(saved.db, {
        now: () => now,
      });
      await lifecycle.initialize();
      const row = saved.native
        .prepare("SELECT conversation_id,parameters_json FROM runs WHERE id=?")
        .get(run.runId)!;
      await lifecycle.start({
        runId: run.runId,
        conversationId: row.conversation_id as string,
        execution: "local",
      });
      for (const event of JSON.parse(row.parameters_json as string).events)
        await lifecycle.record(event);
      await lifecycle.suspend(run.runId);
      saved.reopen();
      await saved.db.execAsync(
        "CREATE TRIGGER reject_recovery BEFORE UPDATE OF state ON generation_lifecycle BEGIN SELECT RAISE(ABORT,'fixture lifecycle write failed'); END",
      );
      await assert.rejects(
        recoverInterruptedChatRuns(saved.db, checking),
        /fixture lifecycle write failed/,
      );
      const after = saved.native
        .prepare("SELECT status,parameters_json FROM runs WHERE id=?")
        .get(run.runId)!;
      assert.equal(after.status, "running");
      assert.equal(
        JSON.parse(after.parameters_json as string).events.length,
        3,
      );
      assert.equal(
        (await new SQLiteGenerationLifecycle(saved.db).get(run.runId))!.state,
        "interrupted",
      );
      await saved.db.execAsync("DROP TRIGGER reject_recovery");
      assert.equal(
        (await recoverInterruptedChatRuns(saved.db, checking)).recovered.length,
        1,
      );
      assert.equal(
        (await new SQLiteGenerationLifecycle(saved.db).get(run.runId))!.state,
        "canceled",
      );
    } finally {
      await checking.dispose();
      await saved.close();
    }
  });
  it("persists one terminal event after process loss, preserves partial parts, and remains idempotent after reopen", async () => {
    const saved = await fixture();
    const session = createNativeGenerationSession(randomUUID());
    try {
      const oldOwner = owner();
      const run = await saved.create(oldOwner);
      const lifecycle = new SQLiteGenerationLifecycle(saved.db, {
        now: () => now,
      });
      await lifecycle.initialize();
      const storedRun = saved.native
        .prepare("SELECT parameters_json,conversation_id FROM runs WHERE id=?")
        .get(run.runId)!;
      await lifecycle.start({
        runId: run.runId,
        conversationId: storedRun.conversation_id as string,
        execution: "local",
      });
      const recorded = JSON.parse(storedRun.parameters_json as string).events;
      await lifecycle.record(recorded[0]);
      await lifecycle.record(recorded[1]);
      await lifecycle.suspend(run.runId);
      const before = saved.native
        .prepare("SELECT parts_json FROM messages WHERE id=?")
        .get(run.assistantMessageId)!.parts_json;
      saved.reopen();
      const result = await recoverInterruptedChatRuns(saved.db, session, {
        now: () => now,
      });
      assert.equal(result.recovered.length, 1);
      assert.equal(result.recovered[0]!.event.type, "RunCanceled");
      const row = saved.native
        .prepare("SELECT status,parameters_json FROM runs WHERE id=?")
        .get(run.runId)!;
      assert.equal(row.status, "canceled");
      const metadata = JSON.parse(row.parameters_json as string);
      assert.deepEqual(metadata.generationOwner, oldOwner);
      assert.equal(metadata.events.length, 4);
      assert.equal(metadata.events.at(-1).sequence, 3);
      const restoredLifecycle = saved.native
        .prepare(
          "SELECT state,last_sequence,partial_text,partial_reasoning FROM generation_lifecycle WHERE run_id=?",
        )
        .get(run.runId)!;
      assert.equal(restoredLifecycle.state, "canceled");
      assert.equal(restoredLifecycle.last_sequence, 3);
      assert.equal(restoredLifecycle.partial_text, "Durable partial answer.");
      assert.equal(restoredLifecycle.partial_reasoning, "Partial reasoning.");
      assert.equal(
        saved.native
          .prepare("SELECT parts_json FROM messages WHERE id=?")
          .get(run.assistantMessageId)!.parts_json,
        before,
      );
      const snapshot = await new ChatEngine({ db: saved.db }).getProjection(
        saved.native
          .prepare("SELECT conversation_id FROM runs WHERE id=?")
          .get(run.runId)!.conversation_id as string,
      );
      assert.equal(snapshot.messages[0]!.status, "canceled");
      assert.deepEqual(
        snapshot.messages[0]!.parts,
        JSON.parse(before as string),
      );
      saved.reopen();
      assert.equal(
        (await recoverInterruptedChatRuns(saved.db, session)).recovered.length,
        0,
      );
      assert.equal(
        JSON.parse(
          saved.native
            .prepare("SELECT parameters_json FROM runs WHERE id=?")
            .get(run.runId)!.parameters_json as string,
        ).events.length,
        4,
      );
    } finally {
      await session.dispose();
      await saved.close();
    }
  });

  it("does not cancel another native route's live owner or an untagged engine", async () => {
    const saved = await fixture();
    const live = createNativeGenerationSession(randomUUID());
    const checking = createNativeGenerationSession(randomUUID());
    try {
      const protectedRun = await saved.create(live.owner);
      const unknownRun = await saved.create();
      const result = await recoverInterruptedChatRuns(saved.db, checking);
      assert.deepEqual(result.skippedLive, [protectedRun.runId]);
      assert.deepEqual(result.skippedUnknown, [unknownRun.runId]);
      assert.equal(result.recovered.length, 0);
      assert.equal(
        saved.native
          .prepare("SELECT COUNT(*) AS n FROM runs WHERE status='running'")
          .get()!.n,
        2,
      );
      saved.reopen(); // The fake paused engine no longer owns an open connection.
      await live.dispose();
      const afterClose = await recoverInterruptedChatRuns(saved.db, checking);
      assert.equal(afterClose.recovered[0]!.runId, protectedRun.runId);
      assert.equal(
        saved.native
          .prepare("SELECT status FROM runs WHERE id=?")
          .get(unknownRun.runId)!.status,
        "running",
      );
    } finally {
      await live.dispose();
      await checking.dispose();
      await saved.close();
    }
  });

  it("holds the owner claim during recovery work and repairs an existing terminal without duplication", async () => {
    const saved = await fixture();
    const checking = createNativeGenerationSession(randomUUID());
    try {
      const previous = owner();
      const run = await saved.create(previous);
      const row = saved.native
        .prepare("SELECT parameters_json FROM runs WHERE id=?")
        .get(run.runId)!;
      const metadata = JSON.parse(row.parameters_json as string);
      metadata.events.push({
        type: "RunCompleted",
        runId: run.runId,
        sequence: 3,
        timestamp: now,
      });
      await saved.db.runAsync(
        "UPDATE runs SET parameters_json=? WHERE id=?",
        JSON.stringify(metadata),
        run.runId,
      );
      const claimed = await checking.withOrphanedOwner(previous, async () => {
        assert.throws(
          () => createNativeGenerationSession(previous.id),
          /already active/,
        );
        return "claim held";
      });
      assert.deepEqual(claimed, { orphaned: true, value: "claim held" });
      const result = await recoverInterruptedChatRuns(saved.db, checking);
      assert.equal(result.recovered[0]!.event.type, "RunCompleted");
      assert.equal(
        saved.native
          .prepare("SELECT status FROM runs WHERE id=?")
          .get(run.runId)!.status,
        "completed",
      );
      assert.equal(
        JSON.parse(
          saved.native
            .prepare("SELECT parameters_json FROM runs WHERE id=?")
            .get(run.runId)!.parameters_json as string,
        ).events.length,
        4,
      );
    } finally {
      await checking.dispose();
      await saved.close();
    }
  });
});
