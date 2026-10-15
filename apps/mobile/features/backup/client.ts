/** Backup client: snapshot the mobile database into an encrypted envelope,
 * upload ciphertext to the API object store, and restore transactionally.
 * The passphrase and plaintext never leave the device. */
import {
  applyRestore,
  createBackup,
  openBackup,
  previewBackup,
  setBackupZipPort,
} from "@locallab/backup";
import type { BackupPreview, CryptoPorts, KdfParams } from "@locallab/backup";
import type { ZipPort } from "@locallab/archives";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { mobileArchiveZip } from "../../composition/chat/archives/zip";
import {
  restoreTransaction,
  snapshotCounts,
  snapshotDatabase,
} from "./db-snapshot";

export interface BackupObjectStorePort {
  put(id: string, bytes: Uint8Array): Promise<void>;
  get(id: string): Promise<Uint8Array | null>;
}

export interface BackupClient {
  create(
    passphrase: string,
  ): Promise<{ bytes: Uint8Array; preview: BackupPreview }>;
  upload(id: string, bytes: Uint8Array): Promise<void>;
  download(id: string): Promise<Uint8Array | null>;
  preview(bytes: Uint8Array, passphrase: string): Promise<BackupPreview>;
  restore(bytes: Uint8Array, passphrase: string): Promise<BackupPreview>;
}

export interface BackupClientOptions {
  db: SQLiteDatabasePort;
  crypto: CryptoPorts;
  store?: BackupObjectStorePort;
  zip?: ZipPort;
  now?: () => Date;
  kdfParams?: Partial<Omit<KdfParams, "saltHex">>;
}

export function createBackupClient(
  options: BackupClientOptions,
): BackupClient {
  const zip = options.zip ?? mobileArchiveZip;
  setBackupZipPort(zip);
  const now = options.now ?? (() => new Date());
  return {
    async create(passphrase) {
      const entries = await snapshotDatabase(options.db);
      const counts = await snapshotCounts(options.db);
      const bytes = await createBackup({
        passphrase,
        manifest: { createdAt: now().toISOString(), counts },
        entries,
        ...(options.kdfParams ? { kdfParams: options.kdfParams } : {}),
        zip,
        crypto: options.crypto,
      });
      const preview = await previewBackup(bytes, passphrase, options.crypto);
      return { bytes, preview };
    },
    async upload(id, bytes) {
      if (!options.store)
        throw new Error("no backup object store is configured");
      await options.store.put(id, bytes);
    },
    async download(id) {
      if (!options.store)
        throw new Error("no backup object store is configured");
      return await options.store.get(id);
    },
    async preview(bytes, passphrase) {
      return await previewBackup(bytes, passphrase, options.crypto);
    },
    async restore(bytes, passphrase) {
      const opened = await openBackup(bytes, passphrase, options.crypto);
      await applyRestore(opened.zipBytes, restoreTransaction(options.db));
      return { manifest: opened.manifest, files: [] };
    },
  };
}

/** API-backed object store (services/api/features/backup routes). */
export function fetchBackupObjectStore(baseUrl: string): BackupObjectStorePort {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return {
    async put(id, bytes) {
      const response = await fetch(`${trimmed}/backup/objects/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Blob([new Uint8Array(bytes).buffer]),
      });
      if (!response.ok)
        throw new Error(
          `backup upload failed with ${String(response.status)}`,
        );
    },
    async get(id) {
      const response = await fetch(`${trimmed}/backup/objects/${id}`);
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(
          `backup download failed with ${String(response.status)}`,
        );
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
