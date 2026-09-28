import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSQLiteRecordProbePort,
  type ProbeSQLiteDatabase,
} from "../src/sqlite-probe.js";

test("SQLite port persists a parameterized record across close and reopen", async () => {
  const rows = new Map<
    string,
    { id: string; value: string; created_at: string }
  >();
  const calls: string[] = [];
  let opened = 0;
  const openDatabase = async (name: string): Promise<ProbeSQLiteDatabase> => {
    calls.push(`open:${name}`);
    opened += 1;
    return {
      async execAsync(sql) {
        calls.push(`exec:${sql.startsWith("CREATE TABLE")}`);
      },
      async runAsync(sql, ...params) {
        calls.push(`write:${sql.includes("VALUES (?, ?, ?)")}`);
        const [id, value, created_at] = params;
        rows.set(String(id), {
          id: String(id),
          value: String(value),
          created_at: String(created_at),
        });
      },
      async getFirstAsync(_sql, ...params) {
        calls.push("read");
        return (rows.get(String(params[0])) ?? null) as never;
      },
      async closeAsync() {
        calls.push("close");
      },
    };
  };
  const port = createSQLiteRecordProbePort(openDatabase);
  const input = {
    id: "probe-1",
    value: "survives restart",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  assert.deepEqual(await port.createWriteCloseReopenRead(input), input);
  assert.equal(opened, 2);
  assert.deepEqual(calls, [
    "open:expo-transport-probe.db",
    "exec:true",
    "write:true",
    "close",
    "open:expo-transport-probe.db",
    "read",
    "close",
  ]);
});

test("SQLite closes the write connection when a write fails", async () => {
  let closed = false;
  const db: ProbeSQLiteDatabase = {
    async execAsync() {},
    async runAsync() {
      throw new Error("fixture failure");
    },
    async getFirstAsync() {
      return null;
    },
    async closeAsync() {
      closed = true;
    },
  };
  const port = createSQLiteRecordProbePort(async () => db);
  await assert.rejects(() =>
    port.createWriteCloseReopenRead({ id: "x", value: "v", createdAt: "now" }),
  );
  assert.equal(closed, true);
});
