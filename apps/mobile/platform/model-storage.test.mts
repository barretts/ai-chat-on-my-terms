import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vitest";
import { curatedCatalog, type CatalogModel } from "@locallab/models-catalog";
import { SQLiteBlobCatalog } from "@locallab/storage-blobs";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { sharedMobileDatabase } from "./database";

const state = vi.hoisted(() => ({
  db: undefined as SQLiteDatabasePort | undefined,
}));
// Only the native connection/UUID facades are replaced. Storage SQL, its shared
// operation queue, transactions and filesystem bytes are real in these fixtures.
vi.mock("./database-open", () => ({
  openMobileDatabase: async () => {
    if (!state.db) throw new Error("SQLite fixture is not open");
    return state.db;
  },
}));
vi.mock("./crypto", async () => {
  const { randomUUID, createHash } = await import("node:crypto");
  return {
    mobileBlobCrypto: {
      randomUUID,
      sha256: async (bytes: Uint8Array) =>
        createHash("sha256").update(bytes).digest("hex"),
    },
  };
});

import {
  adoptDownloadedModel,
  assertModelIntegrity,
  beginModelDownload,
  discardModelDownload,
  managedModelPath,
  newModelBlobId,
  partialModelPath,
  readInstalledModels,
  recoverModelDownloads,
  removeInstalledModel,
  withModelDownload,
} from "./model-storage";

const bytes = new Uint8Array([0x47, 0x47, 0x55, 0x46, 1, 2, 3, 4]);
const hash = createHash("sha256").update(bytes).digest("hex");
const seed = curatedCatalog.models.find((model) => model.artifact)!;
// Tiny fixture bytes exercise durable storage behavior, not a real GGUF model.
const model: CatalogModel = {
  ...seed,
  id: "fixture/storage-gguf",
  name: "Storage fixture GGUF",
  sizeBytes: bytes.length,
  artifact: {
    ...seed.artifact!,
    url: "https://model-fixture.invalid/fixture.gguf",
    fileName: "fixture.gguf",
    sizeBytes: bytes.length,
    sha256: hash,
  },
};

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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "locallab-model-storage-"));
  const databasePath = join(directory, "model.sqlite");
  const connect = () => {
    const native = new DatabaseSync(databasePath);
    native.exec("PRAGMA foreign_keys = ON");
    state.db = sharedMobileDatabase(adapter(native));
    return native;
  };
  let native = connect();
  await mkdir(join(directory, "locallab", "blobs"), { recursive: true });
  const file = (blobId: string, partial = false) =>
    join(
      directory,
      partial ? partialModelPath(blobId) : managedModelPath(blobId),
    );
  const removeStage = async (blobId: string) => {
    await rm(file(blobId, true), { force: true });
    await rm(file(blobId), { force: true });
  };
  const removeManaged = async (path: string) => {
    // Production callbacks validate the same single managed UUID filename.
    const id = path.slice("locallab/blobs/".length);
    assert.equal(path, managedModelPath(id));
    await rm(file(id), { force: true });
  };
  const install = async () => {
    const blobId = newModelBlobId();
    await beginModelDownload(model, blobId);
    await writeFile(file(blobId), bytes);
    assertModelIntegrity(model, {
      byteLength: bytes.length,
      sha256: hash,
      prefix: bytes,
    });
    return adoptDownloadedModel(model, blobId);
  };
  return {
    get native() {
      return native;
    },
    get db() {
      return state.db!;
    },
    file,
    install,
    removeStage,
    removeManaged,
    reopen() {
      native.close();
      native = connect();
    },
    async close() {
      native.close();
      state.db = undefined;
      assert.equal(dirname(directory), tmpdir());
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("an active download is preserved, then abandoned staged bytes are recovered after SQLite reopen", async () => {
  const saved = await fixture();
  const entered = deferred<void>();
  const finish = deferred<void>();
  const id = newModelBlobId();
  const downloading = withModelDownload(model, id, async () => {
    await beginModelDownload(model, id);
    await writeFile(saved.file(id, true), bytes.subarray(0, 5));
    entered.resolve();
    await finish.promise;
  });
  try {
    await entered.promise;
    await recoverModelDownloads(saved.removeStage);
    assert.equal((await readFile(saved.file(id, true))).length, 5);
    assert.deepEqual(await readInstalledModels(), []);
    finish.resolve();
    await downloading;
    saved.reopen();
    await recoverModelDownloads(saved.removeStage);
    await assert.rejects(readFile(saved.file(id, true)), { code: "ENOENT" });
    assert.deepEqual(await readInstalledModels(), []);
    assert.equal(
      saved.native
        .prepare("SELECT COUNT(*) AS n FROM local_model_download_stages")
        .get()!.n,
      0,
    );
    assert.equal(
      saved.native.prepare("SELECT COUNT(*) AS n FROM managed_blobs").get()!.n,
      0,
    );
  } finally {
    finish.resolve();
    await downloading;
    await saved.close();
  }
});

test("verified adoption survives reopen with a model owner and never leaves a large-file recovery intent", async () => {
  const saved = await fixture();
  try {
    const entry = await saved.install();
    assert.equal(
      saved.native
        .prepare("SELECT COUNT(*) AS n FROM blob_import_intents")
        .get()!.n,
      0,
    );
    assert.equal(
      saved.native
        .prepare("SELECT COUNT(*) AS n FROM local_model_download_stages")
        .get()!.n,
      0,
    );
    saved.reopen();
    assert.deepEqual(await readInstalledModels(), [entry]);
    const catalog = new SQLiteBlobCatalog(saved.db);
    assert.equal(
      (await catalog.get(entry.blobId))?.mimeType,
      "application/x-gguf",
    );
    assert.deepEqual(await catalog.references(entry.blobId), [
      { blobId: entry.blobId, ownerType: "model-job", ownerId: model.id },
    ]);
    // A lost success reply may invoke cleanup; committed bytes must survive it.
    let removed = false;
    await discardModelDownload(entry.blobId, async () => {
      removed = true;
      await saved.removeStage(entry.blobId);
    });
    assert.equal(removed, false);
    assert.deepEqual(
      new Uint8Array(await readFile(saved.file(entry.blobId))),
      bytes,
    );
    await assert.rejects(
      beginModelDownload(model, newModelBlobId()),
      /already installed/,
    );
  } finally {
    await saved.close();
  }
});

test("failed adoption rolls back metadata and owners, leaving only its safely discardable stage", async () => {
  const saved = await fixture();
  try {
    const id = newModelBlobId();
    await beginModelDownload(model, id);
    await writeFile(saved.file(id), bytes);
    await saved.db.execAsync(
      "CREATE TRIGGER reject_model_index BEFORE INSERT ON installed_local_models BEGIN SELECT RAISE(ABORT, 'fixture adoption rejected'); END",
    );
    await assert.rejects(
      adoptDownloadedModel(model, id),
      /fixture adoption rejected/,
    );
    const catalog = new SQLiteBlobCatalog(saved.db);
    assert.equal(await catalog.get(id), undefined);
    assert.deepEqual(await catalog.references(id), []);
    assert.deepEqual(await catalog.listImports(), []);
    assert.deepEqual(await readInstalledModels(), []);
    saved.reopen();
    await recoverModelDownloads(saved.removeStage);
    await assert.rejects(readFile(saved.file(id)), { code: "ENOENT" });
  } finally {
    await saved.close();
  }
});

test("leases and unrelated references refuse deletion; safe deletion clears exact blob selections and preserves history", async () => {
  const saved = await fixture();
  try {
    const entry = await saved.install();
    const catalog = new SQLiteBlobCatalog(saved.db);
    await saved.db.execAsync(`
      CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE chat_provider_connections(id TEXT PRIMARY KEY, registration_json TEXT NOT NULL CHECK(json_valid(registration_json)));
      CREATE TABLE chat_provider_selections(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), connection_id TEXT NOT NULL REFERENCES chat_provider_connections(id) ON DELETE RESTRICT);
      CREATE TABLE phone_model_choice_local(singleton INTEGER PRIMARY KEY CHECK(singleton=1), provider_id TEXT NOT NULL);
      INSERT INTO conversations VALUES('first', 'Saved first'), ('second', 'Saved second'), ('other', 'Unrelated saved chat');
    `);
    await saved.db.runAsync(
      "INSERT INTO chat_provider_connections VALUES('local', ?), ('other', ?)",
      JSON.stringify({ kind: "local-gguf", modelId: `blob:${entry.blobId}` }),
      JSON.stringify({
        kind: "local-gguf",
        modelId: `blob:${newModelBlobId()}`,
      }),
    );
    await saved.db.execAsync(
      "INSERT INTO chat_provider_selections VALUES('first','local'),('second','local'),('other','other')",
    );
    await saved.db.runAsync(
      "INSERT INTO phone_model_choice_local VALUES(1, ?)",
      entry.blobId,
    );
    await catalog.acquireLease({
      token: "native-runtime-fixture",
      blobId: entry.blobId,
      purpose: "gguf-inference",
    });
    let removed = 0;
    const remove = async (path: string) => {
      removed++;
      await saved.removeManaged(path);
    };
    await assert.rejects(removeInstalledModel(entry, remove), /in use/);
    assert.equal(removed, 0);
    assert.deepEqual(await readInstalledModels(), [entry]);
    assert.equal(
      saved.native
        .prepare("SELECT COUNT(*) AS n FROM chat_provider_selections")
        .get()!.n,
      3,
    );
    await catalog.releaseLease("native-runtime-fixture");
    await catalog.addReference({
      blobId: entry.blobId,
      ownerType: "other",
      ownerId: "saved-dependent-fixture",
    });
    await assert.rejects(
      removeInstalledModel(entry, remove),
      /still referenced/,
    );
    assert.equal(removed, 0);
    await catalog.removeReference({
      blobId: entry.blobId,
      ownerType: "other",
      ownerId: "saved-dependent-fixture",
    });
    await removeInstalledModel(entry, remove);
    assert.equal(removed, 1);
    await assert.rejects(readFile(saved.file(entry.blobId)), {
      code: "ENOENT",
    });
    assert.deepEqual(await readInstalledModels(), []);
    assert.equal(await catalog.get(entry.blobId), undefined);
    assert.equal(
      saved.native.prepare("SELECT COUNT(*) AS n FROM conversations").get()!.n,
      3,
    );
    assert.deepEqual(
      saved.native
        .prepare(
          "SELECT conversation_id,connection_id FROM chat_provider_selections",
        )
        .all()
        .map((row) => ({ ...row })),
      [{ conversation_id: "other", connection_id: "other" }],
    );
    assert.equal(
      saved.native
        .prepare("SELECT COUNT(*) AS n FROM chat_provider_connections")
        .get()!.n,
      1,
    );
    assert.equal(
      saved.native
        .prepare("SELECT COUNT(*) AS n FROM phone_model_choice_local")
        .get()!.n,
      0,
    );
    await removeInstalledModel(entry, remove);
    assert.equal(removed, 1, "a repeated delete must be harmless");
  } finally {
    await saved.close();
  }
});

test("a concurrent new lease waits behind unlink and cannot attach to a removed model", async () => {
  const saved = await fixture();
  const unlink = deferred<void>();
  const entered = deferred<void>();
  let lateLeaseSettled = false;
  try {
    const entry = await saved.install();
    const catalog = new SQLiteBlobCatalog(saved.db);
    const deleting = removeInstalledModel(entry, async (path) => {
      entered.resolve();
      await unlink.promise;
      await saved.removeManaged(path);
    });
    await entered.promise;
    const leasing = catalog
      .acquireLease({
        token: "racing-native-fixture",
        blobId: entry.blobId,
        purpose: "gguf-inference",
      })
      .then(
        () => {
          lateLeaseSettled = true;
        },
        (error: unknown) => {
          lateLeaseSettled = true;
          throw error;
        },
      );
    const rejectedLease = assert.rejects(
      leasing,
      /FOREIGN KEY constraint failed/,
    );
    await Promise.resolve();
    assert.equal(lateLeaseSettled, false);
    unlink.resolve();
    await deleting;
    await rejectedLease;
    assert.deepEqual(
      await catalog.leases(entry.blobId, new Date().toISOString()),
      [],
    );
    assert.deepEqual(await readInstalledModels(), []);
  } finally {
    unlink.resolve();
    await saved.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
