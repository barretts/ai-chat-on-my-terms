import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  IOSBackgroundDownloads,
  SQLiteDownloadRepository,
  type BackgroundTransferBridge,
  type DownloadRecord,
  type DownloadRepository,
  type NativeTransferEvent,
  type NativeTransferSnapshot,
} from "../src/index.js";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";

function sqlitePort(database: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => database.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      database.prepare(sql).run(...params),
    getFirstAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      (database.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: SqliteBindValue[]) =>
      database.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
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

class MemoryRepository implements DownloadRepository {
  rows = new Map<string, DownloadRecord>();
  async get(id: string) {
    return this.rows.get(id);
  }
  async list() {
    return [...this.rows.values()];
  }
  async save(row: DownloadRecord) {
    this.rows.set(row.id, structuredClone(row));
  }
}

class FakeSession implements BackgroundTransferBridge {
  tasks: NativeTransferSnapshot[] = [];
  listener: ((event: NativeTransferEvent) => void) | undefined;
  canceled: string[] = [];
  resumed: string[] = [];
  async create(_url: string, transferId: string) {
    const taskId = `task-${transferId}`;
    this.tasks.push({
      taskId,
      transferId,
      state: "suspended",
      receivedBytes: 0,
    });
    return { taskId };
  }
  async resume(
    taskId: string,
    _resumeData?: string,
  ): Promise<{ taskId?: string } | void> {
    this.resumed.push(taskId);
  }
  async cancel(taskId: string) {
    this.canceled.push(taskId);
  }
  async pause(taskId: string) {
    return { resumeData: `resume-${taskId}` };
  }
  async enumerate() {
    return this.tasks;
  }
  subscribe(listener: (event: NativeTransferEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  emit(event: NativeTransferEvent) {
    this.listener?.(event);
  }
}

function setup(hash = "a".repeat(64)) {
  const repository = new MemoryRepository();
  const bridge = new FakeSession();
  const promotions: string[] = [];
  const registered: unknown[] = [];
  const discarded: string[] = [];
  const statuses: unknown[] = [];
  const files = {
    result: { byteLength: 1024, sha256: hash },
    async inspect(_path: string) {
      return this.result;
    },
    async promote(path: string, filename: string) {
      promotions.push(path);
      return `managed/${filename}`;
    },
    async discard(path: string) {
      discarded.push(path);
    },
  };
  const downloads = new IOSBackgroundDownloads({
    bridge,
    repository,
    files,
    models: {
      async register(input) {
        registered.push(input);
        return {
          ...input,
          createdAt: "now",
          mimeType: "application/octet-stream",
        };
      },
    },
    status: {
      async publish(status) {
        statuses.push(status);
      },
    },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return {
    downloads,
    repository,
    bridge,
    files,
    promotions,
    registered,
    discarded,
    statuses,
  };
}

const input = {
  id: "model-1",
  url: "https://models.example/model.gguf",
  filename: "model.gguf",
  expectedBytes: 1024,
  expectedSha256: "a".repeat(64),
};

test("SQLite repository retains task identity across repository reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ios-downloads-"));
  const path = join(directory, "downloads.sqlite");
  try {
    const firstDatabase = new DatabaseSync(path);
    const first = new SQLiteDownloadRepository(sqlitePort(firstDatabase));
    await first.initialize();
    await first.save({
      ...input,
      taskId: "session-task-42",
      receivedBytes: 128,
      state: "running",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    firstDatabase.close();
    const secondDatabase = new DatabaseSync(path);
    const second = new SQLiteDownloadRepository(sqlitePort(secondDatabase));
    await second.initialize();
    assert.equal((await second.get(input.id))?.taskId, "session-task-42");
    assert.equal((await second.get(input.id))?.receivedBytes, 128);
    secondDatabase.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists task ID before resume and reports only notification-safe progress", async () => {
  const f = setup();
  await f.downloads.start(input);
  assert.equal((await f.repository.get(input.id))?.taskId, "task-model-1");
  assert.deepEqual(f.bridge.resumed, ["task-model-1"]);
  f.bridge.emit({
    type: "progress",
    taskId: "task-model-1",
    receivedBytes: 512,
    expectedBytes: 1024,
  });
  await f.downloads.flushEvents();
  const status = f.statuses.at(-1) as Record<string, unknown>;
  assert.equal(status.progress, 0.5);
  assert.equal("url" in status, false);
  assert.equal("filename" in status, false);
});

test("reconciles a completed background task and promotes only verified bytes", async () => {
  const f = setup();
  await f.downloads.start(input);
  f.bridge.tasks[0] = {
    ...f.bridge.tasks[0]!,
    state: "completed",
    receivedBytes: 1024,
    temporaryPath: "tmp/model",
  };
  await f.downloads.reconcile();
  assert.equal((await f.repository.get(input.id))?.state, "completed");
  assert.deepEqual(f.promotions, ["tmp/model"]);
  assert.equal(f.registered.length, 1);
});

test("corrupt size or hash is discarded and never made selectable", async (t) => {
  for (const result of [
    { byteLength: 10, sha256: input.expectedSha256 },
    { byteLength: 1024, sha256: "b".repeat(64) },
  ]) {
    await t.test(
      result.byteLength === 10 ? "size mismatch" : "hash mismatch",
      async () => {
        const f = setup();
        f.files.result = result;
        await f.downloads.start(input);
        f.bridge.emit({
          type: "completed",
          taskId: "task-model-1",
          temporaryPath: "tmp/bad",
        });
        await f.downloads.flushEvents();
        assert.equal((await f.repository.get(input.id))?.state, "failed");
        assert.equal(f.promotions.length, 0);
        assert.equal(f.registered.length, 0);
        assert.deepEqual(f.discarded, ["tmp/bad"]);
      },
    );
  }
});

test("cancel persists a terminal state and forwards cancellation to URLSession", async () => {
  const f = setup();
  await f.downloads.start(input);
  await f.downloads.cancel(input.id);
  assert.equal((await f.repository.get(input.id))?.state, "canceled");
  assert.deepEqual(f.bridge.canceled, ["task-model-1"]);
});

test("pause stores opaque resume data and resume can replace the native task ID", async () => {
  const f = setup();
  await f.downloads.start(input);
  f.bridge.resume = async (taskId, resumeData) => {
    assert.equal(taskId, "task-model-1");
    assert.equal(resumeData, "resume-task-model-1");
    return { taskId: "task-model-1-resumed" };
  };
  await f.downloads.pause(input.id);
  assert.equal((await f.repository.get(input.id))?.state, "paused");
  assert.equal(
    (await f.repository.get(input.id))?.resumeData,
    "resume-task-model-1",
  );
  await f.downloads.resume(input.id);
  assert.equal(
    (await f.repository.get(input.id))?.taskId,
    "task-model-1-resumed",
  );
  assert.equal((await f.repository.get(input.id))?.resumeData, undefined);
});

test("relaunch reconciliation reattaches persisted transfer identity", async () => {
  const f = setup();
  await f.downloads.start(input);
  f.bridge.tasks[0] = {
    ...f.bridge.tasks[0]!,
    state: "running",
    receivedBytes: 256,
  };
  const relaunched = new IOSBackgroundDownloads({
    bridge: f.bridge,
    repository: f.repository,
    files: f.files,
    models: {
      async register() {
        throw new Error("unexpected");
      },
    },
  });
  await relaunched.reconcile();
  assert.equal((await f.repository.get(input.id))?.receivedBytes, 256);
  assert.equal((await f.repository.get(input.id))?.state, "running");
});
