import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { ModelLeaseRegistry } from "@locallab/groups-parallel";
import {
  SQLiteGroupConfigStore,
  defaultGroupRoomSettings,
  emptyGroupParticipant,
  type GroupParticipantDraft,
  type GroupRoomDraft,
} from "@locallab/groups-config";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  closeStaleRound,
  groupModelKey,
  GroupModelRuntime,
  resolveSharedRoomBinding,
  type RoomModelBinding,
} from "./group-runtime";

const installed: RoomModelBinding[] = [
  {
    providerConnectionId: "018f0000-0000-7000-8000-000000000301",
    modelRecordId: "rec-liquid",
    modelId: "liquid/lfm2.5-2.6b-q4_k_m",
  },
];

test("shared binding resolves only the installed room model", () => {
  assert.deepEqual(
    resolveSharedRoomBinding("liquid/lfm2.5-2.6b-q4_k_m", installed),
    installed[0],
  );
  assert.equal(resolveSharedRoomBinding(null, installed), null);
  assert.equal(resolveSharedRoomBinding("qwen/other", installed), null);
  assert.notEqual(
    groupModelKey(installed[0]!),
    groupModelKey({ ...installed[0]!, modelId: "other" }),
  );
});

test("runtime funnels every request through one context and keeps it loaded", async () => {
  const registry = new ModelLeaseRegistry();
  const key = groupModelKey(installed[0]!);
  let unloads = 0;
  const runtime = new GroupModelRuntime({
    registry,
    hostKey: "phone",
    modelKey: key,
    unload: () => {
      unloads += 1;
    },
  });
  let inFlight = 0;
  let peak = 0;
  const seat = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return "reply";
  };
  await Promise.all([
    runtime.schedule(seat),
    runtime.schedule(seat),
    runtime.schedule(seat),
  ]);
  assert.equal(peak, 1, "one shared model context at any instant");
  assert.equal(unloads, 0, "model stays loaded between replies");
  assert.equal(registry.activeContexts("phone"), 0);
});

test("release waits for in-flight work, blocks new turns, unloads once", async () => {
  const registry = new ModelLeaseRegistry();
  let unloads = 0;
  let release!: () => void;
  const gate = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const runtime = new GroupModelRuntime({
    registry,
    hostKey: "phone",
    modelKey: "room-model",
    unload: () => {
      unloads += 1;
    },
  });
  const inFlight = runtime.schedule(async () => {
    await gate.promise;
    return "late reply";
  });
  const releasing = Promise.all([runtime.release(), runtime.release()]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(unloads, 0, "unload must not fire while a run is in flight");
  await assert.rejects(() => runtime.schedule(async () => "nope"), /releasing/);
  release();
  assert.equal(await inFlight, "late reply");
  await releasing;
  assert.equal(unloads, 1, "concurrent releases must unload exactly once");
  assert.equal(registry.activeContexts("phone"), 0);
  assert.equal(await runtime.schedule(async () => "after"), "after");
});

const gid = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

function sqlite(database: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => database.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      database.prepare(sql).run(...params),
    getFirstAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      (database.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      database.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        await work();
        database.exec("COMMIT");
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  };
}

test("reopen closes a stale active round once, keeps saved progress, never resumes", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const config = new SQLiteGroupConfigStore(sqlite(database));
    await SQLiteGroupConfigStore.initialize(sqlite(database));
    let nextId = 9000;
    const createId = () => gid(nextId++);
    const seats: GroupParticipantDraft[] = [
      { ...emptyGroupParticipant(), personaId: gid(5001), displayName: "Ada" },
      {
        ...emptyGroupParticipant(),
        personaId: gid(5002),
        displayName: "Grace",
      },
    ];
    const draft: GroupRoomDraft = {
      id: null,
      name: "War room",
      scenario: "",
      userDisplayName: "Sam",
      conversationId: gid(6001),
      settings: defaultGroupRoomSettings(),
      participants: seats,
    };
    const roomId = await config.saveRoom(draft, createId);
    const saved = await config.loadRoom(roomId);
    assert.ok(saved);
    // A crash left the round ACTIVE at seat 1 with seat 0 already answered.
    const round = await config.beginRound(
      roomId,
      saved.conversationId,
      {
        trigger: "send",
        frozenOrder: [0, 1],
        settings: defaultGroupRoomSettings(),
      },
      createId,
    );
    await config.setRoundStatus(round.id, "active", 1);
    const closed = await closeStaleRound(config, roomId);
    assert.equal(closed?.id, round.id);
    assert.equal(closed?.status, "stopped");
    const latest = await config.latestRound(roomId);
    assert.equal(latest?.round.status, "stopped");
    assert.equal(latest?.round.seatCursor, 1, "saved progress stays");
    assert.equal(
      await closeStaleRound(config, roomId),
      null,
      "second reopen is a no-op; the round never auto-resumes",
    );
    // A fresh round still opens cleanly after the guard.
    const fresh = await config.beginRound(
      roomId,
      saved.conversationId,
      {
        trigger: "pass",
        frozenOrder: [0, 1],
        settings: defaultGroupRoomSettings(),
      },
      createId,
    );
    assert.equal(fresh.status, "active");
    assert.notEqual(fresh.id, round.id);
  } finally {
    database.close();
  }
});

test("reopen leaves completed or stopped rounds untouched", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const config = new SQLiteGroupConfigStore(sqlite(database));
    await SQLiteGroupConfigStore.initialize(sqlite(database));
    let nextId = 9100;
    const createId = () => gid(nextId++);
    const seats: GroupParticipantDraft[] = [
      { ...emptyGroupParticipant(), personaId: gid(5011), displayName: "Ada" },
    ];
    const roomId = await config.saveRoom(
      {
        id: null,
        name: "Calm room",
        scenario: "",
        userDisplayName: "Sam",
        conversationId: gid(6011),
        settings: defaultGroupRoomSettings(),
        participants: seats,
      },
      createId,
    );
    assert.equal(await closeStaleRound(config, roomId), null, "no rounds yet");
    const round = await config.beginRound(
      roomId,
      gid(6011),
      {
        trigger: "send",
        frozenOrder: [0],
        settings: defaultGroupRoomSettings(),
      },
      createId,
    );
    await config.setRoundStatus(round.id, "completed", 1);
    assert.equal(await closeStaleRound(config, roomId), null);
    assert.equal((await config.latestRound(roomId))?.round.status, "completed");
  } finally {
    database.close();
  }
});
