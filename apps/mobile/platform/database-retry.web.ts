/** A failed OPFS open can poison Expo SQLite's worker VFS; reload creates a fresh worker. */
export function retryMobileDatabaseOpen(_reinitialize: () => void): void {
  globalThis.location.reload();
}
