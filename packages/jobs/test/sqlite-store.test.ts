import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { SQLiteJobStore } from "../src/sqlite-store.js";

function port(database: DatabaseSync): SQLiteDatabasePort {
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

test("SQLite job records persist across reopen and idempotency is durable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locallab-jobs-"));
  const path = join(directory, "jobs.sqlite");
  try {
    let db = new DatabaseSync(path);
    const migration = await readFile(
      new URL(
        "../../schema/extensions/0003_scheduled_jobs.sql",
        import.meta.url,
      ),
      "utf8",
    );
    db.exec(migration);
    const firstStore = new SQLiteJobStore(port(db));
    const revision = {
      wallMs: 10,
      counter: 0,
      deviceId: "018f0000-0000-7000-8000-000000000001",
    };
    const created = await firstStore.create(
      {
        kind: "download",
        category: "download",
        idempotencyKey: "same",
        input: { model: "m" },
      },
      "2026-01-01T00:00:00.000Z",
      "018f0000-0000-7000-8000-000000000002",
      revision,
    );
    assert.equal(created.created, true);
    await firstStore.transition(created.job.id, ["queued"], {
      state: "running",
      startedAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      revision: { ...revision, counter: 1 },
    });
    db.close();

    db = new DatabaseSync(path);
    const reopened = new SQLiteJobStore(port(db));
    const duplicate = await reopened.create(
      {
        kind: "download",
        category: "download",
        idempotencyKey: "same",
        input: { model: "different" },
      },
      "2026-01-01T00:00:02.000Z",
      "018f0000-0000-7000-8000-000000000003",
      { ...revision, counter: 2 },
    );
    assert.equal(duplicate.created, false);
    assert.deepEqual(duplicate.job.input, { model: "m" });
    assert.equal((await reopened.listNonterminal())[0]?.state, "running");
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
