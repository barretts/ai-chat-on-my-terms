import {
  BlobStore,
  SQLiteBlobCatalog,
  type BlobCatalogPort,
  type BlobFilePort,
} from "@locallab/storage-blobs";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { mobileBlobCrypto } from "../crypto";

const MANAGED_ROOT = "locallab/blobs";
const DATABASE_NAME = "locallab-managed-blobs";
const DATABASE_VERSION = 1;
const FILES_STORE = "files";

/** Browser counterpart of the native adapter; managed bytes live in IndexedDB. */
export class ExpoBlobFilePort implements BlobFilePort {
  private database: Promise<IDBDatabase> | undefined;

  constructor(private readonly managedRoot = MANAGED_ROOT) {}

  async readExternal(uri: string): Promise<Uint8Array> {
    if (!uri || uri.includes("\0")) throw new Error("Invalid external URI");
    const url = new URL(uri);
    if (url.protocol !== "data:" && url.protocol !== "blob:") {
      throw new Error("Browser file imports require a data or blob URL");
    }
    const response = await fetch(url);
    if (!response.ok)
      throw new Error("Could not read the selected browser file");
    return new Uint8Array(await response.arrayBuffer());
  }

  async readManaged(path: string): Promise<Uint8Array> {
    const normalized = this.validateManagedPath(path, false);
    return this.withFiles<Uint8Array>("readonly", (files, result, fail) => {
      const request = files.get(normalized);
      request.onsuccess = () => {
        const bytes: unknown = request.result;
        if (!(bytes instanceof ArrayBuffer)) {
          fail(new Error("Managed browser blob was not found or is invalid"));
          return;
        }
        result(new Uint8Array(bytes).slice());
      };
    });
  }

  async writeManaged(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = this.validateManagedPath(path, false);
    // Copy before awaiting the database so caller mutations cannot alter a write.
    const snapshot = bytes.slice().buffer;
    return this.withFiles<void>("readwrite", (files, result) => {
      files.put(snapshot, normalized);
      result(undefined);
    });
  }

  async moveManaged(source: string, destination: string): Promise<void> {
    const normalizedSource = this.validateManagedPath(source, false);
    const normalizedDestination = this.validateManagedPath(destination, false);
    return this.withFiles<void>("readwrite", (files, result, fail) => {
      const request = files.get(normalizedSource);
      request.onsuccess = () => {
        const bytes: unknown = request.result;
        if (!(bytes instanceof ArrayBuffer)) {
          fail(new Error("Managed browser blob was not found or is invalid"));
          return;
        }
        try {
          if (normalizedSource !== normalizedDestination) {
            files.put(bytes, normalizedDestination);
            files.delete(normalizedSource);
          }
          result(undefined);
        } catch (error) {
          fail(error);
        }
      };
    });
  }

  async removeManaged(path: string): Promise<void> {
    const normalized = this.validateManagedPath(path, false);
    return this.withFiles<void>("readwrite", (files, result) => {
      files.delete(normalized);
      result(undefined);
    });
  }

  async listManaged(prefix: string): Promise<readonly string[]> {
    const normalized = this.validateManagedPath(prefix, true);
    const rootPrefix = `${this.managedRoot}/`;
    return this.withFiles<readonly string[]>("readonly", (files, result) => {
      const paths: string[] = [];
      const request = files.openKeyCursor(
        IDBKeyRange.bound(normalized, `${normalized}\uffff`),
      );
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          result(paths);
          return;
        }
        if (
          typeof cursor.key === "string" &&
          cursor.key.startsWith(rootPrefix) &&
          cursor.key.startsWith(normalized) &&
          !cursor.key.slice(rootPrefix.length).includes("/")
        ) {
          paths.push(cursor.key);
        }
        cursor.continue();
      };
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error("IndexedDB is unavailable for browser file storage"));
        return;
      }
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const request = globalThis.indexedDB.open(
        DATABASE_NAME,
        DATABASE_VERSION,
      );
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(FILES_STORE)) {
          request.result.createObjectStore(FILES_STORE);
        }
      };
      request.onerror = () => {
        fail(request.error ?? new Error("Could not open browser file storage"));
      };
      request.onblocked = () => {
        fail(new Error("Browser file storage is blocked by another open tab"));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        if (!database.objectStoreNames.contains(FILES_STORE)) {
          database.close();
          fail(
            new Error("Browser file storage is missing its managed byte store"),
          );
          return;
        }
        settled = true;
        const clear = () => {
          if (this.database === opening) this.database = undefined;
        };
        database.onversionchange = () => {
          database.close();
          clear();
        };
        database.onclose = clear;
        resolve(database);
      };
    });
    this.database = opening;
    void opening.catch(() => {
      if (this.database === opening) this.database = undefined;
    });
    return opening;
  }

  /** Resolve only after commit; a failed move keeps both keys unchanged. */
  private async withFiles<T>(
    mode: IDBTransactionMode,
    work: (
      files: IDBObjectStore,
      result: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    const database = await this.openDatabase();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(FILES_STORE, mode);
      let value: T;
      let failure: unknown;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => {
        reject(
          failure ??
            transaction.error ??
            new Error("Browser file storage transaction was aborted"),
        );
      };
      const fail = (error: unknown) => {
        failure = error;
        try {
          transaction.abort();
        } catch {
          reject(error);
        }
      };
      try {
        work(
          transaction.objectStore(FILES_STORE),
          (result) => {
            value = result;
          },
          fail,
        );
      } catch (error) {
        fail(error);
      }
    });
  }

  private validateManagedPath(path: string, allowDirectory: boolean): string {
    const root = this.managedRoot.split("/");
    const segments = path.split("/");
    if (
      root.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment)) ||
      segments.length < root.length ||
      root.some((segment, index) => segments[index] !== segment) ||
      segments.length > root.length + 1 ||
      (segments.length === root.length && !allowDirectory) ||
      segments
        .slice(root.length)
        .some(
          (segment) =>
            !/^[A-Za-z0-9._-]+$/.test(segment) ||
            segment === "." ||
            segment === "..",
        )
    ) {
      throw new Error("Blob path is outside app-private managed storage");
    }
    return path;
  }
}

export function createExpoBlobFilePort(): ExpoBlobFilePort {
  return new ExpoBlobFilePort();
}

export async function createMobileBlobCatalog(
  database: SQLiteDatabasePort,
): Promise<SQLiteBlobCatalog> {
  const catalog = new SQLiteBlobCatalog(database);
  await catalog.initialize();
  return catalog;
}

export function createMobileBlobStore(
  bridge: BlobFilePort,
  catalog: BlobCatalogPort,
): BlobStore {
  return new BlobStore(bridge, catalog, MANAGED_ROOT, mobileBlobCrypto);
}

export async function openMobileBlobStore(
  database: SQLiteDatabasePort,
): Promise<BlobStore> {
  const catalog = await createMobileBlobCatalog(database);
  const store = createMobileBlobStore(createExpoBlobFilePort(), catalog);
  await store.recoverImports();
  return store;
}

export async function recoverMobileBlobImports(
  store: BlobStore,
): Promise<void> {
  await store.recoverImports();
}
