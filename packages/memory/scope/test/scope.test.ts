import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { DEFAULT_PERSONA_ID } from "@locallab/personas-library";
import {
  SQLitePersonaMemoryScope,
  boundedFragments,
  readPersonaMemorySettings,
  scopedMemoryPolicy,
} from "../src/index.js";

const id = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const timestamp = "2026-09-26T12:00:00.000Z";

function port(database: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => database.exec(sql),
    runAsync: async (sql, ...values: SqliteBindValue[]) =>
      database.prepare(sql).run(...values),
    getFirstAsync: async <T>(sql: string, ...values: SqliteBindValue[]) =>
      (database.prepare(sql).get(...values) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...values: SqliteBindValue[]) =>
      database.prepare(sql).all(...values) as T[],
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

const MEMORY_DDL = `
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  source_conversation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
`;

type Scope = "global" | "persona";

function insertMemory(
  database: DatabaseSync,
  memoryId: string,
  content: string,
  scope: Scope,
  scopeId: string | null,
): void {
  const namespace = `memory:${scope}:${scopeId ?? "global"}`;
  const metadata = JSON.stringify({
    memoryVersion: 1,
    contentKey: content.toLowerCase(),
    revision: { wallMs: 1, counter: 1, deviceId: "dev-test" },
    scope,
    scopeId,
    provenance: null,
    source: null,
  });
  database
    .prepare(
      "INSERT INTO memory_items(id,namespace,content,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .run(memoryId, namespace, content, metadata, timestamp, timestamp);
}

type Fragment = Parameters<typeof boundedFragments>[0][0][0];

function entry(content: string, memoryId = id(0x500 + content.length)): Fragment {
  return {
    id: memoryId,
    content,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: { wallMs: 1, counter: 1, deviceId: "dev-test" },
    provenance: { sourceMessageId: null, method: "test" },
    scope: "global",
    scopeId: null,
  };
}

async function openScope(): Promise<{
  database: DatabaseSync;
  scopeStore: SQLitePersonaMemoryScope;
}> {
  const database = new DatabaseSync(":memory:");
  database.exec(MEMORY_DDL);
  const scopeStore = new SQLitePersonaMemoryScope(port(database));
  await scopeStore.initialize();
  return { database, scopeStore };
}

test("Persona profile toggles override global memory switches", () => {
  const policy = scopedMemoryPolicy(
    {
      personaId: id(2),
      profile: { memory: { extract: false, inject: true, share: true } },
    },
    { extractionEnabled: true, injectionEnabled: false },
  );
  assert.equal(policy.extract, false);
  assert.equal(policy.inject, true);
  assert.deepEqual(policy.scope, { scope: "persona", scopeId: id(2) });
  const fallback = scopedMemoryPolicy(
    { personaId: id(2), profile: {} },
    { extractionEnabled: true, injectionEnabled: false },
  );
  assert.equal(fallback.extract, true);
  assert.equal(fallback.inject, false);
  const junk = scopedMemoryPolicy(
    { personaId: id(2), profile: { memory: { extract: "yes" } } },
    { extractionEnabled: false, injectionEnabled: true },
  );
  assert.equal(junk.extract, false);
  const defaults = scopedMemoryPolicy(
    { personaId: DEFAULT_PERSONA_ID },
    { extractionEnabled: true, injectionEnabled: true },
  );
  assert.deepEqual(defaults.scope, { scope: "global", scopeId: null });
  assert.equal(defaults.includeGlobal, true);
});

test("profile settings reader tolerates junk", () => {
  assert.deepEqual(readPersonaMemorySettings(undefined), {});
  assert.deepEqual(readPersonaMemorySettings({ memory: 7 }), {});
  assert.deepEqual(readPersonaMemorySettings({ memory: { share: true } }), {
    share: true,
  });
});

test("private Persona facts cannot enter other prompts via association", async () => {
  const { database, scopeStore } = await openScope();
  const personaA = id(10);
  const personaB = id(11);
  const privateFact = id(20);
  insertMemory(database, privateFact, "Mira keeps a tide log.", "persona", personaA);
  await assert.rejects(
    scopeStore.associate(privateFact, personaB),
    /Private Persona fact/,
  );
  await scopeStore.setPolicy(personaA, { share: true });
  await scopeStore.associate(privateFact, personaB);
  assert.deepEqual(await scopeStore.associatedMemoryIds(personaB), [
    privateFact,
  ]);
  assert.deepEqual(await scopeStore.sharingPersonaIds(personaB), [personaA]);
  // A global fact may be associated with any Persona without a switch.
  const globalFact = id(21);
  insertMemory(database, globalFact, "The user sails on Sundays.", "global", null);
  await scopeStore.associate(globalFact, personaB);
  assert.deepEqual(await scopeStore.associatedMemoryIds(personaB), [
    privateFact,
    globalFact,
  ]);
});

test("unsharing a Persona stops exposing its facts to other prompts", async () => {
  const { scopeStore } = await openScope();
  const personaA = id(10);
  await scopeStore.setPolicy(personaA, { share: true });
  assert.deepEqual(await scopeStore.sharingPersonaIds(id(99)), [personaA]);
  await scopeStore.setPolicy(personaA, { share: false });
  assert.deepEqual(await scopeStore.sharingPersonaIds(id(99)), []);
  const policy = await scopeStore.policy(personaA);
  assert.equal(policy?.share, false);
  assert.equal(policy?.extract, null);
});

test("shared and owned fragments merge deduplicated within the budget", () => {
  const owned = [entry("Prefers loose-leaf tea.")];
  const shared = [
    entry("Prefers loose-leaf tea.  ", id(0x611)),
    entry("Sails every Sunday."),
    entry("A very long repeated habit note about harbor weather."),
  ];
  const merged = boundedFragments([owned, shared], 1_000);
  assert.deepEqual(
    merged.map((fragment) => fragment.id),
    [owned[0]!.id, shared[1]!.id, shared[2]!.id],
  );
  const bounded = boundedFragments([owned, shared], 30);
  assert.deepEqual(
    bounded.map((fragment) => fragment.content),
    ["Prefers loose-leaf tea."],
  );
});

test("Persona switch keeps memory state; explicit reset clears it", async () => {
  const { database, scopeStore } = await openScope();
  const personaA = id(10);
  const personaB = id(11);
  const globalFact = id(21);
  insertMemory(database, globalFact, "The user sails on Sundays.", "global", null);
  await scopeStore.setPolicy(personaB, { extract: false, share: true });
  await scopeStore.associate(globalFact, personaB);
  // Switching the active Persona changes the policy owner but nothing else.
  const switched = scopedMemoryPolicy(
    { personaId: personaA, profile: {} },
    { extractionEnabled: true, injectionEnabled: true },
  );
  assert.deepEqual(switched.scope, { scope: "persona", scopeId: personaA });
  assert.deepEqual(await scopeStore.associatedMemoryIds(personaB), [globalFact]);
  assert.equal((await scopeStore.policy(personaB))?.extract, false);
  // Reset is the only operation that clears.
  await scopeStore.resetPersona(personaB);
  assert.deepEqual(await scopeStore.associatedMemoryIds(personaB), []);
  assert.equal(await scopeStore.policy(personaB), null);
  // The underlying fact itself stays (owned elsewhere / global).
  const rows = database
    .prepare("SELECT COUNT(*) AS total FROM memory_items")
    .get() as { total: number };
  assert.equal(rows.total, 1);
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

test("resetPersona resolves on a shared connection that queues every operation", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(MEMORY_DDL);
  const queued = sharedConnectionQueue(port(database));
  const scopeStore = new SQLitePersonaMemoryScope(queued);
  await scopeStore.initialize();
  await scopeStore.setPolicy(id(10), { extract: true, share: false });
  insertMemory(database, id(21), "The user sails on Sundays.", "global", null);
  await scopeStore.associate(id(21), id(10));
  await within("resetPersona", scopeStore.resetPersona(id(10)));
  // The queue is usable again and the reset took effect.
  assert.equal(await within("policy", scopeStore.policy(id(10))), null);
  database.close();
});
