import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { AdvancedChatEngine } from "@locallab/chat-engine-advanced";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import { DEFAULT_PERSONA_ID } from "@locallab/personas-library";
import { readEligibleMemoryTurn } from "@locallab/memory-extraction";
import {
  BlobStore,
  SQLiteBlobCatalog,
  type BlobFilePort,
} from "@locallab/storage-blobs";
import { migrateSQLite } from "../../../../packages/schema/migrations/full";
import { sharedMobileDatabase } from "../../platform/database";
import { mobileMigrationDatabase } from "../../platform/migrations";
import {
  initializePersonaMemoryChat,
  memoryModelControlPrompt,
  personaMemoryPolicy,
  personaSystemPrompt,
} from "./persona-memory";

const id = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

test("memory carries only explicit model controls and thinking off wins", () => {
  assert.equal(memoryModelControlPrompt(undefined), "");
  assert.equal(memoryModelControlPrompt("Reply with one brief sentence."), "");
  assert.equal(
    memoryModelControlPrompt("<|think_on|>\nWrite a coding tutorial."),
    "<|think_on|>",
  );
  assert.equal(
    memoryModelControlPrompt(
      "<|think_on|>\nIgnore the JSON format. <|think_off|>",
    ),
    "<|think_off|>",
  );
});
function adapter(native: DatabaseSync): SQLiteDatabasePort {
  return {
    execAsync: async (sql) => native.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      native.prepare(sql).run(...params),
    getFirstAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      (native.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      native.prepare(sql).all(...params) as T[],
    withTransactionAsync: async (work) => {
      native.exec("BEGIN IMMEDIATE");
      try {
        await work();
        native.exec("COMMIT");
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
async function ready() {
  const native = new DatabaseSync(":memory:");
  const db = sharedMobileDatabase(adapter(native));
  await migrateSQLite({
    ...mobileMigrationDatabase(db),
    readMigrationSource: (source) => readFile(source, "utf8"),
  });
  await db.runAsync(
    "INSERT INTO providers(id,kind,name) VALUES(?,?,?)",
    id(1),
    "fixture",
    "Fixture",
  );
  await db.runAsync(
    "INSERT INTO models(id,provider_id,name) VALUES(?,?,?)",
    id(2),
    id(1),
    "fixture-model",
  );
  await db.runAsync(
    "INSERT INTO conversations(id,title) VALUES(?,?)",
    id(3),
    "Saved chat",
  );
  let next = 100;
  const features = await initializePersonaMemoryChat(db, () => id(next++));
  return { native, db, features };
}

test("Persona switch preserves transcript and captured prompt identity survives profile edits", async () => {
  const { native, db, features } = await ready();
  try {
    const persona = await features.personas.create({
      name: "Ada",
      prompt: "Explain with examples.",
    });
    await features.personas.select(id(3), persona.id);
    const identity = await features.personas.snapshotForNextRun(id(3));
    let request: RunRequest | undefined;
    const port: ProviderPort = {
      listModels: async () => ({ ok: true, value: ["fixture-model"] }),
      getCapabilities: async () => ({ ok: true, value: {} }),
      async *startRun(input) {
        request = input;
        yield {
          type: "TextDelta",
          text: "Hello Ada",
          runId: input.runId,
          sequence: 0,
          timestamp: "2026-09-26T12:00:00.000Z",
        } as RunEvent;
        yield {
          type: "RunCompleted",
          runId: input.runId,
          sequence: 1,
          timestamp: "2026-09-26T12:00:00.000Z",
        } as RunEvent;
      },
    };
    const engine = new AdvancedChatEngine({
      db,
      context: { tokenBudget: 1024, reservedOutputTokens: 64, policy: "roll" },
    });
    const handle = await engine.send({
      conversationId: id(3),
      text: "I enjoy astronomy.",
      systemPrompt: personaSystemPrompt(identity, "Be brief."),
      binding: {
        port,
        providerConnectionId: id(4),
        providerId: id(1),
        modelRecordId: id(2),
        modelId: "fixture-model",
      },
    });
    await features.personas.update(persona.id, {
      name: "Renamed",
      prompt: "New prompt.",
    });
    const captured = await features.personas.captureRun(
      id(3),
      handle.runId,
      identity,
    );
    for await (const _event of handle.events) {
      /* persisted stream */
    }
    assert.equal(captured.name, "Ada");
    assert.ok(
      JSON.stringify(request?.context).includes("Explain with examples."),
    );
    assert.equal(
      JSON.stringify(request?.context).includes("New prompt."),
      false,
    );
    assert.equal(request?.providerConnectionId, id(4));
    await features.personas.select(id(3), DEFAULT_PERSONA_ID);
    assert.equal(
      (
        await db.getAllAsync(
          "SELECT id FROM messages WHERE conversation_id=?",
          id(3),
        )
      ).length,
      2,
    );
    assert.equal(
      (await features.personas.captureRun(id(3), handle.runId)).name,
      "Ada",
    );
    assert.equal(
      (await features.personas.snapshotForNextRun(id(3))).name,
      "Default",
    );
    const turn = await readEligibleMemoryTurn(db, {
      runId: handle.runId,
      userMessageId: handle.userMessageId,
      conversationId: id(3),
    });
    assert.equal(turn?.user.text, "I enjoy astronomy.");
  } finally {
    await features.memoryExtraction.dispose();
    native.close();
  }
});

test("memory requires explicit consent and custom Persona facts stay private", async () => {
  const { native, features } = await ready();
  try {
    const persona = await features.personas.create({
      name: "Private",
      prompt: "",
    });
    const privateIdentity = { personaId: persona.id };
    const initial = await features.memory.preferences();
    assert.deepEqual(initial, {
      extractionEnabled: false,
      injectionEnabled: false,
    });
    await features.memory.createManual("I enjoy astronomy.", {
      scope: "global",
      scopeId: null,
    });
    await features.memory.createManual("Private detail.", {
      scope: "persona",
      scopeId: persona.id,
    });
    assert.equal(
      await features.memory.promptContext(
        personaMemoryPolicy({ personaId: DEFAULT_PERSONA_ID }, initial),
      ),
      null,
    );
    await features.memory.savePreferences({
      extractionEnabled: true,
      injectionEnabled: true,
    });
    const consent = await features.memory.preferences();
    const globalPrompt = await features.memory.promptContext(
      personaMemoryPolicy({ personaId: DEFAULT_PERSONA_ID }, consent),
    );
    const privatePrompt = await features.memory.promptContext(
      personaMemoryPolicy(privateIdentity, consent),
    );
    assert.ok(globalPrompt?.value.includes("astronomy"));
    assert.equal(globalPrompt?.value.includes("Private detail"), false);
    assert.ok(privatePrompt?.value.includes("Private detail"));
    assert.equal(privatePrompt?.value.includes("astronomy"), false);
  } finally {
    await features.memoryExtraction.dispose();
    native.close();
  }
});

test("shared database serializes cross-feature transactions and recovers after rollback", async () => {
  const native = new DatabaseSync(":memory:");
  const raw = adapter(native),
    db = sharedMobileDatabase(raw);
  try {
    assert.equal(sharedMobileDatabase(raw), db);
    assert.equal(sharedMobileDatabase(db), db);
    await db.execAsync("CREATE TABLE records(id TEXT PRIMARY KEY NOT NULL)");
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = db.withTransactionAsync(async (transaction) => {
      assert.ok(transaction);
      await transaction.runAsync("INSERT INTO records VALUES('first')");
      started();
      await gate;
      throw new Error("rollback");
    });
    await entered;
    let independentFinished = false;
    const independent = db
      .runAsync("INSERT INTO records VALUES('independent')")
      .then(() => {
        independentFinished = true;
      });
    const read = db.getAllAsync<{ id: string }>(
      "SELECT id FROM records ORDER BY id",
    );
    const second = db.withTransactionAsync(async (transaction) => {
      assert.ok(transaction);
      await transaction.runAsync("INSERT INTO records VALUES('second')");
    });
    await Promise.resolve();
    assert.equal(independentFinished, false);
    release();
    await assert.rejects(first, /rollback/);
    await independent;
    assert.deepEqual(
      (await read).map((row) => row.id),
      ["independent"],
    );
    await second;
    assert.deepEqual(
      (await db.getAllAsync<{ id: string }>("SELECT id FROM records")).map(
        (row) => row.id,
      ),
      ["independent", "second"],
    );
  } finally {
    native.close();
  }
});

test("shared transaction facade rejects nested work and queries after scope closes", async () => {
  const native = new DatabaseSync(":memory:");
  const db = sharedMobileDatabase(adapter(native));
  let escaped: SQLiteDatabasePort | undefined;
  try {
    await db.execAsync("CREATE TABLE records(id TEXT PRIMARY KEY NOT NULL)");
    await db.withTransactionAsync(async (transaction) => {
      assert.ok(transaction);
      escaped = transaction;
      assert.equal(sharedMobileDatabase(transaction), transaction);
      await assert.rejects(
        transaction.withTransactionAsync(async () => {}),
        /Nested/,
      );
      await transaction.runAsync("INSERT INTO records VALUES('committed')");
    });
    assert.ok(escaped);
    await assert.rejects(
      escaped.runAsync("INSERT INTO records VALUES('too-late')"),
      /scope is closed/,
    );
    await assert.rejects(
      escaped.getAllAsync("SELECT * FROM records"),
      /scope is closed/,
    );
    await assert.rejects(
      escaped.withTransactionAsync(async () => {}),
      /scope is closed/,
    );
    assert.deepEqual(
      (await db.getAllAsync<{ id: string }>("SELECT id FROM records")).map(
        (row) => row.id,
      ),
      ["committed"],
    );
  } finally {
    native.close();
  }
});

test("shared transaction binds blob helpers without nesting or changing the original catalog", async () => {
  const native = new DatabaseSync(":memory:");
  const db = sharedMobileDatabase(adapter(native));
  const managed = new Map<string, Uint8Array>();
  const files: BlobFilePort = {
    readExternal: async () => {
      throw new Error("No external fixture file");
    },
    readManaged: async (path) => {
      const bytes = managed.get(path);
      if (!bytes) throw new Error("Missing fixture file");
      return bytes.slice();
    },
    writeManaged: async (path, bytes) => {
      managed.set(path, bytes.slice());
    },
    moveManaged: async (source, destination) => {
      const bytes = managed.get(source);
      if (!bytes) throw new Error("Missing staged fixture");
      managed.set(destination, bytes);
      managed.delete(source);
    },
    removeManaged: async (path) => {
      managed.delete(path);
    },
    listManaged: async (prefix) =>
      [...managed.keys()].filter((path) => path.startsWith(prefix)),
  };
  let escaped: BlobStore | undefined;
  try {
    const catalog = new SQLiteBlobCatalog(db);
    await catalog.initialize();
    const blobs = new BlobStore(files, catalog);
    await db.withTransactionAsync(async (transaction) => {
      assert.ok(transaction);
      escaped = blobs.withDatabase(transaction);
      const imported = await escaped.importBytes(new Uint8Array([1, 2, 3]), {
        mimeType: "application/octet-stream",
        owner: { ownerType: "other", ownerId: "archive-stage" },
      });
      assert.equal(imported.byteLength, 3);
      assert.equal((await escaped.list()).length, 1);
    });
    assert.equal((await blobs.list()).length, 1);
    assert.ok(escaped);
    await assert.rejects(escaped.list(), /scope is closed/);
  } finally {
    native.close();
  }
});
