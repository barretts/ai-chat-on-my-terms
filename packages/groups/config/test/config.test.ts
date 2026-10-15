import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  SQLiteGroupConfigStore,
  emptyGroupParticipant,
  validateGroupRoom,
  type GroupParticipantDraft,
  type GroupRoomDraft,
} from "../src/index.js";

const id = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

function adapter(database: DatabaseSync): SQLiteDatabasePort {
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
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  };
}

let nextId = 1000;
const createId = () => id(nextId++);

function room(participants: GroupParticipantDraft[]): GroupRoomDraft {
  return {
    id: null,
    name: "War room",
    scenario: "Ship-day standup",
    userDisplayName: "Barrett",
    conversationId: id(4001),
    participants,
  };
}

async function store(): Promise<{
  database: DatabaseSync;
  config: SQLiteGroupConfigStore;
}> {
  const database = new DatabaseSync(":memory:");
  const config = new SQLiteGroupConfigStore(adapter(database));
  await SQLiteGroupConfigStore.initialize(adapter(database));
  return { database, config };
}

test("removed bindings produce participant-level actionable errors", async () => {
  const personaSeat = {
    ...emptyGroupParticipant(),
    personaId: id(3001),
    displayName: "Ada",
  };
  const deadSeat = {
    ...emptyGroupParticipant(),
    providerConnectionId: id(3002),
    displayName: "Sentry",
  };
  const errors = await validateGroupRoom(room([personaSeat, deadSeat]), {
    findPersona: async () => undefined,
    findConnection: async () => undefined,
  });
  assert.equal(errors.length, 2);
  assert.deepEqual(
    errors.map((error) => error.participantIndex).sort(),
    [0, 1],
  );
  assert.match(errors[0]!.message, /Persona was deleted/);
  assert.match(errors[1]!.message, /removed from Connections/);
  assert.match(errors[1]!.message, /no other model is substituted/);
});

test("mixed providers and one model hosting two distinct roles pass", async () => {
  const shared = id(3010);
  const seats: GroupParticipantDraft[] = [
    {
      ...emptyGroupParticipant(),
      personaId: id(3011),
      displayName: "Critic",
    },
    {
      ...emptyGroupParticipant(),
      providerConnectionId: shared,
      modelId: "llama-3.3-70b",
      displayName: "Writer",
      systemPrompt: "You draft answers.",
    },
    {
      ...emptyGroupParticipant(),
      providerConnectionId: shared,
      modelId: "llama-3.3-70b",
      displayName: "Editor",
      systemPrompt: "You tighten answers.",
    },
  ];
  const errors = await validateGroupRoom(room(seats), {
    findPersona: async (personaId) =>
      personaId === id(3011) ? { id: personaId } : undefined,
    findConnection: async (connectionId) =>
      connectionId === shared
        ? { id: connectionId, modelId: "llama-3.3-70b" }
        : undefined,
  });
  assert.deepEqual(errors, []);
});

test("room level problems and half-bound seats are refused before launch", async () => {
  const halfSeat = {
    ...emptyGroupParticipant(),
    providerConnectionId: id(3020),
    modelId: null,
    displayName: "Lost",
  };
  const bothSeat = {
    ...emptyGroupParticipant(),
    personaId: id(3021),
    providerConnectionId: id(3022),
    displayName: "Greedy",
  };
  const errors = await validateGroupRoom(
    { ...room([halfSeat, bothSeat]), userDisplayName: "  " },
    {
      findPersona: async (personaId) =>
        personaId === id(3021) ? { id: personaId } : undefined,
      findConnection: async (connectionId) =>
        connectionId === id(3020) || connectionId === id(3022)
          ? { id: connectionId, modelId: "model-discovery" }
          : undefined,
    },
  );
  assert.match(
    errors.find((error) => error.participantIndex === null)!.message,
    /display name/,
  );
  assert.match(
    errors.find((error) => error.participantIndex === 0)!.message,
    /choose a model in Connections/,
  );
  assert.match(
    errors.find((error) => error.participantIndex === 1)!.message,
    /not both/,
  );
});

test("saved rooms reopen intact with turn order and opaque voice", async () => {
  const { database, config } = await store();
  const seats: GroupParticipantDraft[] = [
    {
      ...emptyGroupParticipant(),
      personaId: id(3031),
      displayName: "Ada",
      accentColor: "#123456",
      systemPrompt: "Ship it.",
      toolsEnabled: true,
    },
    {
      ...emptyGroupParticipant(),
      providerConnectionId: id(3032),
      modelId: "qwen-32b",
      displayName: "Qwen",
      voice: { speechVoiceId: "fable", speechRate: 1.1 },
    },
  ];
  const roomId = await config.saveRoom(room(seats), createId);
  const reopened = await config.loadRoom(roomId);
  assert.ok(reopened);
  assert.equal(reopened.name, "War room");
  assert.equal(reopened.scenario, "Ship-day standup");
  assert.equal(reopened.userDisplayName, "Barrett");
  assert.equal(reopened.participants.length, 2);
  assert.deepEqual(reopened.participants[0], {
    ...seats[0],
  });
  assert.deepEqual(reopened.participants[1], {
    ...seats[1],
  });
  const rooms = await config.listRooms();
  assert.deepEqual(rooms, [{ id: roomId, name: "War room" }]);
  // Re-saving the same room replaces seats without duplicating them.
  await config.saveRoom(
    { ...room(seats), id: roomId, name: "War room II" },
    createId,
  );
  const again = await config.loadRoom(roomId);
  assert.equal(again!.name, "War room II");
  assert.equal(again!.participants.length, 2);
  database.close();
});

/**
 * Mirrors apps/mobile/platform/database.ts (sharedMobileDatabase): every
 * operation on the shared native connection runs through one FIFO queue,
 * withTransactionAsync holds the queue for the whole transaction and hands
 * the callback a transaction-scoped port. Writing through the OUTER adapter
 * inside the callback would queue behind the open transaction forever.
 */
function sharedConnectionQueue(base: SQLiteDatabasePort): SQLiteDatabasePort {
  let operations: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = operations.then(work);
    operations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    execAsync: (sql) => enqueue(() => base.execAsync(sql)),
    runAsync: (sql, ...params) => enqueue(() => base.runAsync(sql, ...params)),
    getFirstAsync: <T>(sql: string, ...params: SqliteBindValue[]) =>
      enqueue(() => base.getFirstAsync<T>(sql, ...params)),
    getAllAsync: <T>(sql: string, ...params: SqliteBindValue[]) =>
      enqueue(() => base.getAllAsync<T>(sql, ...params)),
    withTransactionAsync: (work) =>
      enqueue(async () => {
        await base.execAsync("BEGIN IMMEDIATE");
        try {
          await work({
            execAsync: (sql) => base.execAsync(sql),
            runAsync: (sql, ...params) => base.runAsync(sql, ...params),
            getFirstAsync: <T>(sql: string, ...params: SqliteBindValue[]) =>
              base.getFirstAsync<T>(sql, ...params),
            getAllAsync: <T>(sql: string, ...params: SqliteBindValue[]) =>
              base.getAllAsync<T>(sql, ...params),
            withTransactionAsync: async () => {
              throw new Error("Nested SQLite transactions are not supported");
            },
          });
          await base.execAsync("COMMIT");
        } catch (error) {
          await base.execAsync("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }),
  };
}

function within<T>(label: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} deadlocked behind the transaction`)),
        1000,
      ).unref();
    }),
  ]);
}

test("saveRoom resolves on a shared connection that queues every operation", async () => {
  const database = new DatabaseSync(":memory:");
  const queued = sharedConnectionQueue(adapter(database));
  await SQLiteGroupConfigStore.initialize(queued);
  const config = new SQLiteGroupConfigStore(queued);
  const seats: GroupParticipantDraft[] = [
    { ...emptyGroupParticipant(), personaId: id(4101), displayName: "Alpha" },
    { ...emptyGroupParticipant(), modelId: "gpt-test", displayName: "Beta" },
  ];
  const roomId = await within(
    "saveRoom",
    config.saveRoom(room(seats), createId),
  );
  const reopened = await within("loadRoom", config.loadRoom(roomId));
  assert.equal(reopened?.participants.length, 2);
  database.close();
});
