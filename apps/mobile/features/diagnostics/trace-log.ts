import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { diagnosticOrigin, sanitizeDiagnosticText } from "./sanitization";

export const TRACE_LIMIT = 250;
export interface TraceMetadata {
  code?: string;
  status?: number;
  endpoint?: string;
  durationMs?: number;
  method?: string;
  errorName?: string;
}
export interface TraceEntry {
  time: string;
  operation: string;
  phase: "start" | "complete" | "failed" | "cancelled" | "info";
  detail: TraceMetadata;
}
export interface TraceSnapshot {
  enabled: boolean;
  ready: boolean;
  entries: readonly TraceEntry[];
  storageError: string;
}

const phases = new Set(["start", "complete", "failed", "cancelled", "info"]);
const errorCodes = new Set([
  "missing",
  "host-mismatch",
  "secure-store",
  "invalid-header",
  "invalid-origin",
  "invalid-host",
  "network",
  "timeout",
  "aborted",
  "auth",
  "unauthorized",
  "quota",
  "permission",
  "malformed",
  "http",
  "rate-limit",
  "not-found",
  "invalid-model",
  "model-unavailable",
  "storage",
  "attachment",
  "unsupported",
  "cancelled",
  "forbidden",
  "offline",
  "canceled",
  "host_not_authorized",
  "cleartext_not_authorized",
  "redirect_rejected",
  "redirect_limit",
  "malformed_stream",
  "stream_too_large",
  "web-research",
  "feature-failed",
  "generation-failed",
  "missing-model",
  "host-stopped",
  "context-full",
  "empty-message",
  "invalid-file",
  "invalid-folder",
  "unsafe-path",
  "io",
  "SQLITE_FULL",
  "SQLITE_BUSY",
  "SQLITE_CORRUPT",
  "ENOENT",
  "ENOSPC",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
]);
const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "AbortError",
  "TimeoutError",
  "SecretStoreError",
  "ChatIntegrationError",
  "ChatAttachmentIntakeError",
  "WebResearchError",
  "HttpTransportError",
  "ModelImportError",
  "DOMException",
]);
function safeMetadata(input: TraceMetadata): TraceMetadata {
  const detail: TraceMetadata = {};
  if (input.code)
    detail.code = errorCodes.has(input.code) ? input.code : "other";
  if (input.errorName)
    detail.errorName = errorNames.has(input.errorName)
      ? input.errorName
      : "Error";
  if (
    Number.isInteger(input.status) &&
    input.status! >= 100 &&
    input.status! <= 599
  )
    detail.status = input.status!;
  if (Number.isFinite(input.durationMs) && input.durationMs! >= 0)
    detail.durationMs = Math.round(input.durationMs!);
  if (
    input.method &&
    /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(input.method)
  )
    detail.method = input.method;
  const endpoint = input.endpoint && diagnosticOrigin(input.endpoint);
  if (endpoint) detail.endpoint = endpoint;
  return detail;
}

/** Opt-in, bounded, device-local metadata. Never accepts messages, bodies or headers. */
export class TraceLogger {
  private snapshot: TraceSnapshot = {
    enabled: false,
    ready: false,
    entries: [],
    storageError: "",
  };
  private listeners = new Set<() => void>();
  private database?: SQLiteDatabasePort;
  private writes = Promise.resolve();
  getSnapshot = (): TraceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: TraceSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  async initialize(database: SQLiteDatabasePort): Promise<void> {
    if (this.snapshot.ready) return;
    await database.execAsync(
      "CREATE TABLE IF NOT EXISTS local_diagnostics (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, entries TEXT NOT NULL)",
    );
    const row = await database.getFirstAsync<{
      enabled: number;
      entries: string;
    }>("SELECT enabled, entries FROM local_diagnostics WHERE id=1");
    this.database = database;
    let entries: TraceEntry[] = [];
    if (row) {
      try {
        const parsed: unknown = JSON.parse(row.entries);
        if (Array.isArray(parsed))
          entries = parsed
            .flatMap((item: unknown) => {
              if (!item || typeof item !== "object") return [];
              const entry = item as TraceEntry;
              if (
                typeof entry.time !== "string" ||
                !Number.isFinite(Date.parse(entry.time)) ||
                typeof entry.operation !== "string" ||
                !phases.has(entry.phase)
              )
                return [];
              return [
                {
                  time: entry.time,
                  operation: sanitizeDiagnosticText(entry.operation).slice(
                    0,
                    120,
                  ),
                  phase: entry.phase,
                  detail: safeMetadata(entry.detail ?? {}),
                },
              ];
            })
            .slice(-TRACE_LIMIT);
      } catch {
        this.publish({
          ready: true,
          enabled: false,
          entries: [],
          storageError:
            "The saved trace log is unreadable. Clear the trace log to start a new recording.",
        });
        return;
      }
    }
    this.database = database;
    this.publish({
      ready: true,
      enabled: row?.enabled === 1,
      entries,
      storageError: "",
    });
    this.event("Application session", "info");
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.database)
      throw new Error(
        "Diagnostic storage is not ready. Retry opening the trace log.",
      );
    const next = { ...this.snapshot, enabled, storageError: "" };
    const previousEnabled = this.snapshot.enabled;
    this.publish(next);
    try {
      await this.queueSave(next);
    } catch (cause) {
      this.publish({ ...this.snapshot, enabled: previousEnabled });
      throw cause;
    }
    if (enabled) this.event("Trace recording", "start");
  }
  event(
    operation: string,
    phase: TraceEntry["phase"],
    metadata: TraceMetadata = {},
  ): void {
    if (!this.snapshot.enabled || !phases.has(phase)) return;
    const entry: TraceEntry = {
      time: new Date().toISOString(),
      operation: sanitizeDiagnosticText(operation).slice(0, 120),
      phase,
      detail: safeMetadata(metadata),
    };
    const next = {
      ...this.snapshot,
      entries: [...this.snapshot.entries, entry].slice(-TRACE_LIMIT),
    };
    this.publish(next);
    void this.queueSave(next).catch((error: unknown) => {
      this.publish({
        ...this.snapshot,
        storageError: `Trace log could not be saved. ${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))} Free storage space, then retry recording.`,
      });
    });
  }
  async clear(): Promise<void> {
    if (!this.database)
      throw new Error(
        "Diagnostic storage is not ready. Retry opening the trace log.",
      );
    const next = { ...this.snapshot, entries: [], storageError: "" };
    const previousEntries = this.snapshot.entries;
    this.publish(next);
    try {
      await this.queueSave(next);
    } catch (cause) {
      this.publish({
        ...this.snapshot,
        entries: [...previousEntries, ...this.snapshot.entries].slice(
          -TRACE_LIMIT,
        ),
      });
      throw cause;
    }
  }
  async flush(): Promise<void> {
    await this.writes;
  }
  export(): string {
    return JSON.stringify(
      {
        format: "LocalLab trace v1",
        exportedAt: new Date().toISOString(),
        recording: this.snapshot.enabled,
        entries: this.snapshot.entries,
      },
      null,
      2,
    );
  }
  private queueSave(snapshot: TraceSnapshot): Promise<void> {
    const database = this.database;
    if (!database)
      return Promise.reject(new Error("Diagnostic storage is not ready."));
    const write = this.writes
      .then(() =>
        database.runAsync(
          "INSERT INTO local_diagnostics(id,enabled,entries) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, entries=excluded.entries",
          snapshot.enabled ? 1 : 0,
          JSON.stringify(snapshot.entries),
        ),
      )
      .then(() => undefined);
    this.writes = write.catch(() => undefined);
    return write;
  }
}

export const traceLog = new TraceLogger();
