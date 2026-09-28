import { DatabaseSync } from "node:sqlite";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import type { ProviderPort, CapabilityMap } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import { SQLiteArenaStore, type ArenaBinding } from "../src/index.js";

export const id = (value: number) =>
  `019a0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
export const date = () => new Date("2026-09-26T12:00:00.000Z");
export function idSource() {
  let value = 1;
  return () => id(value++);
}

export function port(db: DatabaseSync): SQLiteDatabasePort {
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

export async function ready(path = ":memory:", now = date) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  const store = new SQLiteArenaStore(port(db), { deviceId: id(999), now });
  await store.initialize();
  return { db, store };
}

export function event(
  request: RunRequest,
  sequence: number,
  payload: Record<string, unknown>,
): RunEvent {
  return {
    runId: request.runId,
    sequence,
    timestamp: date().toISOString(),
    ...payload,
  } as RunEvent;
}

export function provider(
  stream: (request: RunRequest, signal: AbortSignal) => AsyncIterable<RunEvent>,
  capabilities: CapabilityMap = {},
): ProviderPort {
  return {
    listModels: async () => ({ ok: true, value: ["fixture-exact"] }),
    getCapabilities: async () => ({ ok: true, value: capabilities }),
    startRun: stream,
  };
}

export function binding(
  value: number,
  providerPort: ProviderPort,
  extras: Partial<ArenaBinding> = {},
): ArenaBinding {
  return {
    providerConnectionId: id(100 + value),
    modelId: `fixture-${value}`,
    label: `Contestant ${value}`,
    port: providerPort,
    ...extras,
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function stopped(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
