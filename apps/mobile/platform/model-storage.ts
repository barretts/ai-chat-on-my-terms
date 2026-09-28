import type { CatalogModel } from "@locallab/models-catalog";
import { SQLiteBlobCatalog, type BlobMetadata } from "@locallab/storage-blobs";
import { openMobileDatabase } from "./database-open";
import { mobileBlobCrypto } from "./crypto";

export interface InstalledLocalModel {
  catalogId: string;
  blobId: string;
  name: string;
  sizeBytes: number;
  sha256: string;
}

export interface LocalModelDownloadProgress {
  bytes: number;
  total: number;
  phase: "downloading" | "saving";
}

export const LOCAL_MODELS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS installed_local_models (
    catalog_id TEXT PRIMARY KEY NOT NULL,
    blob_id TEXT NOT NULL UNIQUE REFERENCES managed_blobs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 4),
    sha256 TEXT NOT NULL,
    installed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS local_model_download_stages (
    blob_id TEXT PRIMARY KEY NOT NULL,
    catalog_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

interface InstalledRow {
  catalog_id: string;
  blob_id: string;
  name: string;
  size_bytes: number;
  sha256: string;
}

const activeCatalogs = new Set<string>();
const activeBlobs = new Set<string>();
const blobIdPattern =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const downloadLock = (id: string) => `locallab-model-download:${id}`;

async function modelDatabase() {
  const db = await openMobileDatabase();
  await db.execAsync("PRAGMA foreign_keys = ON");
  await new SQLiteBlobCatalog(db).initialize();
  await db.execAsync(LOCAL_MODELS_SCHEMA_SQL);
  return db;
}

export function modelArtifact(
  model: CatalogModel,
): NonNullable<CatalogModel["artifact"]> {
  const artifact = model.artifact;
  if (!artifact || !model.formats.includes("gguf"))
    throw new Error("This model does not have a catalog GGUF download.");
  const url = new URL(artifact.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/^[A-Za-z0-9._-]+\.gguf$/.test(artifact.fileName) ||
    !/^[\da-f]{64}$/i.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 4
  )
    throw new Error("The model download metadata is invalid.");
  return artifact;
}

export function newModelBlobId(): string {
  return mobileBlobCrypto.randomUUID();
}

export function managedModelPath(blobId: string): string {
  if (!blobIdPattern.test(blobId)) throw new Error("Invalid managed model ID.");
  return `locallab/blobs/${blobId}`;
}

export function partialModelPath(blobId: string): string {
  managedModelPath(blobId);
  return `locallab/blobs/.model-partial-${blobId}`;
}

export function hasGgufMagic(prefix: Uint8Array): boolean {
  return (
    prefix.length >= 4 &&
    prefix[0] === 0x47 &&
    prefix[1] === 0x47 &&
    prefix[2] === 0x55 &&
    prefix[3] === 0x46
  );
}

export function assertModelIntegrity(
  model: CatalogModel,
  inspection: { byteLength: number; sha256: string; prefix: Uint8Array },
): void {
  const artifact = modelArtifact(model);
  if (
    inspection.byteLength !== artifact.sizeBytes ||
    inspection.sha256.toLowerCase() !== artifact.sha256.toLowerCase() ||
    !hasGgufMagic(inspection.prefix)
  )
    throw new Error(
      "Model verification failed: file size, SHA-256 or GGUF signature does not match the catalog. Download it again.",
    );
}

/** Catalog digest is provenance; large downloads aren't rehashed by user choice. */
export function assertDownloadedModel(
  model: CatalogModel,
  inspection: { byteLength: number; prefix: Uint8Array },
): void {
  if (
    inspection.byteLength !== modelArtifact(model).sizeBytes ||
    !hasGgufMagic(inspection.prefix)
  )
    throw new Error(
      "The model file is incomplete or is not a GGUF file. Download it again.",
    );
}

export async function readInstalledModels(): Promise<InstalledLocalModel[]> {
  const db = await modelDatabase();
  const rows = await db.getAllAsync<InstalledRow>(
    "SELECT catalog_id, blob_id, name, size_bytes, sha256 FROM installed_local_models ORDER BY installed_at, catalog_id",
  );
  return rows.map(fromRow);
}

export async function withModelDownload<T>(
  model: CatalogModel,
  blobId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (activeCatalogs.has(model.id))
    throw new Error("A download for this model is already in progress.");
  activeCatalogs.add(model.id);
  activeBlobs.add(blobId);
  try {
    const locks =
      typeof navigator !== "undefined" ? navigator.locks : undefined;
    return locks
      ? await locks.request(downloadLock(blobId), work)
      : await work();
  } finally {
    activeBlobs.delete(blobId);
    activeCatalogs.delete(model.id);
  }
}

export async function beginModelDownload(
  model: CatalogModel,
  blobId: string,
): Promise<void> {
  modelArtifact(model);
  managedModelPath(blobId);
  const db = await modelDatabase();
  await db.withTransactionAsync(async (transaction) => {
    const scoped = transaction ?? db;
    const installed = await scoped.getFirstAsync<{ blob_id: string }>(
      "SELECT blob_id FROM installed_local_models WHERE catalog_id = ?",
      model.id,
    );
    if (installed)
      throw new Error(
        "This model is already installed. Delete it before downloading a replacement.",
      );
    await scoped.runAsync(
      "INSERT INTO local_model_download_stages(blob_id, catalog_id, created_at) VALUES(?, ?, ?)",
      blobId,
      model.id,
      new Date().toISOString(),
    );
  });
}

/** File size/header are checked; SHA is the publisher's expected digest, not a local measurement. */
export async function adoptDownloadedModel(
  model: CatalogModel,
  blobId: string,
  signal?: AbortSignal,
): Promise<InstalledLocalModel> {
  const artifact = modelArtifact(model);
  const createdAt = new Date().toISOString();
  const metadata: BlobMetadata = {
    id: blobId,
    managedPath: managedModelPath(blobId),
    byteLength: artifact.sizeBytes,
    sha256: artifact.sha256.toLowerCase(),
    mimeType: "application/x-gguf",
    createdAt,
  };
  const db = await modelDatabase();
  await db.withTransactionAsync(async (transaction) => {
    const scoped = transaction ?? db;
    signal?.throwIfAborted();
    const catalog = new SQLiteBlobCatalog(scoped).forDatabase(scoped);
    // Begin/finish share a transaction, so startup never tries to read a multi-GB
    // model through BlobStore.recoverImports after a process interruption.
    await catalog.beginImport({
      id: blobId,
      partialPath: partialModelPath(blobId),
      finalPath: metadata.managedPath,
      mimeType: metadata.mimeType,
      createdAt,
      expectedSha256: metadata.sha256,
      expectedByteLength: metadata.byteLength,
      owner: { ownerType: "model-job", ownerId: model.id },
    });
    await catalog.finishImport(blobId, metadata);
    await scoped.runAsync(
      "INSERT INTO installed_local_models(catalog_id, blob_id, name, size_bytes, sha256, installed_at) VALUES(?, ?, ?, ?, ?, ?)",
      model.id,
      blobId,
      model.name,
      artifact.sizeBytes,
      metadata.sha256,
      createdAt,
    );
    await scoped.runAsync(
      "DELETE FROM local_model_download_stages WHERE blob_id = ?",
      blobId,
    );
    signal?.throwIfAborted();
  });
  return {
    catalogId: model.id,
    blobId,
    name: model.name,
    sizeBytes: artifact.sizeBytes,
    sha256: metadata.sha256,
  };
}

/** Never remove a successfully adopted blob if an operation's final reply was lost. */
export async function discardModelDownload(
  blobId: string,
  removeStage: (blobId: string) => Promise<void>,
): Promise<void> {
  managedModelPath(blobId);
  const db = await modelDatabase();
  await db.withTransactionAsync(async (transaction) => {
    const scoped = transaction ?? db;
    const metadata = await new SQLiteBlobCatalog(scoped).get(blobId);
    if (!metadata) await removeStage(blobId);
    await scoped.runAsync(
      "DELETE FROM local_model_download_stages WHERE blob_id = ?",
      blobId,
    );
  });
}

export async function recoverModelDownloads(
  removeStage: (blobId: string) => Promise<void>,
): Promise<void> {
  const db = await modelDatabase();
  const stages = await db.getAllAsync<{ blob_id: string }>(
    "SELECT blob_id FROM local_model_download_stages ORDER BY created_at",
  );
  for (const { blob_id: id } of stages) {
    if (activeBlobs.has(id)) continue;
    const locks =
      typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks) {
      await locks.request(
        downloadLock(id),
        { ifAvailable: true },
        async (lock) => {
          if (lock && !activeBlobs.has(id))
            await discardModelDownload(id, removeStage);
        },
      );
    } else {
      await discardModelDownload(id, removeStage);
    }
  }
}

/** The SQLite scope prevents a new lease appearing between admission and unlink. */
export async function removeInstalledModel(
  entry: InstalledLocalModel,
  removeManagedFile: (path: string) => Promise<void>,
): Promise<void> {
  const db = await modelDatabase();
  await db.withTransactionAsync(async (transaction) => {
    const scoped = transaction ?? db;
    const row = await scoped.getFirstAsync<InstalledRow>(
      "SELECT catalog_id, blob_id, name, size_bytes, sha256 FROM installed_local_models WHERE catalog_id = ?",
      entry.catalogId,
    );
    if (!row) return;
    if (row.blob_id !== entry.blobId || row.sha256 !== entry.sha256)
      throw new Error("This model changed. Refresh Models before deleting it.");
    const catalog = new SQLiteBlobCatalog(scoped).forDatabase(scoped);
    if ((await catalog.leases(entry.blobId, new Date().toISOString())).length)
      throw new Error(
        "This model is in use. Stop generation and try deleting it again.",
      );
    const references = await catalog.references(entry.blobId);
    if (
      references.some(
        (reference) =>
          reference.ownerType !== "model-job" ||
          reference.ownerId !== entry.catalogId,
      )
    )
      throw new Error(
        "This model is still referenced by saved data. Remove those references before deleting it.",
      );
    // Keep conversation history while removing connections to this exact weight
    // file. These tables are optional when Models opens before Chat initializes.
    const tables = await scoped.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('chat_provider_connections', 'chat_provider_selections', 'phone_model_choice_local')",
    );
    const tableNames = new Set(tables.map((table) => table.name));
    const matchingConnections =
      "SELECT id FROM chat_provider_connections WHERE json_extract(registration_json, '$.kind') = 'local-gguf' AND json_extract(registration_json, '$.modelId') = ?";
    if (tableNames.has("chat_provider_connections")) {
      if (tableNames.has("chat_provider_selections"))
        await scoped.runAsync(
          `DELETE FROM chat_provider_selections WHERE connection_id IN (${matchingConnections})`,
          `blob:${entry.blobId}`,
        );
      await scoped.runAsync(
        `DELETE FROM chat_provider_connections WHERE id IN (${matchingConnections})`,
        `blob:${entry.blobId}`,
      );
    }
    if (tableNames.has("phone_model_choice_local"))
      await scoped.runAsync(
        "DELETE FROM phone_model_choice_local WHERE provider_id = ?",
        entry.blobId,
      );
    const metadata = await catalog.get(entry.blobId);
    if (metadata) {
      if (metadata.managedPath !== managedModelPath(entry.blobId))
        throw new Error("The model file is outside managed storage.");
      await removeManagedFile(metadata.managedPath);
      await catalog.removeReference({
        blobId: entry.blobId,
        ownerType: "model-job",
        ownerId: entry.catalogId,
      });
      await catalog.deleteMetadata(entry.blobId);
    }
    await scoped.runAsync(
      "DELETE FROM installed_local_models WHERE catalog_id = ? AND blob_id = ?",
      entry.catalogId,
      entry.blobId,
    );
  });
}

function fromRow(row: InstalledRow): InstalledLocalModel {
  return {
    catalogId: row.catalog_id,
    blobId: row.blob_id,
    name: row.name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
  };
}
