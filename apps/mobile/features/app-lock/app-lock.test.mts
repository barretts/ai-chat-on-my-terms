import { describe, expect, it } from "vitest";
import { createLockSession } from "@locallab/app-lock";
import type { HashPort, LockRecord, LockRecordStore } from "@locallab/app-lock";
import { DEFAULT_LOCK_PREFS, createLockPrefsStore } from "./index";

function fakeDb() {
  const rows = new Map<string, string>();
  return {
    async execAsync(sql: string) {
      void sql;
    },
    async runAsync(sql: string, doc: string) {
      if (sql.includes("INSERT INTO app_lock_prefs")) rows.set("lock", doc);
    },
    async getFirstAsync<T>(sql: string): Promise<T | null> {
      if (sql.includes("FROM app_lock_prefs")) {
        const doc = rows.get("lock");
        return doc === undefined ? null : ({ doc } as T);
      }
      return null;
    },
    rows,
  };
}

describe("app lock preferences", () => {
  it("round-trips grace and falls back to defaults on bad rows", async () => {
    const db = fakeDb();
    const store = createLockPrefsStore(db as never);
    expect(await store.load()).toEqual(DEFAULT_LOCK_PREFS);
    await store.save({ version: 1, grace: "fifteenMinutes" });
    expect(await store.load()).toEqual({
      version: 1,
      grace: "fifteenMinutes",
    });
    db.rows.set("lock", "{ not json");
    expect(await store.load()).toEqual(DEFAULT_LOCK_PREFS);
    db.rows.set("lock", JSON.stringify({ version: 1, grace: "eternity" }));
    expect(await store.load()).toEqual(DEFAULT_LOCK_PREFS);
    await store.save({ version: 1, grace: "eternity" as never });
    expect(await store.load()).toEqual(DEFAULT_LOCK_PREFS);
  });

  it("stored grace drives the session gate", async () => {
    const db = fakeDb();
    await createLockPrefsStore(db as never).save({
      version: 1,
      grace: "oneHour",
    });
    const loaded = await createLockPrefsStore(db as never).load();
    let record: LockRecord | null = {
      version: 1,
      kind: "pin",
      algorithm: "test",
      salt: "aa",
      hash: "deadbeef",
      digits: 4,
    };
    const records: LockRecordStore = {
      async load() {
        return record;
      },
      async save(next) {
        record = next;
      },
      async clear() {
        record = null;
      },
    };
    const hash: HashPort = {
      algorithm: "test",
      async hash() {
        return "deadbeef";
      },
      randomSalt: () => "aa",
    };
    const session = createLockSession({ hash, records });
    session.setGrace(loaded.grace);
    session.backgrounded(0);
    session.foregrounded(60_000);
    expect(session.status().locked).toBe(false);
    session.backgrounded(0);
    session.foregrounded(3_600_001);
    expect(session.status()).toEqual({
      locked: true,
      reason: "grace-expiry",
    });
  });
});
