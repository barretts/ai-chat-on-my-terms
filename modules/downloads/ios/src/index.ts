import type { JobHandler } from "@locallab/jobs";
import type { BlobMetadata } from "@locallab/storage-blobs";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export type DownloadState =
  | "queued"
  | "running"
  | "paused"
  | "verifying"
  | "completed"
  | "canceled"
  | "failed";

/** The native bridge persists opaque URLSession task identifiers in taskDescription. */
export interface BackgroundTransferBridge {
  create(url: string, transferId: string): Promise<{ taskId: string }>;
  resume(
    taskId: string,
    resumeData?: string,
  ): Promise<{ taskId?: string } | void>;
  cancel(taskId: string): Promise<void>;
  pause(taskId: string): Promise<{ resumeData?: string }>;
  enumerate(): Promise<readonly NativeTransferSnapshot[]>;
  subscribe(listener: (event: NativeTransferEvent) => void): () => void;
}

export interface NativeTransferSnapshot {
  taskId: string;
  transferId?: string;
  state: "running" | "suspended" | "completed" | "canceled" | "failed";
  receivedBytes: number;
  expectedBytes?: number;
  temporaryPath?: string;
  errorCode?: string;
}

export type NativeTransferEvent =
  | {
      type: "progress";
      taskId: string;
      receivedBytes: number;
      expectedBytes?: number;
    }
  | { type: "completed"; taskId: string; temporaryPath: string }
  | { type: "failed"; taskId: string; errorCode: string }
  | { type: "canceled"; taskId: string };

export interface DownloadRecord {
  id: string;
  taskId?: string;
  url: string;
  filename: string;
  expectedBytes: number;
  expectedSha256: string;
  receivedBytes: number;
  state: DownloadState;
  resumeData?: string;
  errorCode?: string;
  updatedAt: string;
}

export interface DownloadRepository {
  get(id: string): Promise<DownloadRecord | undefined>;
  list(): Promise<readonly DownloadRecord[]>;
  save(record: DownloadRecord): Promise<void>;
}

/** SQLite persistence for task identifiers, resume data, and reconciliation state. */
export class SQLiteDownloadRepository implements DownloadRepository {
  constructor(private readonly db: SQLiteDatabasePort) {}

  async initialize(): Promise<void> {
    await this.db.execAsync(`
      CREATE TABLE IF NOT EXISTS ios_model_downloads (
        id TEXT PRIMARY KEY NOT NULL,
        record_json TEXT NOT NULL,
        task_id TEXT,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ios_model_downloads_state
        ON ios_model_downloads(state, updated_at);
      CREATE INDEX IF NOT EXISTS ios_model_downloads_task
        ON ios_model_downloads(task_id);
    `);
  }

  async get(id: string): Promise<DownloadRecord | undefined> {
    const row = await this.db.getFirstAsync<{ record_json: string }>(
      "SELECT record_json FROM ios_model_downloads WHERE id = ?",
      id,
    );
    return row ? parseDownloadRecord(row.record_json) : undefined;
  }

  async list(): Promise<readonly DownloadRecord[]> {
    const rows = await this.db.getAllAsync<{ record_json: string }>(
      "SELECT record_json FROM ios_model_downloads ORDER BY updated_at, id",
    );
    return rows.map((row) => parseDownloadRecord(row.record_json));
  }

  async save(record: DownloadRecord): Promise<void> {
    const normalized = { ...record };
    await this.db.runAsync(
      `INSERT INTO ios_model_downloads (id, record_json, task_id, state, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,
       task_id=excluded.task_id, state=excluded.state, updated_at=excluded.updated_at`,
      normalized.id,
      JSON.stringify(normalized),
      normalized.taskId ?? null,
      normalized.state,
      normalized.updatedAt,
    );
  }
}

export interface DownloadFiles {
  /** Only returns a temporary file URL owned by the app's background session. */
  inspect(path: string): Promise<{ byteLength: number; sha256: string }>;
  /** Atomic move into app-private model storage; called only after verification. */
  promote(path: string, filename: string): Promise<string>;
  discard(path: string): Promise<void>;
}

export interface ModelRegistrar {
  register(input: {
    id: string;
    filename: string;
    managedPath: string;
    byteLength: number;
    sha256: string;
  }): Promise<BlobMetadata>;
}

/** A deliberately notification-safe projection: no URL, filename, hash, or credentials. */
export interface DownloadStatus {
  id: string;
  state: DownloadState;
  receivedBytes: number;
  expectedBytes: number;
  progress: number;
  errorCode?: string;
}

export interface DownloadStatusSink {
  publish(status: DownloadStatus): Promise<void>;
}

export interface IOSDownloadsOptions {
  bridge: BackgroundTransferBridge;
  repository: DownloadRepository;
  files: DownloadFiles;
  models: ModelRegistrar;
  status?: DownloadStatusSink;
  now?: () => string;
}

/**
 * Coordinates URLSession tasks with durable app records. Create after SQLite opens,
 * call reconcile() at startup, and retain the returned disposer for app lifetime.
 */
export class IOSBackgroundDownloads {
  private readonly now: () => string;
  private readonly unsubscribe: () => void;
  private readonly byTask = new Map<string, string>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: IOSDownloadsOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.unsubscribe = options.bridge.subscribe((event) => {
      const work = this.handle(event).catch(() => undefined);
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    });
  }

  async start(input: {
    id: string;
    url: string;
    filename: string;
    expectedBytes: number;
    expectedSha256: string;
  }): Promise<void> {
    validateInput(input);
    const prior = await this.options.repository.get(input.id);
    if (prior && prior.state !== "canceled" && prior.state !== "failed")
      throw new Error("A download with this ID already exists");
    const record: DownloadRecord = {
      ...input,
      receivedBytes: 0,
      state: "queued",
      updatedAt: this.now(),
    };
    await this.options.repository.save(record);
    const { taskId } = await this.options.bridge.create(input.url, input.id);
    this.byTask.set(taskId, input.id);
    // Persist task identity before resume so relaunch reconciliation can find it.
    await this.save({ ...record, taskId, state: "running" });
    await this.options.bridge.resume(taskId);
    await this.publish({ ...record, taskId, state: "running" });
  }

  async pause(id: string): Promise<void> {
    const record = await this.require(id);
    if (!record.taskId || record.state !== "running") return;
    const paused = await this.options.bridge.pause(record.taskId);
    const { resumeData: _oldResumeData, ...withoutResumeData } = record;
    await this.save({
      ...withoutResumeData,
      ...(paused.resumeData ? { resumeData: paused.resumeData } : {}),
      state: "paused",
    });
  }

  async resume(id: string): Promise<void> {
    const record = await this.require(id);
    if (!record.taskId || !["paused", "queued"].includes(record.state)) return;
    const resumed = await this.options.bridge.resume(
      record.taskId,
      record.resumeData,
    );
    const { resumeData: _resumeData, ...withoutResumeData } = record;
    const taskId = resumed?.taskId ?? record.taskId;
    this.byTask.set(taskId, id);
    await this.save({ ...withoutResumeData, taskId, state: "running" });
  }

  async cancel(id: string): Promise<void> {
    const record = await this.require(id);
    if (record.taskId) await this.options.bridge.cancel(record.taskId);
    const { resumeData: _resumeData, ...withoutResumeData } = record;
    await this.save({ ...withoutResumeData, state: "canceled" });
  }

  /** Joins persisted app rows to URLSession's live tasks after process relaunch. */
  async reconcile(): Promise<void> {
    const [records, native] = await Promise.all([
      this.options.repository.list(),
      this.options.bridge.enumerate(),
    ]);
    const nativeById = new Map<string, NativeTransferSnapshot>();
    for (const task of native)
      if (task.transferId) nativeById.set(task.transferId, task);
    const knownNativeTasks = new Set<string>();
    for (const record of records) {
      if (["completed", "canceled", "failed"].includes(record.state)) continue;
      const task =
        nativeById.get(record.id) ??
        native.find((item) => item.taskId === record.taskId);
      if (!task) {
        const { taskId: _taskId, ...withoutTask } = record;
        await this.save({
          ...withoutTask,
          state: record.state === "paused" ? "paused" : "queued",
        });
        continue;
      }
      knownNativeTasks.add(task.taskId);
      this.byTask.set(task.taskId, record.id);
      const merged = {
        ...record,
        taskId: task.taskId,
        receivedBytes: safeBytes(task.receivedBytes),
      };
      if (task.state === "completed" && task.temporaryPath)
        await this.complete(merged, task.temporaryPath);
      else if (task.state === "failed")
        await this.fail(merged, task.errorCode ?? "transfer-failed");
      else if (task.state === "canceled")
        await this.save({ ...merged, state: "canceled" });
      else
        await this.save({
          ...merged,
          state: task.state === "suspended" ? "paused" : "running",
        });
    }
    // Orphan tasks cannot be attached safely to a model record; cancel them.
    for (const task of native)
      if (!knownNativeTasks.has(task.taskId) && task.state !== "completed")
        await this.options.bridge.cancel(task.taskId);
  }

  async flushEvents(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  dispose(): void {
    this.unsubscribe();
  }

  async getStatus(id: string): Promise<DownloadStatus> {
    const record = await this.require(id);
    return this.toStatus(record);
  }

  private async handle(event: NativeTransferEvent): Promise<void> {
    const id = this.byTask.get(event.taskId);
    if (!id) return;
    const record = await this.options.repository.get(id);
    if (!record || record.taskId !== event.taskId) return;
    if (event.type === "progress") {
      const receivedBytes = safeBytes(event.receivedBytes);
      await this.save({ ...record, receivedBytes, state: "running" });
    } else if (event.type === "completed")
      await this.complete(record, event.temporaryPath);
    else if (event.type === "failed")
      await this.fail(record, safeCode(event.errorCode));
    else await this.save({ ...record, state: "canceled" });
  }

  private async complete(
    record: DownloadRecord,
    temporaryPath: string,
  ): Promise<void> {
    await this.save({ ...record, state: "verifying" });
    try {
      const result = await this.options.files.inspect(temporaryPath);
      if (result.byteLength !== record.expectedBytes)
        throw Object.assign(new Error("download-size-mismatch"), {
          code: "size-mismatch",
        });
      if (result.sha256.toLowerCase() !== record.expectedSha256.toLowerCase())
        throw Object.assign(new Error("download-hash-mismatch"), {
          code: "hash-mismatch",
        });
      const managedPath = await this.options.files.promote(
        temporaryPath,
        record.filename,
      );
      await this.options.models.register({
        id: record.id,
        filename: record.filename,
        managedPath,
        byteLength: result.byteLength,
        sha256: result.sha256,
      });
      const { errorCode: _errorCode, ...withoutError } = record;
      await this.save({
        ...withoutError,
        receivedBytes: result.byteLength,
        state: "completed",
      });
    } catch (error) {
      await this.options.files.discard(temporaryPath).catch(() => undefined);
      await this.fail(
        record,
        error instanceof Error && "code" in error
          ? String(error.code)
          : "verification-failed",
      );
    }
  }

  private async fail(record: DownloadRecord, errorCode: string): Promise<void> {
    await this.save({
      ...record,
      state: "failed",
      errorCode: safeCode(errorCode),
    });
  }

  private async require(id: string): Promise<DownloadRecord> {
    const record = await this.options.repository.get(id);
    if (!record) throw new Error("Download not found");
    return record;
  }

  private async save(record: DownloadRecord): Promise<void> {
    const updated = { ...record, updatedAt: this.now() };
    await this.options.repository.save(updated);
    await this.publish(updated);
  }

  private async publish(record: DownloadRecord): Promise<void> {
    await this.options.status?.publish(this.toStatus(record));
  }

  private toStatus(record: DownloadRecord): DownloadStatus {
    return {
      id: record.id,
      state: record.state,
      receivedBytes: safeBytes(record.receivedBytes),
      expectedBytes: record.expectedBytes,
      progress: record.expectedBytes
        ? Math.min(1, safeBytes(record.receivedBytes) / record.expectedBytes)
        : 0,
      ...(record.errorCode ? { errorCode: safeCode(record.errorCode) } : {}),
    };
  }
}

/** JobScheduler-compatible adapter; cancellation is forwarded to URLSession. */
export function createDownloadJobHandler(
  downloads: IOSBackgroundDownloads,
): JobHandler {
  return async (input, { signal, reportProgress }) => {
    if (
      !input ||
      typeof input !== "object" ||
      !("id" in input) ||
      !("url" in input) ||
      !("filename" in input) ||
      !("expectedBytes" in input) ||
      !("expectedSha256" in input)
    )
      throw new Error("Invalid download job input");
    const job = input as {
      id: string;
      url: string;
      filename: string;
      expectedBytes: number;
      expectedSha256: string;
    };
    const id = String(job.id);
    if (signal.aborted) return { canceled: true };
    const abort = () => {
      void downloads.cancel(id);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      try {
        await downloads.getStatus(id);
        await downloads.resume(id);
      } catch {
        await downloads.start(job);
      }
      while (true) {
        if (signal.aborted) return { id, canceled: true };
        const status = await downloads.getStatus(id);
        await reportProgress(status.progress);
        if (status.state === "completed") return { id, status: status.state };
        if (status.state === "canceled") return { id, canceled: true };
        if (status.state === "failed")
          throw new Error(status.errorCode ?? "download-failed");
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await reportProgress(1);
    }
  };
}

function validateInput(input: {
  id: string;
  url: string;
  filename: string;
  expectedBytes: number;
  expectedSha256: string;
}): void {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("Download URL must be absolute");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Model download URL must use credential-free HTTPS");
  if (
    !/^[\w.-]{1,160}$/.test(input.id) ||
    !/^[\w.-]{1,200}$/.test(input.filename)
  )
    throw new Error("Invalid download identity or filename");
  if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1)
    throw new Error("Expected download size must be positive");
  if (!/^[\da-f]{64}$/i.test(input.expectedSha256))
    throw new Error("Expected SHA-256 is invalid");
}
function safeBytes(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function safeCode(value: string): string {
  return /^[a-z0-9-]{1,64}$/i.test(value) ? value : "transfer-failed";
}

function parseDownloadRecord(value: string): DownloadRecord {
  const row = JSON.parse(value) as Partial<DownloadRecord>;
  if (
    typeof row.id !== "string" ||
    typeof row.url !== "string" ||
    typeof row.filename !== "string" ||
    typeof row.expectedBytes !== "number" ||
    typeof row.expectedSha256 !== "string" ||
    typeof row.receivedBytes !== "number" ||
    typeof row.updatedAt !== "string" ||
    ![
      "queued",
      "running",
      "paused",
      "verifying",
      "completed",
      "canceled",
      "failed",
    ].includes(String(row.state))
  )
    throw new Error("Stored iOS download record is malformed");
  return row as DownloadRecord;
}
