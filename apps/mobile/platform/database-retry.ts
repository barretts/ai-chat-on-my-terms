/** Native initialization can retry against the existing process and connection manager. */
export function retryMobileDatabaseOpen(reinitialize: () => void): void {
  reinitialize();
}
