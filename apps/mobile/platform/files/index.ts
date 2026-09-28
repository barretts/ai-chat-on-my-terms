import {
  BlobStore,
  SQLiteBlobCatalog,
  type BlobCatalogPort,
  type BlobFilePort,
} from "@locallab/storage-blobs";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { Directory, File, Paths } from "expo-file-system";
import { mobileBlobCrypto } from "../crypto";

const MANAGED_ROOT = "locallab/blobs";

/** App-private Expo document storage; external picker URIs are only ever read. */
export class ExpoBlobFilePort implements BlobFilePort {
  constructor(private readonly managedRoot = MANAGED_ROOT) {}

  async readExternal(uri: string): Promise<Uint8Array> {
    if (!uri || uri.includes("\0")) throw new Error("Invalid external URI");
    return new File(uri).bytes();
  }

  async readManaged(path: string): Promise<Uint8Array> {
    return this.managedFile(path).bytes();
  }

  async writeManaged(path: string, bytes: Uint8Array): Promise<void> {
    const directory = this.directory();
    directory.create({ intermediates: true, idempotent: true });
    const file = this.managedFile(path);
    file.create({ intermediates: true, overwrite: true });
    file.write(bytes);
  }

  async moveManaged(source: string, destination: string): Promise<void> {
    const sourceFile = this.managedFile(source);
    const destinationFile = this.managedFile(destination);
    await sourceFile.move(destinationFile);
  }

  async removeManaged(path: string): Promise<void> {
    const file = this.managedFile(path);
    if (file.exists) file.delete();
  }

  async listManaged(prefix: string): Promise<readonly string[]> {
    const normalized = this.validateManagedPath(prefix, true);
    const directory = this.directory();
    if (!directory.exists) return [];
    return directory
      .list()
      .filter((entry): entry is File => entry instanceof File)
      .map((entry) => `${this.managedRoot}/${entry.name}`)
      .filter((path) => path.startsWith(normalized));
  }

  private directory(): Directory {
    return new Directory(Paths.document, ...this.managedRoot.split("/"));
  }

  private managedFile(path: string): File {
    const normalized = this.validateManagedPath(path, false);
    const filename = normalized.slice(this.managedRoot.length + 1);
    return new File(this.directory(), filename);
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

/** Create this once at startup, after the user has selected the external document. */
export function createExpoBlobFilePort(): ExpoBlobFilePort {
  return new ExpoBlobFilePort();
}

/** Initialize SQLite catalog tables; call before creating the BlobStore. */
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
  return new BlobStore(bridge, catalog, "locallab/blobs", mobileBlobCrypto);
}

/** Fully wired app-private files plus durable SQLite metadata for the mobile app. */
export async function openMobileBlobStore(
  database: SQLiteDatabasePort,
): Promise<BlobStore> {
  const catalog = await createMobileBlobCatalog(database);
  const store = createMobileBlobStore(createExpoBlobFilePort(), catalog);
  await store.recoverImports();
  return store;
}

/** Call once after the app SQLite catalog has opened, before displaying attachments. */
export async function recoverMobileBlobImports(
  store: BlobStore,
): Promise<void> {
  await store.recoverImports();
}
