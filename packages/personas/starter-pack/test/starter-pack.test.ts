import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  migrateSQLite,
  type SQLiteMigrationAdapter,
} from "@locallab/schema/migrations";
import { SQLitePersonaLibrary } from "@locallab/personas-library";
import {
  STARTER_TROPES,
  TROPE_PACK_SEED_KEY,
  loadTropePack,
  seedTropePack,
  type TropeSeedOptions,
} from "../src/index.js";

const id = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const deviceId = id(900);
const fixedNow = () => new Date("2026-09-26T12:00:00.000Z");
const tropeId = (key: string) =>
  STARTER_TROPES.find((trope) => trope.key === key)!.id;

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

function migrationAdapter(database: DatabaseSync): SQLiteMigrationAdapter {
  return {
    exec: async (sql) => database.exec(sql),
    all: async <T extends Record<string, unknown>>(sql: string) =>
      database.prepare(sql).all() as T[],
    transaction: async <T>(work: () => Promise<T>) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = await work();
        database.exec("COMMIT");
        return result;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    readMigrationSource: (source) => readFile(source, "utf8"),
  };
}

async function open() {
  const database = new DatabaseSync(":memory:");
  await migrateSQLite(migrationAdapter(database));
  return database;
}

function libraryOf(database: DatabaseSync, start = 1000) {
  let sequence = start;
  return new SQLitePersonaLibrary(adapter(database), {
    createId: () => id(sequence++),
    deviceId,
    now: fixedNow,
  });
}

test("pack data invariants: 14 unique original tropes with prompts", () => {
  assert.equal(STARTER_TROPES.length, 14);
  assert.equal(new Set(STARTER_TROPES.map((t) => t.key)).size, 14);
  assert.equal(new Set(STARTER_TROPES.map((t) => t.id)).size, 14);
  for (const trope of STARTER_TROPES) {
    assert.match(trope.id, /^0195c000-0000-7000-8000-[0-9a-f]{12}$/);
    assert.ok(trope.name.length >= 2 && trope.name.length <= 64);
    assert.ok(
      trope.description.length > 0 && trope.description.length <= 500,
      trope.key,
    );
    assert.ok(
      trope.prompt.length >= 20 && trope.prompt.length <= 4000,
      trope.key,
    );
    assert.match(
      trope.prompt,
      /stay in your own voice; never repeat another participant's phrasing\.$/,
      `${trope.key} carries the anti-parroting line`,
    );
    assert.match(trope.accentColor, /^#[0-9A-F]{6}$/);
    assert.match(trope.backgroundColor, /^#[0-9A-F]{6}$/);
  }
});

test("installs all 14 once; second seed inserts nothing; marker set", async () => {
  const database = await open();
  const library = libraryOf(database);
  await library.initialize();
  const first = await seedTropePack({ library, db: adapter(database) });
  assert.equal(first.inserted.length, 14);
  assert.deepEqual(first.restored, []);
  const records = await library.list();
  for (const trope of STARTER_TROPES) {
    const record = records.find((item) => item.id === trope.id);
    assert.equal(record?.name, trope.name, trope.key);
    assert.equal(record?.prompt, trope.prompt, trope.key);
    assert.equal(
      record?.appearance.accentColor,
      trope.accentColor,
      `${trope.key} accent`,
    );
  }
  const second = await seedTropePack({ library, db: adapter(database) });
  assert.deepEqual(second, { inserted: [], restored: [] });
  assert.equal(
    (await library.list()).filter((record) =>
      STARTER_TROPES.some((trope) => trope.id === record.id),
    ).length,
    14,
    "no duplicates",
  );
});

test("a deleted trope stays deleted across restarts; explicit reload resurrects it", async () => {
  const database = await open();
  const library = libraryOf(database);
  await library.initialize();
  await seedTropePack({ library, db: adapter(database) });
  const sunny = tropeId("sunbeam");
  await library.delete(sunny);
  // "Restart": fresh library instance over the same device data, boot seed again.
  const rebooted = libraryOf(database, 2000);
  await rebooted.initialize();
  const reseeding = await seedTropePack({
    library: rebooted,
    db: adapter(database),
  });
  assert.deepEqual(reseeding, { inserted: [], restored: [] });
  assert.equal(await rebooted.get(sunny), null, "tombstone honored");
  // Explicit owner action resurrects and clears the tombstone cleanly.
  const reload = await loadTropePack({
    library: rebooted,
    db: adapter(database),
  });
  assert.deepEqual(reload.inserted, ["sunbeam"]);
  assert.deepEqual(reload.restored, ["sunbeam"]);
  const restored = await rebooted.get(sunny);
  assert.equal(restored?.name, "Sunny Marlowe");
  const tombstoned = await database
    .prepare("SELECT entity_id FROM persona_tombstones WHERE entity_id=?")
    .get(sunny);
  assert.equal(tombstoned, undefined, "tombstone cleared by explicit reload");
});

test("explicit reload re-inserts missing rows and never touches user edits", async () => {
  const database = await open();
  const library = libraryOf(database);
  await library.initialize();
  await seedTropePack({ library, db: adapter(database) });
  const vane = tropeId("gruff-mentor");
  await library.update(vane, { name: "Aldric Vane (edited)" });
  // Simulate a lost row without a tombstone (e.g. DB restored from an old backup).
  await database.prepare("DELETE FROM personas WHERE id=?").run(vane);
  const reload = await loadTropePack({ library, db: adapter(database) });
  assert.deepEqual(reload.inserted, ["gruff-mentor"]);
  assert.deepEqual(reload.restored, []);
  const records = await library.list();
  assert.equal(
    records.filter((record) =>
      STARTER_TROPES.some((trope) => trope.id === record.id),
    ).length,
    14,
  );
  assert.equal(
    records.find((record) => record.id === vane)?.name,
    "Aldric Vane",
    "re-inserted from the shipped record",
  );
});

test("avatar dep attaches ids; failure keeps persona photo-less; one insert failure does not abort the pack", async () => {
  const database = await open();
  const library = libraryOf(database);
  await library.initialize();
  const logs: string[] = [];
  const result = await seedTropePack({
    library,
    db: adapter(database),
    log: (message) => logs.push(message),
    attachAvatar: async (trope) => {
      if (trope.key === "oracle") throw new Error("asset missing");
      return tropeId(trope.key);
    },
  });
  assert.equal(result.inserted.length, 14);
  const records = await library.list();
  const photoOf = (key: string) =>
    records.find((record) => record.id === tropeId(key))?.photoAttachmentId;
  assert.equal(photoOf("tsundere"), tropeId("tsundere"), "avatar attached");
  assert.equal(
    photoOf("oracle"),
    null,
    "failed attach keeps persona photo-less",
  );
  assert.ok(logs.some((line) => line.includes("oracle")));
  // Pack resilience: one insert blowing up (non-conflict) must not stop the rest.
  const database2 = await open();
  const library2 = libraryOf(database2, 3000);
  await library2.initialize();
  const wrapped = {
    create: (input: Parameters<(typeof library2)["create"]>[0]) => {
      if (input.id === tropeId("genki")) throw new Error("disk on fire");
      return library2.create(input);
    },
    update: (
      idValue: string,
      input: Parameters<(typeof library2)["update"]>[1],
    ) => library2.update(idValue, input),
  };
  const logs2: string[] = [];
  const result2 = await seedTropePack({
    library: wrapped,
    db: adapter(database2),
    log: (message) => logs2.push(message),
  });
  assert.equal(result2.inserted.length, 13);
  assert.ok(logs2.some((line) => line.includes("genki")));
  assert.equal((await library2.list()).length, 2 + 13, "default+assistant+13");
});

test("fixed ids stay stable across reload and the seed marker records installation", async () => {
  const database = await open();
  const library = libraryOf(database);
  await library.initialize();
  await seedTropePack({ library, db: adapter(database) });
  const before = (await library.list())
    .filter((record) => STARTER_TROPES.some((trope) => trope.id === record.id))
    .map((record) => record.id)
    .sort();
  assert.deepEqual(
    before,
    [...STARTER_TROPES.map((trope) => trope.id)].sort(),
    "exactly the shipped fixed ids",
  );
  const marker = database
    .prepare("SELECT value FROM persona_library_state WHERE key=?")
    .get(TROPE_PACK_SEED_KEY);
  assert.equal((marker as { value: string }).value, "installed");
});

test("explicit reload backfills missing avatars; existing photos and edits win", async () => {
  const database = await open();
  const library = libraryOf(database);
  await library.initialize();
  const photoOf = (
    records: Awaited<ReturnType<typeof library.list>>,
    key: string,
  ) => records.find((record) => record.id === tropeId(key))!.photoAttachmentId;
  // Seed with a failing avatar import: personas exist but are photo-less.
  const seeded = await seedTropePack({
    library,
    db: adapter(database),
    attachAvatar: async () => null,
  });
  assert.equal(seeded.inserted.length, 14);
  assert.equal(photoOf(await library.list(), "sunbeam"), null);
  // Explicit reload repairs every photo-less trope.
  const backfilled: string[] = [];
  await loadTropePack({
    library,
    db: adapter(database),
    attachAvatar: async (trope) => {
      backfilled.push(trope.key);
      return tropeId(trope.key);
    },
  });
  assert.equal(backfilled.length, 14, "every photo-less trope backfilled");
  assert.equal(photoOf(await library.list(), "sunbeam"), tropeId("sunbeam"));
  // A second reload must not re-attach or overwrite user-chosen photos.
  let again = 0;
  await loadTropePack({
    library,
    db: adapter(database),
    attachAvatar: async () => {
      again += 1;
      return "replaced";
    },
  });
  assert.equal(again, 0, "personas with avatars are never re-attached");
  assert.equal(photoOf(await library.list(), "sunbeam"), tropeId("sunbeam"));
});
