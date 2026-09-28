import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  BlobStore,
  SQLiteBlobCatalog,
  type BlobCatalogPort,
  type BlobFilePort,
  type BlobImportIntent,
  type BlobLease,
  type BlobMetadata,
  type BlobReference,
} from "../src/index.js";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";

function sqlitePort(database: DatabaseSync): SQLiteDatabasePort {
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
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

class FakeFiles implements BlobFilePort {
  readonly managed = new Map<string, Uint8Array>();
  readonly external = new Map<string, Uint8Array>();
  failAfterPartialWrite = false;

  async readExternal(uri: string): Promise<Uint8Array> {
    const bytes = this.external.get(uri);
    if (!bytes) throw new Error("missing external file");
    return bytes.slice();
  }
  async readManaged(path: string): Promise<Uint8Array> {
    const bytes = this.managed.get(path);
    if (!bytes) throw new Error("missing managed file");
    return bytes.slice();
  }
  async writeManaged(path: string, bytes: Uint8Array): Promise<void> {
    this.managed.set(path, bytes.slice());
    if (this.failAfterPartialWrite) {
      this.failAfterPartialWrite = false;
      throw new Error("simulated process interruption after staged write");
    }
  }
  async moveManaged(source: string, destination: string): Promise<void> {
    const bytes = this.managed.get(source);
    if (!bytes) throw new Error("missing staged file");
    this.managed.set(destination, bytes);
    this.managed.delete(source);
  }
  async removeManaged(path: string): Promise<void> {
    this.managed.delete(path);
  }
  async listManaged(prefix: string): Promise<readonly string[]> {
    return [...this.managed.keys()].filter((path) => path.startsWith(prefix));
  }
}

class FakeCatalog implements BlobCatalogPort {
  readonly imports = new Map<string, BlobImportIntent>();
  readonly blobs = new Map<string, BlobMetadata>();
  readonly refs = new Map<string, BlobReference>();
  readonly heldLeases = new Map<string, BlobLease>();

  async beginImport(intent: BlobImportIntent): Promise<void> {
    this.imports.set(intent.id, intent);
  }
  async listImports(): Promise<readonly BlobImportIntent[]> {
    return [...this.imports.values()];
  }
  async finishImport(id: string, metadata: BlobMetadata): Promise<void> {
    this.blobs.set(id, metadata);
    this.imports.delete(id);
  }
  async get(id: string): Promise<BlobMetadata | undefined> {
    return this.blobs.get(id);
  }
  async list(): Promise<readonly BlobMetadata[]> {
    return [...this.blobs.values()];
  }
  async addReference(ref: BlobReference): Promise<void> {
    this.refs.set(`${ref.blobId}:${ref.ownerType}:${ref.ownerId}`, ref);
  }
  async removeReference(ref: BlobReference): Promise<void> {
    this.refs.delete(`${ref.blobId}:${ref.ownerType}:${ref.ownerId}`);
  }
  async references(id: string): Promise<readonly BlobReference[]> {
    return [...this.refs.values()].filter((ref) => ref.blobId === id);
  }
  async acquireLease(lease: BlobLease): Promise<void> {
    this.heldLeases.set(lease.token, lease);
  }
  async releaseLease(token: string): Promise<string | undefined> {
    const lease = this.heldLeases.get(token);
    this.heldLeases.delete(token);
    return lease?.blobId;
  }
  async leases(id: string, now: string): Promise<readonly BlobLease[]> {
    return [...this.heldLeases.values()].filter(
      (lease) =>
        lease.blobId === id && (!lease.expiresAt || lease.expiresAt > now),
    );
  }
  async deleteMetadata(id: string): Promise<void> {
    this.blobs.delete(id);
    this.imports.delete(id);
    for (const key of this.refs.keys())
      if (key.startsWith(`${id}:`)) this.refs.delete(key);
  }
}

test("restart recovery promotes a fully staged import and preserves hash and metadata", async () => {
  const files = new FakeFiles();
  const catalog = new FakeCatalog();
  files.failAfterPartialWrite = true;
  const store = new BlobStore(files, catalog);
  const bytes = new TextEncoder().encode("recover me");
  await assert.rejects(
    store.importBytes(bytes, {
      mimeType: "text/plain; charset=utf-8",
      owner: { ownerType: "media-job", ownerId: "job-1" },
    }),
    /simulated process interruption/,
  );

  const restarted = new BlobStore(files, catalog);
  assert.deepEqual(await restarted.recoverImports(), {
    recovered: 1,
    discarded: 0,
  });
  const [metadata] = await restarted.list();
  assert.ok(metadata);
  assert.equal(
    metadata.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(metadata.mimeType, "text/plain");
  assert.equal(
    (await restarted.read(metadata.id)).bytes.toString(),
    bytes.toString(),
  );
  assert.equal((await catalog.references(metadata.id)).length, 1);
});

test("unlinking an external original only drops its managed copy after refcount and lease reach zero", async () => {
  const files = new FakeFiles();
  const catalog = new FakeCatalog();
  const original = new TextEncoder().encode("user-owned document");
  files.external.set("content://picker/document/7", original);
  const store = new BlobStore(files, catalog);
  const metadata = await store.importExternal("content://picker/document/7", {
    mimeType: "application/pdf",
    owner: { ownerType: "message", ownerId: "message-9" },
  });

  const lease = await store.acquireLease(metadata.id, "preview");
  assert.equal(
    await store.removeReference(metadata.id, {
      ownerType: "message",
      ownerId: "message-9",
    }),
    false,
  );
  assert.equal(files.external.has("content://picker/document/7"), true);
  assert.equal(files.managed.has(metadata.managedPath), true);

  assert.equal(await store.releaseLease(lease.token), true);
  assert.equal(files.managed.has(metadata.managedPath), false);
  assert.deepEqual(files.external.get("content://picker/document/7"), original);
  assert.equal(await catalog.get(metadata.id), undefined);
});

test("SQLite catalog persists imports, references and leases across database reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locallab-blob-catalog-"));
  const path = join(directory, "local.sqlite");
  try {
    const firstDb = new DatabaseSync(path);
    firstDb.exec("PRAGMA foreign_keys = ON");
    const firstCatalog = new SQLiteBlobCatalog(sqlitePort(firstDb));
    await firstCatalog.initialize();
    const intent: BlobImportIntent = {
      id: "blob-1",
      partialPath: "locallab/blobs/.partial-blob-1",
      finalPath: "locallab/blobs/blob-1",
      mimeType: "image/png",
      createdAt: "2026-01-01T00:00:00.000Z",
      expectedSha256: "a".repeat(64),
      expectedByteLength: 3,
      owner: { ownerType: "message", ownerId: "message-1" },
    };
    await firstCatalog.beginImport(intent);
    await firstCatalog.finishImport(intent.id, {
      id: intent.id,
      sha256: intent.expectedSha256,
      mimeType: intent.mimeType,
      byteLength: intent.expectedByteLength,
      managedPath: intent.finalPath,
      createdAt: intent.createdAt,
    });
    await firstCatalog.addReference({
      blobId: intent.id,
      ownerType: "message",
      ownerId: "message-1",
    });
    await firstCatalog.acquireLease({
      token: "lease-1",
      blobId: intent.id,
      purpose: "preview",
    });
    firstDb.close();

    const reopened = new DatabaseSync(path);
    reopened.exec("PRAGMA foreign_keys = ON");
    const catalog = new SQLiteBlobCatalog(sqlitePort(reopened));
    await catalog.initialize();
    assert.deepEqual(await catalog.listImports(), []);
    assert.equal((await catalog.get(intent.id))?.managedPath, intent.finalPath);
    assert.deepEqual(await catalog.references(intent.id), [
      { blobId: intent.id, ownerType: "message", ownerId: "message-1" },
    ]);
    assert.deepEqual(
      await catalog.leases(intent.id, "2026-01-01T00:00:00.000Z"),
      [{ token: "lease-1", blobId: intent.id, purpose: "preview" }],
    );
    assert.equal(await catalog.releaseLease("lease-1"), intent.id);
    await catalog.removeReference({
      blobId: intent.id,
      ownerType: "message",
      ownerId: "message-1",
    });
    await catalog.deleteMetadata(intent.id);
    assert.equal(await catalog.get(intent.id), undefined);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
