import { describe, expect, it } from "vitest";
import {
  createAppearanceBehaviorStore,
  createBehaviorController,
} from "./index";
import type { BatterySource } from "./index";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type {
  AppearanceBehaviorV1,
  BatterySnapshot,
} from "@locallab/appearance-behavior";

function fakeBehaviorDb() {
  const rows = new Map<string, string>();
  const db: SQLiteDatabasePort = {
    async execAsync() {},
    async getFirstAsync<T>(sql: string, ...params: (string | number)[]) {
      if (sql.startsWith("SELECT doc FROM appearance_behavior")) {
        const doc = rows.get(String(params[0]));
        return doc === undefined ? null : ({ doc } as T);
      }
      return null;
    },
    async getAllAsync<T>() {
      return [];
    },
    async runAsync(sql: string, ...params: (string | number)[]) {
      if (sql.startsWith("INSERT INTO appearance_behavior")) {
        rows.set(String(params[0]), String(params[1]));
      }
      return {};
    },
    async withTransactionAsync(work: () => Promise<void>) {
      await work();
    },
  };
  return { db, rows };
}

function scriptedBattery(initial: BatterySnapshot | null) {
  let listeners: ((battery: BatterySnapshot | null) => void)[] = [];
  let current = initial;
  const source: BatterySource = {
    async read() {
      return current;
    },
    subscribe(onChange) {
      listeners.push(onChange);
      return () => {
        listeners = listeners.filter((listener) => listener !== onChange);
      };
    },
  };
  return {
    source,
    emit(battery: BatterySnapshot | null) {
      current = battery;
      for (const listener of listeners) listener(battery);
    },
  };
}

const behavior: AppearanceBehaviorV1 = {
  version: 1,
  glassEnabled: true,
  lowBatteryMode: "auto",
  fullWidthReplies: true,
};

describe("appearance behavior store", () => {
  it("round-trips settings and falls back to defaults on corrupt rows", async () => {
    const { db, rows } = fakeBehaviorDb();
    const store = createAppearanceBehaviorStore(db);
    expect(await store.load()).toEqual(behavior);
    const saved = await store.save({ ...behavior, glassEnabled: false });
    expect(saved.ok).toBe(true);
    expect(await store.load()).toEqual({ ...behavior, glassEnabled: false });
    rows.set("global", "not json at all");
    expect(await store.load()).toEqual(behavior);
  });

  it("rejects invalid settings writes and leaves stored data untouched", async () => {
    const { db, rows } = fakeBehaviorDb();
    const store = createAppearanceBehaviorStore(db);
    await store.save({ ...behavior, lowBatteryMode: "on" });
    const bad = await store.save({
      version: 2,
      glassEnabled: true,
      lowBatteryMode: "auto",
      fullWidthReplies: true,
    } as unknown as AppearanceBehaviorV1);
    expect(bad.ok).toBe(false);
    expect(JSON.parse(rows.get("global")!)).toMatchObject({
      lowBatteryMode: "on",
    });
  });
});

describe("low-battery profile and deferred sync", () => {
  it("defers sync sends on low battery and flushes them after recovery", async () => {
    const { db } = fakeBehaviorDb();
    const battery = scriptedBattery({ level: 0.85, charging: true });
    const controller = createBehaviorController(
      createAppearanceBehaviorStore(db),
      battery.source,
    );
    await controller.start();
    const sent: string[] = [];
    const gate = controller.registerGate({
      async send(payload, requestId) {
        sent.push(requestId);
      },
    });
    await gate.send("a", "r1");
    expect(sent).toEqual(["r1"]);

    battery.emit({ level: 0.1, charging: false });
    expect(controller.active).toBe(true);
    expect(controller.effects()).toBe("reduced");
    expect(controller.plainStream()).toBe(true);
    await gate.send("b", "r2");
    await gate.send("c", "r3");
    expect(sent).toEqual(["r1"]);
    expect(gate.pendingCount()).toBe(2);

    battery.emit({ level: 0.9, charging: false });
    for (let tick = 0; tick < 50 && sent.length < 3; tick += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(sent).toEqual(["r1", "r2", "r3"]);
    expect(gate.pendingCount()).toBe(0);
  });

  it("manual low-battery mode defers immediately and persists across reload", async () => {
    const { db } = fakeBehaviorDb();
    const battery = scriptedBattery(null);
    const controller = createBehaviorController(
      createAppearanceBehaviorStore(db),
      battery.source,
    );
    await controller.start();
    const result = await controller.update({
      ...behavior,
      lowBatteryMode: "on",
    });
    expect(result.ok).toBe(true);
    expect(controller.active).toBe(true);
    const sent: unknown[] = [];
    const gate = controller.registerGate({
      async send(payload) {
        sent.push(payload);
      },
    });
    expect(gate.deferred).toBe(true);
    const reloaded = await createAppearanceBehaviorStore(db).load();
    expect(reloaded.lowBatteryMode).toBe("on");
  });
});
