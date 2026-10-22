import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { startServer } from "../../../../tools/fake-model-server.mjs";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import {
  DEV_GROUP_LAB_MODEL_ID,
  DEV_GROUP_LAB_MODEL_RECORD_ID,
  DEV_GROUP_LAB_PROVIDER_ID,
  createDevGroupLabPort,
  devGroupLabBaseUrl,
  devGroupLabChoice,
  ensureDevGroupLabModel,
} from "./dev-group-lab";
import {
  resolveSharedRoomBinding,
  type RoomModelBinding,
} from "./group-runtime";

test("dev lab enables only with __DEV__ and an exact origin or /v1 base", () => {
  assert.equal(devGroupLabBaseUrl(undefined, false), null);
  assert.equal(devGroupLabBaseUrl("", true), null);
  assert.equal(devGroupLabBaseUrl("   ", true), null);
  assert.equal(devGroupLabBaseUrl("not-a-url", true), null);
  assert.equal(devGroupLabBaseUrl("ftp://127.0.0.1:8899", true), null);
  assert.equal(devGroupLabBaseUrl("http://u:p@127.0.0.1:8899", true), null);
  assert.equal(devGroupLabBaseUrl("http://127.0.0.1:8899/chat", true), null);
  assert.equal(
    devGroupLabBaseUrl("http://127.0.0.1:8899/v1", true),
    "http://127.0.0.1:8899",
  );
  assert.equal(
    devGroupLabBaseUrl("http://127.0.0.1:8899/", true),
    "http://127.0.0.1:8899",
  );
  assert.equal(
    devGroupLabBaseUrl("https://lab.example.test", true),
    "https://lab.example.test",
  );
  assert.equal(
    devGroupLabChoice("http://127.0.0.1:8899").value,
    "dev:group-lab",
  );
});

test("harness model row is idempotent and resolves as a shared binding", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, UNIQUE (name)
    );
    CREATE TABLE models (
      id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
      name TEXT NOT NULL, runtime TEXT NOT NULL, format TEXT NOT NULL,
      capabilities_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (provider_id, name)
    );
  `);
  const db = sqlite(database);
  const recordId = await ensureDevGroupLabModel(db);
  assert.equal(recordId, DEV_GROUP_LAB_MODEL_RECORD_ID);
  assert.equal(await ensureDevGroupLabModel(db), recordId);
  assert.equal(
    (
      database.prepare("SELECT COUNT(*) AS n FROM models").get() as {
        n: number;
      }
    ).n,
    1,
  );
  assert.equal(
    (
      database
        .prepare("SELECT kind FROM providers WHERE id=?")
        .get(DEV_GROUP_LAB_PROVIDER_ID) as { kind: string }
    ).kind,
    "dev-group-lab",
  );

  // The route resolution contract: the stored picker id finds exactly the
  // harness binding; a null or GGUF-id room NEVER picks it by accident.
  const bindings: RoomModelBinding[] = [
    {
      providerConnectionId: DEV_GROUP_LAB_PROVIDER_ID,
      modelRecordId: recordId,
      modelId: DEV_GROUP_LAB_MODEL_ID,
    },
  ];
  assert.deepEqual(
    resolveSharedRoomBinding("dev:group-lab", bindings),
    bindings[0],
  );
  assert.equal(resolveSharedRoomBinding("blob:other", bindings), null);
});

test("harness port streams a real seat run through the product adapter", async () => {
  const server = await startServer(0);
  try {
    const port = createDevGroupLabPort(`http://127.0.0.1:${server.port}`);
    const events: { type: string; text?: string }[] = [];
    const run = port.startRun(
      {
        runId: "0195c000-0000-7000-8000-000000000001",
        conversationId: "0195c000-0000-7000-8000-000000000002",
        messageId: "0195c000-0000-7000-8000-000000000003",
        providerConnectionId: DEV_GROUP_LAB_PROVIDER_ID,
        modelId: DEV_GROUP_LAB_MODEL_ID,
        context: [
          { kind: "system", value: 'Your name in this room is "Aldric Vane"' },
          { kind: "user", value: "anyone about?" },
        ],
        parameters: {},
        permittedTools: [],
        attachmentRefs: [],
        reasoning: false,
        json: false,
      },
      new AbortController().signal,
    );
    for await (const event of run)
      events.push(event as { type: string; text?: string });
    const types = events.map((event) => event.type);
    assert.ok(types.includes("TextDelta"), `no deltas in ${types.join(",")}`);
    assert.equal(events.at(-1)?.type, "RunCompleted");
    const text = events
      .filter((event) => event.type === "TextDelta")
      .map((event) => event.text ?? "")
      .join("");
    // The fake server parrots the seat name ON PURPOSE so the strip path
    // has something to remove; the port must deliver it verbatim.
    assert.match(text, /^Aldric Vane: Fake beat \d+ for Aldric Vane\.$/);
  } finally {
    await server.close();
  }
});

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
