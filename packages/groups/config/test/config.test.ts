import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  SQLiteGroupConfigStore,
  defaultGroupRoomSettings,
  emptyGroupParticipant,
  validateGroupRoom,
  type GroupParticipantDraft,
  type GroupRoomDraft,
  type GroupRoomSettings,
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

function room(
  participants: GroupParticipantDraft[],
  settings: GroupRoomSettings = defaultGroupRoomSettings(),
): GroupRoomDraft {
  return {
    id: null,
    name: "War room",
    scenario: "Ship-day standup",
    userDisplayName: "Barrett",
    conversationId: id(4001),
    settings,
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
  // Freshly saved seats carry generated IDs; the rest round-trips intact.
  for (const [index, seat] of reopened.participants.entries()) {
    assert.match(seat.id ?? "", /^0195c000-0000-7000-8000-\d{12}$/);
    assert.deepEqual(seat, {
      ...seats[index],
      id: seat.id,
      voice: seats[index].voice ? { ...seats[index].voice } : null,
    });
  }
  const rooms = await config.listRooms();
  assert.deepEqual(rooms, [{ id: roomId, name: "War room" }]);
  // Re-saving with the reopened draft keeps seat IDs stable and updates the
  // room name in place; no seat rows are duplicated.
  await config.saveRoom({ ...reopened, name: "War room II" }, createId);
  const again = await config.loadRoom(roomId);
  assert.equal(again!.name, "War room II");
  assert.equal(again!.participants.length, 2);
  assert.deepEqual(
    again!.participants.map((seat) => seat.id),
    reopened.participants.map((seat) => seat.id),
  );
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

test("room settings, Drunk flags and seat IDs round-trip across re-saves", async () => {
  const { database, config } = await store();
  const seats: GroupParticipantDraft[] = [
    { ...emptyGroupParticipant(), personaId: id(5001), displayName: "Ada" },
    { ...emptyGroupParticipant(), personaId: id(5002), displayName: "Grace" },
  ];
  const roomId = await config.saveRoom(room(seats), createId);
  const saved = await config.loadRoom(roomId);
  assert.ok(saved);
  const updated: GroupRoomDraft = {
    ...saved,
    settings: {
      conversationMode: "independent",
      speakerOrder: "dice",
      replyDisplay: "live",
      sharedModelId: "qwen/qwen3.5-2b-q4_k_m",
      responseLimitTokens: 512,
    },
    participants: saved.participants.map((seat, index) => ({
      ...seat,
      drunk: index === 1,
    })),
  };
  await config.saveRoom(updated, createId);
  const again = await config.loadRoom(roomId);
  assert.ok(again);
  assert.deepEqual(again.settings, updated.settings);
  assert.deepEqual(again.participants, [...updated.participants]);
  assert.deepEqual(
    again.participants.map((seat) => seat.id),
    saved.participants.map((seat) => seat.id),
  );
  database.close();
});

test("removing a seat deletes it and its Drunk preference", async () => {
  const { database, config } = await store();
  const seats: GroupParticipantDraft[] = [
    { ...emptyGroupParticipant(), personaId: id(5011), displayName: "Ada" },
    { ...emptyGroupParticipant(), personaId: id(5012), displayName: "Mid" },
    { ...emptyGroupParticipant(), personaId: id(5013), displayName: "Alan" },
  ];
  const roomId = await config.saveRoom(
    { ...room(seats), settings: defaultGroupRoomSettings() },
    createId,
  );
  const saved = await config.loadRoom(roomId);
  assert.ok(saved);
  await config.saveRoom(
    {
      ...saved,
      participants: saved.participants
        .filter((seat) => seat.displayName !== "Mid")
        .map((seat) => ({ ...seat, drunk: true })),
    },
    createId,
  );
  const again = await config.loadRoom(roomId);
  assert.ok(again);
  assert.deepEqual(
    again.participants.map((seat) => [seat.displayName, seat.drunk]),
    [
      ["Ada", true],
      ["Alan", true],
    ],
  );
  const previousIds = new Map(
    saved.participants.map((seat) => [seat.displayName, seat.id]),
  );
  assert.deepEqual(
    again.participants.map((seat) => seat.id),
    again.participants.map((seat) => previousIds.get(seat.displayName)),
  );
  const leftovers = database
    .prepare(
      "SELECT COUNT(*) AS n FROM group_participants WHERE group_room_id=?",
    )
    .get(roomId) as { n: number };
  assert.equal(leftovers.n, 2);
  const prefs = database
    .prepare("SELECT COUNT(*) AS n FROM group_participant_prefs")
    .get() as { n: number };
  assert.equal(prefs.n, 2);
  database.close();
});

test("out-of-range stored response limits load as the default and fail validation", async () => {
  const { database, config } = await store();
  const seats: GroupParticipantDraft[] = [
    { ...emptyGroupParticipant(), personaId: id(5101), displayName: "Ada" },
  ];
  const roomId = await config.saveRoom(room(seats), createId);
  database
    .prepare(
      "UPDATE group_room_settings SET response_limit_tokens=99999 WHERE room_id=?",
    )
    .run(roomId);
  const loaded = await config.loadRoom(roomId);
  assert.ok(loaded);
  assert.equal(loaded.settings.responseLimitTokens, 256);
  const errors = await validateGroupRoom(
    {
      ...loaded,
      settings: { ...loaded.settings, responseLimitTokens: 99999 },
    },
    {
      findConnection: async () => undefined,
      findPersona: async () => ({ id: id(5101) }),
    },
  );
  assert.ok(
    errors.some(
      (error) =>
        error.participantIndex === null && /Response limit/.test(error.message),
    ),
    JSON.stringify(errors),
  );
  database.close();
});

test("rounds and speaker runs persist trigger, frozen order and status", async () => {
  const { database, config } = await store();
  const seats: GroupParticipantDraft[] = [
    { ...emptyGroupParticipant(), personaId: id(5201), displayName: "Ada" },
    { ...emptyGroupParticipant(), personaId: id(5202), displayName: "Grace" },
  ];
  const roomId = await config.saveRoom(room(seats), createId);
  const saved = await config.loadRoom(roomId);
  assert.ok(saved);
  const round = await config.beginRound(
    roomId,
    saved.conversationId,
    {
      trigger: "ask",
      frozenOrder: [2, 0, 1],
      settings: { ...defaultGroupRoomSettings(), speakerOrder: "dice" },
    },
    createId,
  );
  const finished = await config.beginSpeakerRun(
    round.id,
    2,
    saved.participants[1].id,
    "qwen/qwen3.5-2b-q4_k_m",
    createId,
  );
  await config.finishSpeakerRun(finished, "completed");
  await config.beginSpeakerRun(
    round.id,
    0,
    saved.participants[0].id,
    null,
    createId,
  );
  await config.setRoundStatus(round.id, "stopped", 2);
  const resumed = await config.latestRound(roomId);
  assert.ok(resumed);
  assert.equal(resumed.round.id, round.id);
  assert.equal(resumed.round.roomId, roomId);
  assert.equal(resumed.round.conversationId, saved.conversationId);
  assert.equal(resumed.round.trigger, "ask");
  assert.deepEqual(resumed.round.frozenOrder, [2, 0, 1]);
  assert.equal(resumed.round.settings.speakerOrder, "dice");
  assert.equal(resumed.round.status, "stopped");
  assert.equal(resumed.round.seatCursor, 2);
  assert.deepEqual(
    resumed.runs.map((run) => [run.seatIndex, run.status]),
    [
      [0, "running"],
      [2, "completed"],
    ],
  );
  assert.deepEqual(
    resumed.runs.map((run) => run.participantId),
    [saved.participants[0].id, saved.participants[1].id],
  );
  database.close();
});

test("a saved room is a chat: conversation row, marker and lookup", async () => {
  const { database, config } = await store();
  // The mapping has a real foreign key to core conversations; the store
  // never runs on a database without the migrated core schema.
  database.exec(
    "CREATE TABLE conversations(id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL DEFAULT '')",
  );
  const roomId = await config.saveRoom(
    room([
      { ...emptyGroupParticipant(), personaId: id(5301), displayName: "Ada" },
    ]),
    createId,
  );
  const titleOf = (): string | undefined =>
    (
      database
        .prepare("SELECT title FROM conversations WHERE id=?")
        .get(id(4001)) as { title: string } | undefined
    )?.title;
  assert.equal(titleOf(), "War room");
  // Backfilling an already-marked conversation stays idempotent.
  await config.markGroupConversation(id(4001), roomId);
  const rows = database
    .prepare(
      "SELECT conversation_id, group_room_id FROM group_room_conversations",
    )
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { conversation_id: id(4001), group_room_id: roomId },
  ]);
  assert.deepEqual(await config.roomForConversation(id(4001)), {
    id: roomId,
    name: "War room",
  });
  assert.equal(await config.roomForConversation(id(6001)), null);
  // Renaming the room renames the chat row the history list shows.
  const saved = await config.loadRoom(roomId);
  assert.ok(saved);
  await config.saveRoom({ ...saved, name: "War room two" }, createId);
  assert.equal(titleOf(), "War room two");
  database.close();
});
