import type { JobRecord, JobScheduler } from "@locallab/jobs";
import {
  MediaBackendError,
  type MediaBackendPort,
  type MediaSnapshot,
} from "@locallab/media-engine";

type DbPort = {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
};

export interface ServerJobLedger {
  initialize(): Promise<void>;
  record(jobId: string, serverJobId: string, backend: string): Promise<void>;
  lookup(jobId: string): Promise<string | undefined>;
  clear(jobId: string): Promise<void>;
}

export class MemoryServerJobLedger implements ServerJobLedger {
  private rows = new Map<string, { serverJobId: string; backend: string }>();
  async initialize(): Promise<void> {}
  async record(jobId: string, serverJobId: string, backend: string): Promise<void> {
    this.rows.set(jobId, { serverJobId, backend });
  }
  async lookup(jobId: string): Promise<string | undefined> {
    return this.rows.get(jobId)?.serverJobId;
  }
  async clear(jobId: string): Promise<void> {
    this.rows.delete(jobId);
  }
}

/** Durable jobId -> server job id map so reconnects never resubmit. */
export class SqliteServerJobLedger implements ServerJobLedger {
  constructor(private readonly db: DbPort) {}
  async initialize(): Promise<void> {
    await this.db.execAsync(`
      CREATE TABLE IF NOT EXISTS media_server_jobs (
        job_id TEXT PRIMARY KEY NOT NULL,
        server_job_id TEXT NOT NULL,
        backend TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }
  async record(jobId: string, serverJobId: string, backend: string): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO media_server_jobs (job_id, server_job_id, backend)
       VALUES (?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         server_job_id = excluded.server_job_id,
         backend = excluded.backend,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      jobId,
      serverJobId,
      backend,
    );
  }
  async lookup(jobId: string): Promise<string | undefined> {
    const row = await this.db.getFirstAsync<{ server_job_id: string }>(
      `SELECT server_job_id FROM media_server_jobs WHERE job_id = ?`,
      jobId,
    );
    return row ? row.server_job_id : undefined;
  }
  async clear(jobId: string): Promise<void> {
    await this.db.runAsync(`DELETE FROM media_server_jobs WHERE job_id = ?`, jobId);
  }
}

/**
 * Wraps a media backend with: (1) a hard bound on concurrent remote
 * submissions and (2) ledger-backed reconnect recovery that re-attaches to
 * an already-submitted server job instead of resubmitting.
 */
export class RecoveringMediaBackend implements MediaBackendPort {
  private inFlight = 0;
  constructor(
    private readonly inner: MediaBackendPort,
    private readonly ledger: ServerJobLedger,
    private readonly backendName: string,
    private readonly maxConcurrentRemote = 1,
  ) {}

  get remoteInFlight(): number {
    return this.inFlight;
  }

  async generate(context: {
    snapshot: MediaSnapshot;
    jobId: string;
    signal: AbortSignal;
    reportProgress(progress: number): Promise<void>;
    reportServerJob(serverJobId: string): void;
  }): Promise<{ outputRefs: string[] }> {
    await this.ledger.initialize();
    const existing = await this.ledger.lookup(context.jobId);
    if (existing !== undefined && this.inner.resume) {
      const resumed = await this.inner.resume({
        serverJobId: existing,
        snapshot: context.snapshot,
        signal: context.signal,
        reportProgress: context.reportProgress,
      });
      await this.ledger.clear(context.jobId);
      return resumed;
    }
    if (this.inFlight >= this.maxConcurrentRemote)
      throw new MediaBackendError({
        code: "quota",
        message: `Already ${this.maxConcurrentRemote} generation(s) in flight on ${this.backendName}; retry when one finishes.`,
        recoverable: true,
        backend: this.backendName,
      });
    this.inFlight++;
    try {
      const result = await this.inner.generate({
        ...context,
        reportServerJob: (serverJobId) => {
          void this.ledger.record(context.jobId, serverJobId, this.backendName);
          context.reportServerJob(serverJobId);
        },
      });
      await this.ledger.clear(context.jobId);
      return result;
    } finally {
      this.inFlight--;
    }
  }
}

export interface MediaQueueRow {
  jobId: string;
  state: JobRecord["state"];
  progress: number | null;
  attempt: number;
  serverJobId?: string;
}

/** UI-facing queue view: status + cancellation over the durable job store. */
export async function mediaQueueRows(
  scheduler: JobScheduler,
  ledger: ServerJobLedger,
): Promise<MediaQueueRow[]> {
  await ledger.initialize();
  const rows: MediaQueueRow[] = [];
  for (const job of await scheduler.list()) {
    const serverJobId = await ledger.lookup(job.id);
    rows.push({
      jobId: job.id,
      state: job.state,
      progress: job.progress,
      attempt: job.attempt,
      ...(serverJobId === undefined ? {} : { serverJobId }),
    });
  }
  return rows;
}
