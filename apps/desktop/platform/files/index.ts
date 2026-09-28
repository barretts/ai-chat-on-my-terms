import {
  BlobStore,
  type BlobCatalogPort,
  type BlobFilePort,
} from "@locallab/storage-blobs";

/**
 * Tauri adapter boundary. Implement managed operations with the app data directory
 * through the Tauri filesystem plugin or a scoped Rust command. readExternal should
 * use a dialog-granted read handle; this API exposes no operation that mutates it.
 */
export interface TauriBlobFileBridge extends BlobFilePort {}

export function createDesktopBlobStore(
  bridge: TauriBlobFileBridge,
  catalog: BlobCatalogPort,
): BlobStore {
  return new BlobStore(bridge, catalog, "locallab/blobs");
}

/** Call during desktop startup once the local database is ready. */
export async function recoverDesktopBlobImports(
  store: BlobStore,
): Promise<void> {
  await store.recoverImports();
}
