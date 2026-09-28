import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { AdvancedChatEngine } from "@locallab/chat-engine-advanced";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent } from "@locallab/contracts/run-events";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { sharedMobileDatabase } from "../../platform/database";
import {
  ForegroundRunAdmission,
  ForegroundRunSuspendedError,
} from "./foreground";

const id = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const timestamp = "2026-09-26T12:00:00.000Z";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function adapter(native: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => native.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      native.prepare(sql).run(...params),
    getFirstAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      (native.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      native.prepare(sql).all(...params) as T[],
    withTransactionAsync: async () => {
      throw new Error("The fixture uses the shared transaction facade");
    },
  };
}

async function fixture() {
  const native = new DatabaseSync(":memory:");
  const db = sharedMobileDatabase(adapter(native));
  await db.execAsync("PRAGMA foreign_keys=ON");
  await db.execAsync(
    await readFile(
      new URL("../../../../packages/schema/core/001_core.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.runAsync(
    "INSERT INTO providers(id,kind,name) VALUES(?,?,?)",
    id(1),
    "fixture",
    "Foreground fixture",
  );
  await db.runAsync(
    "INSERT INTO models(id,provider_id,name) VALUES(?,?,?)",
    id(2),
    id(1),
    "fixture-model",
  );
  await db.runAsync(
    "INSERT INTO conversations(id,title) VALUES(?,?)",
    id(3),
    "Foreground chat",
  );
  let providerCalls = 0;
  const port: ProviderPort = {
    listModels: async () => ({ ok: true, value: ["fixture-model"] }),
    getCapabilities: async () => ({ ok: true, value: {} }),
    async *startRun(request) {
      providerCalls += 1;
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
  let next = 100;
  const engine = new AdvancedChatEngine({
    db,
    createId: () => id(next++),
    now: () => timestamp,
    context: { tokenBudget: 1024, reservedOutputTokens: 64, policy: "roll" },
  });
  return {
    native,
    db,
    providerCalls: () => providerCalls,
    start: () =>
      engine.send({
        conversationId: id(3),
        text: "Explain the foreground admission check.",
        binding: {
          port,
          providerConnectionId: id(4),
          providerId: id(1),
          modelRecordId: id(2),
          modelId: "fixture-model",
        },
      }),
  };
}

test("a background-to-foreground transition during preflight rejects the captured send before creating a run", async () => {
  const chat = await fixture();
  try {
    let active = true;
    const foreground = new ForegroundRunAdmission(() => active);
    const admission = foreground.begin();
    const preflight = gate();
    const pending = (async () => {
      await preflight.promise;
      admission.assertActive();
      return admission.admit(chat.start);
    })();
    active = false;
    foreground.suspend();
    active = true;
    preflight.release();
    await assert.rejects(pending, ForegroundRunSuspendedError);
    assert.equal(chat.providerCalls(), 0);
    assert.deepEqual(await chat.db.getAllAsync("SELECT id FROM runs"), []);
    assert.deepEqual(await chat.db.getAllAsync("SELECT id FROM messages"), []);

    const run = await foreground.begin().admit(chat.start);
    for await (const event of run.events) {
      assert.notEqual(event.type, "RunFailed");
    }
    assert.equal(chat.providerCalls(), 1);
    assert.equal(
      (
        await chat.db.getFirstAsync<{ status: string }>(
          "SELECT status FROM runs WHERE id=?",
          run.runId,
        )
      )?.status,
      "completed",
    );
  } finally {
    chat.native.close();
  }
});

test("suspension during an awaited engine start returns a stopped handle whose events can still be drained", async () => {
  const chat = await fixture();
  try {
    let active = true;
    const foreground = new ForegroundRunAdmission(() => active);
    const admission = foreground.begin();
    const startReached = gate();
    const startRelease = gate();
    let stopCalls = 0;
    const pending = admission.admit(async () => {
      const run = await chat.start();
      startReached.release();
      await startRelease.promise;
      return {
        ...run,
        stop: async () => {
          stopCalls += 1;
          await run.stop();
        },
      };
    });
    await startReached.promise;
    assert.equal(chat.providerCalls(), 0);
    assert.equal(
      (
        await chat.db.getFirstAsync<{ status: string }>(
          "SELECT status FROM runs",
        )
      )?.status,
      "running",
    );
    active = false;
    foreground.suspend();
    startRelease.release();
    const run = await pending;
    assert.equal(stopCalls, 1);
    const events: RunEvent[] = [];
    for await (const event of run.events) events.push(event);
    assert.deepEqual(
      events.map((event) => event.type),
      ["RunCanceled"],
    );
    assert.equal(chat.providerCalls(), 0);
    assert.equal(
      (
        await chat.db.getFirstAsync<{ status: string }>(
          "SELECT status FROM runs WHERE id=?",
          run.runId,
        )
      )?.status,
      "canceled",
    );
    assert.throws(admission.assertActive, ForegroundRunSuspendedError);
  } finally {
    chat.native.close();
  }
});

test("an async start that already owns provider work must finish stop before admission returns", async () => {
  let active = true;
  let providerCalls = 0;
  let providerResources = 0;
  let stopCalls = 0;
  let returned = false;
  const foreground = new ForegroundRunAdmission(() => active);
  const admission = foreground.begin();
  const startReached = gate();
  const startRelease = gate();
  const stopReached = gate();
  const stopRelease = gate();
  const handle = {
    stop: async () => {
      stopCalls += 1;
      stopReached.release();
      await stopRelease.promise;
      providerResources -= 1;
    },
  };
  const pending = admission
    .admit(async () => {
      providerCalls += 1;
      providerResources += 1;
      startReached.release();
      await startRelease.promise;
      return handle;
    })
    .then((run) => {
      returned = true;
      return run;
    });
  await startReached.promise;
  active = false;
  foreground.suspend();
  active = true;
  startRelease.release();
  await stopReached.promise;
  assert.equal(providerCalls, 1);
  assert.equal(stopCalls, 1);
  assert.equal(providerResources, 1);
  assert.equal(returned, false);
  stopRelease.release();
  assert.equal(await pending, handle);
  assert.equal(providerResources, 0);
  assert.equal(returned, true);

  active = false;
  await assert.rejects(
    foreground.begin().admit(async () => {
      providerCalls += 1;
      return handle;
    }),
    ForegroundRunSuspendedError,
  );
  assert.equal(providerCalls, 1);
});
