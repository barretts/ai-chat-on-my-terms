export type BlobId = string;
export type BlobOwnerType =
  | "message"
  | "cover"
  | "model-job"
  | "media-job"
  | "other";

export interface BlobMetadata {
  id: BlobId;
  sha256: string;
  mimeType: string;
  byteLength: number;
  managedPath: string;
  createdAt: string;
}

export interface BlobImportIntent {
  id: BlobId;
  partialPath: string;
  finalPath: string;
  mimeType: string;
  createdAt: string;
  expectedSha256: string;
  expectedByteLength: number;
  sourceUri?: string;
  owner?: Omit<BlobReference, "blobId">;
}

export interface BlobReference {
  blobId: BlobId;
  ownerType: BlobOwnerType;
  ownerId: string;
}

export interface BlobLease {
  token: string;
  blobId: BlobId;
  purpose: string;
  expiresAt?: string;
}

/** All paths accepted here must be app-owned paths. External source URIs are read-only. */
export interface BlobFilePort {
  readExternal(uri: string): Promise<Uint8Array>;
  readManaged(path: string): Promise<Uint8Array>;
  writeManaged(path: string, bytes: Uint8Array): Promise<void>;
  moveManaged(source: string, destination: string): Promise<void>;
  removeManaged(path: string): Promise<void>;
  listManaged(prefix: string): Promise<readonly string[]>;
}

/** Back this catalog with the app's SQLite transaction layer in production. */
export interface BlobCatalogPort {
  beginImport(intent: BlobImportIntent): Promise<void>;
  listImports(): Promise<readonly BlobImportIntent[]>;
  finishImport(intentId: BlobId, metadata: BlobMetadata): Promise<void>;
  get(blobId: BlobId): Promise<BlobMetadata | undefined>;
  list(): Promise<readonly BlobMetadata[]>;
  addReference(reference: BlobReference): Promise<void>;
  removeReference(reference: BlobReference): Promise<void>;
  references(blobId: BlobId): Promise<readonly BlobReference[]>;
  acquireLease(lease: BlobLease): Promise<void>;
  releaseLease(token: string): Promise<BlobId | undefined>;
  leases(blobId: BlobId, now: string): Promise<readonly BlobLease[]>;
  deleteMetadata(blobId: BlobId): Promise<void>;
}

/**
 * SQLite-backed catalog for app-private blob bytes. Call initialize() after opening
 * the app database and before constructing BlobStore. Tables are namespaced so this
 * adapter can be enabled without rewriting the core conversation schema.
 */
export class SQLiteBlobCatalog implements BlobCatalogPort {
  constructor(
    private readonly db: SQLiteDatabasePort,
    private readonly transactionBound = false,
  ) {}

  /** Bind helpers to an already-active transaction; do not open a nested one. */
  forDatabase(transaction: SQLiteDatabasePort): SQLiteBlobCatalog {
    return new SQLiteBlobCatalog(transaction, true);
  }

  private withTransaction(
    work: (transaction?: SQLiteDatabasePort) => Promise<void>,
  ): Promise<void> {
    return this.transactionBound
      ? work(this.db)
      : this.db.withTransactionAsync(work);
  }

  async initialize(): Promise<void> {
    await this.db.execAsync(`
      CREATE TABLE IF NOT EXISTS blob_import_intents (
        id TEXT PRIMARY KEY NOT NULL,
        intent_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_blobs (
        id TEXT PRIMARY KEY NOT NULL,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        managed_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blob_references (
        blob_id TEXT NOT NULL REFERENCES managed_blobs(id) ON DELETE CASCADE,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        PRIMARY KEY (blob_id, owner_type, owner_id)
      );
      CREATE INDEX IF NOT EXISTS blob_references_owner
        ON blob_references(owner_type, owner_id);
      CREATE TABLE IF NOT EXISTS blob_leases (
        token TEXT PRIMARY KEY NOT NULL,
        blob_id TEXT NOT NULL REFERENCES managed_blobs(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS blob_leases_blob ON blob_leases(blob_id);
    `);
  }

  async beginImport(intent: BlobImportIntent): Promise<void> {
    await this.db.runAsync(
      "INSERT INTO blob_import_intents (id, intent_json) VALUES (?, ?)",
      intent.id,
      JSON.stringify(intent),
    );
  }

  async listImports(): Promise<readonly BlobImportIntent[]> {
    const rows = await this.db.getAllAsync<{ intent_json: string }>(
      "SELECT intent_json FROM blob_import_intents ORDER BY id",
    );
    return rows.map((row) => JSON.parse(row.intent_json) as BlobImportIntent);
  }

  async finishImport(id: BlobId, metadata: BlobMetadata): Promise<void> {
    await this.withTransaction(async (transaction) => {
      const db = transaction ?? this.db;
      const pending = await db.getFirstAsync<{ intent_json: string }>(
        "SELECT intent_json FROM blob_import_intents WHERE id = ?",
        id,
      );
      await db.runAsync(
        `INSERT INTO managed_blobs (id, sha256, mime_type, byte_length, managed_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256, mime_type=excluded.mime_type,
         byte_length=excluded.byte_length, managed_path=excluded.managed_path, created_at=excluded.created_at`,
        metadata.id,
        metadata.sha256,
        metadata.mimeType,
        metadata.byteLength,
        metadata.managedPath,
        metadata.createdAt,
      );
      const owner = pending
        ? (JSON.parse(pending.intent_json) as BlobImportIntent).owner
        : undefined;
      if (owner) {
        await db.runAsync(
          "INSERT INTO blob_references (blob_id, owner_type, owner_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          id,
          owner.ownerType,
          owner.ownerId,
        );
      }
      await db.runAsync("DELETE FROM blob_import_intents WHERE id = ?", id);
    });
  }

  async get(id: BlobId): Promise<BlobMetadata | undefined> {
    const row = await this.db.getFirstAsync<BlobRow>(
      "SELECT id, sha256, mime_type, byte_length, managed_path, created_at FROM managed_blobs WHERE id = ?",
      id,
    );
    return row ? blobFromRow(row) : undefined;
  }

  async list(): Promise<readonly BlobMetadata[]> {
    const rows = await this.db.getAllAsync<BlobRow>(
      "SELECT id, sha256, mime_type, byte_length, managed_path, created_at FROM managed_blobs ORDER BY created_at, id",
    );
    return rows.map(blobFromRow);
  }

  async addReference(reference: BlobReference): Promise<void> {
    await this.db.runAsync(
      "INSERT INTO blob_references (blob_id, owner_type, owner_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      reference.blobId,
      reference.ownerType,
      reference.ownerId,
    );
  }

  async removeReference(reference: BlobReference): Promise<void> {
    await this.db.runAsync(
      "DELETE FROM blob_references WHERE blob_id = ? AND owner_type = ? AND owner_id = ?",
      reference.blobId,
      reference.ownerType,
      reference.ownerId,
    );
  }

  async references(id: BlobId): Promise<readonly BlobReference[]> {
    const rows = await this.db.getAllAsync<ReferenceRow>(
      "SELECT blob_id, owner_type, owner_id FROM blob_references WHERE blob_id = ? ORDER BY owner_type, owner_id",
      id,
    );
    return rows.map((row) => ({
      blobId: row.blob_id,
      ownerType: row.owner_type as BlobOwnerType,
      ownerId: row.owner_id,
    }));
  }

  async acquireLease(lease: BlobLease): Promise<void> {
    await this.db.runAsync(
      "INSERT INTO blob_leases (token, blob_id, purpose, expires_at) VALUES (?, ?, ?, ?)",
      lease.token,
      lease.blobId,
      lease.purpose,
      lease.expiresAt ?? null,
    );
  }

  async releaseLease(token: string): Promise<BlobId | undefined> {
    let blobId: BlobId | undefined;
    await this.withTransaction(async (transaction) => {
      const db = transaction ?? this.db;
      const row = await db.getFirstAsync<{ blob_id: string }>(
        "SELECT blob_id FROM blob_leases WHERE token = ?",
        token,
      );
      if (!row) return;
      blobId = row.blob_id;
      await db.runAsync("DELETE FROM blob_leases WHERE token = ?", token);
    });
    return blobId;
  }

  async leases(id: BlobId, now: string): Promise<readonly BlobLease[]> {
    const rows = await this.db.getAllAsync<LeaseRow>(
      "SELECT token, blob_id, purpose, expires_at FROM blob_leases WHERE blob_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY token",
      id,
      now,
    );
    return rows.map((row) => ({
      token: row.token,
      blobId: row.blob_id,
      purpose: row.purpose,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    }));
  }

  async deleteMetadata(id: BlobId): Promise<void> {
    await this.withTransaction(async (transaction) => {
      const db = transaction ?? this.db;
      await db.runAsync("DELETE FROM managed_blobs WHERE id = ?", id);
      await db.runAsync("DELETE FROM blob_import_intents WHERE id = ?", id);
    });
  }
}

type BlobRow = {
  id: string;
  sha256: string;
  mime_type: string;
  byte_length: number;
  managed_path: string;
  created_at: string;
};
type ReferenceRow = { blob_id: string; owner_type: string; owner_id: string };
type LeaseRow = {
  token: string;
  blob_id: string;
  purpose: string;
  expires_at: string | null;
};

function blobFromRow(row: BlobRow): BlobMetadata {
  return {
    id: row.id,
    sha256: row.sha256,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    managedPath: row.managed_path,
    createdAt: row.created_at,
  };
}

export interface BlobCryptoPort {
  randomUUID(): string;
  sha256(bytes: Uint8Array): Promise<string>;
}

/** Uses platform Web Crypto, available in modern Node and Expo runtimes. */
export const webCryptoBlobCrypto: BlobCryptoPort = {
  randomUUID: () => globalThis.crypto.randomUUID(),
  async sha256(bytes) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      bytes.slice().buffer,
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  },
};

export interface BlobImportOptions {
  mimeType?: string;
  owner?: Omit<BlobReference, "blobId">;
}

const cleanMime = (value: string | undefined): string => {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)
    ? mime
    : "application/octet-stream";
};

const nowIso = (): string => new Date().toISOString();

export class BlobStore {
  constructor(
    private readonly files: BlobFilePort,
    private readonly catalog: BlobCatalogPort,
    private readonly root = "blobs",
    private readonly crypto: BlobCryptoPort = webCryptoBlobCrypto,
  ) {}

  /** Reuse file/crypto ports with a catalog bound to an active SQLite scope. */
  withDatabase(transaction: SQLiteDatabasePort): BlobStore {
    if (!(this.catalog instanceof SQLiteBlobCatalog))
      throw new Error(
        "Only a SQLite blob catalog can bind to a database transaction",
      );
    return new BlobStore(
      this.files,
      this.catalog.forDatabase(transaction),
      this.root,
      this.crypto,
    );
  }

  /** Copies an external document into app storage. The supplied URI is never renamed or removed. */
  async importExternal(
    uri: string,
    options: BlobImportOptions = {},
  ): Promise<BlobMetadata> {
    const bytes = await this.files.readExternal(uri);
    return this.importBytes(bytes, { ...options, sourceUri: uri });
  }

  async importBytes(
    bytes: Uint8Array,
    options: BlobImportOptions & { sourceUri?: string } = {},
  ): Promise<BlobMetadata> {
    const id = this.crypto.randomUUID();
    const expectedSha256 = await this.crypto.sha256(bytes);
    const finalPath = `${this.root}/${id}`;
    const intent: BlobImportIntent = {
      id,
      partialPath: `${this.root}/.partial-${id}`,
      finalPath,
      mimeType: cleanMime(options.mimeType),
      createdAt: nowIso(),
      expectedSha256,
      expectedByteLength: bytes.byteLength,
      ...(options.sourceUri === undefined
        ? {}
        : { sourceUri: options.sourceUri }),
      ...(options.owner === undefined ? {} : { owner: options.owner }),
    };
    await this.catalog.beginImport(intent);
    await this.files.writeManaged(intent.partialPath, bytes);
    return this.finalizeIntent(intent, bytes, options.owner);
  }

  /** Completes a staged import after a process restart, or removes an irrecoverable empty stage. */
  async recoverImports(): Promise<{ recovered: number; discarded: number }> {
    let recovered = 0;
    let discarded = 0;
    for (const intent of await this.catalog.listImports()) {
      try {
        const paths = await this.files.listManaged(intent.partialPath);
        const sourcePath = paths.includes(intent.partialPath)
          ? intent.partialPath
          : (await this.files.listManaged(intent.finalPath)).includes(
                intent.finalPath,
              )
            ? intent.finalPath
            : undefined;
        if (!sourcePath) {
          await this.catalog.deleteMetadata(intent.id);
          discarded += 1;
          continue;
        }
        const bytes = await this.files.readManaged(sourcePath);
        if (
          bytes.byteLength !== intent.expectedByteLength ||
          (await this.crypto.sha256(bytes)) !== intent.expectedSha256
        ) {
          if (sourcePath === intent.partialPath) {
            await this.files.removeManaged(sourcePath);
          }
          await this.catalog.deleteMetadata(intent.id);
          discarded += 1;
          continue;
        }
        await this.finalizeIntent(intent, bytes, intent.owner, sourcePath);
        recovered += 1;
      } catch {
        // Leave the intent and staged file untouched after transient failures for the next launch.
      }
    }
    return { recovered, discarded };
  }

  async read(
    blobId: BlobId,
  ): Promise<{ metadata: BlobMetadata; bytes: Uint8Array }> {
    const metadata = await this.requireMetadata(blobId);
    return {
      metadata,
      bytes: await this.files.readManaged(metadata.managedPath),
    };
  }

  async addReference(
    blobId: BlobId,
    owner: Omit<BlobReference, "blobId">,
  ): Promise<void> {
    await this.requireMetadata(blobId);
    await this.catalog.addReference({ blobId, ...owner });
  }

  async removeReference(
    blobId: BlobId,
    owner: Omit<BlobReference, "blobId">,
  ): Promise<boolean> {
    await this.catalog.removeReference({ blobId, ...owner });
    return this.collectIfUnowned(blobId);
  }

  async acquireLease(
    blobId: BlobId,
    purpose: string,
    ttlMs?: number,
  ): Promise<BlobLease> {
    await this.requireMetadata(blobId);
    const lease: BlobLease = {
      token: this.crypto.randomUUID(),
      blobId,
      purpose,
      ...(ttlMs === undefined
        ? {}
        : { expiresAt: new Date(Date.now() + ttlMs).toISOString() }),
    };
    await this.catalog.acquireLease(lease);
    return lease;
  }

  async releaseLease(token: string): Promise<boolean> {
    const blobId = await this.catalog.releaseLease(token);
    return blobId ? this.collectIfUnowned(blobId) : false;
  }

  /** Deletes only managed bytes after all references and active leases have been removed. */
  async deleteIfUnowned(blobId: BlobId): Promise<boolean> {
    return this.collectIfUnowned(blobId);
  }

  async list(): Promise<readonly BlobMetadata[]> {
    return this.catalog.list();
  }

  private async finalizeIntent(
    intent: BlobImportIntent,
    bytes: Uint8Array,
    owner = intent.owner,
    stagedPath = intent.partialPath,
  ): Promise<BlobMetadata> {
    const metadata: BlobMetadata = {
      id: intent.id,
      sha256: intent.expectedSha256,
      mimeType: intent.mimeType,
      byteLength: bytes.byteLength,
      managedPath: intent.finalPath,
      createdAt: intent.createdAt,
    };
    if (stagedPath !== intent.finalPath) {
      await this.files.moveManaged(stagedPath, intent.finalPath);
    }
    await this.catalog.finishImport(intent.id, metadata);
    if (owner) await this.catalog.addReference({ blobId: intent.id, ...owner });
    return metadata;
  }

  private async requireMetadata(blobId: BlobId): Promise<BlobMetadata> {
    const found = await this.catalog.get(blobId);
    if (!found) throw new Error(`Unknown managed blob: ${blobId}`);
    return found;
  }

  private async collectIfUnowned(blobId: BlobId): Promise<boolean> {
    const metadata = await this.catalog.get(blobId);
    if (!metadata) return false;
    const [references, leases] = await Promise.all([
      this.catalog.references(blobId),
      this.catalog.leases(blobId, nowIso()),
    ]);
    if (references.length || leases.length) return false;
    await this.files.removeManaged(metadata.managedPath);
    await this.catalog.deleteMetadata(blobId);
    return true;
  }
}
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
