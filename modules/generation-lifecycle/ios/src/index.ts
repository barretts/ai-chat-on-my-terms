import { RunEventSchema, type RunEvent } from "@locallab/contracts/run-events";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export type GenerationState =
  | "running"
  | "remote_pending"
  | "interrupted"
  | "completed"
  | "canceled"
  | "failed";

export interface GenerationSnapshot {
  readonly runId: string;
  readonly conversationId: string;
  readonly execution: "local" | "remote";
  readonly remoteJobId?: string;
  readonly state: GenerationState;
  readonly lastSequence: number;
  readonly partialText: string;
  readonly partialReasoning: string;
  readonly updatedAt: string;
}

export interface NotificationSafeProgress {
  readonly runId: string;
  readonly state: GenerationState;
  readonly partialCharacters: number;
  readonly updatedAt: string;
}

export interface GenerationNotifications {
  publish(progress: NotificationSafeProgress): Promise<void> | void;
}

export interface ShortBackgroundExecution {
  begin(input: {
    readonly runId: string;
    readonly maximumDurationMs: number;
    readonly onExpiration: () => Promise<void>;
  }): Promise<unknown>;
  end(token: unknown): Promise<void> | void;
}

export interface RemoteRunReconciler {
  reconcile(remoteJobId: string, signal: AbortSignal): AsyncIterable<RunEvent>;
}

export interface GenerationLifecycleOptions {
  readonly notifications?: GenerationNotifications;
  readonly backgroundExecution?: ShortBackgroundExecution;
  readonly remoteRuns?: RemoteRunReconciler;
  readonly stopLocal?: (runId: string) => Promise<void> | void;
  readonly now?: () => string;
  readonly progressCharacterInterval?: number;
}

type LifecycleRow = {
  run_id: string;
  conversation_id: string;
  execution: "local" | "remote";
  remote_job_id: string | null;
  state: GenerationState;
  last_sequence: number;
  partial_text: string;
  partial_reasoning: string;
  updated_at: string;
  last_notified_characters: number;
};

const terminal = new Set<GenerationState>(["completed", "canceled", "failed"]);

/** Durable lifecycle bookkeeping around generation already owned by ChatEngine. */
export class SQLiteGenerationLifecycle {
  private readonly now: () => string;
  private readonly progressInterval: number;
  private readonly localStops = new Map<string, () => Promise<void> | void>();

  constructor(
    private readonly db: SQLiteDatabasePort,
    private readonly options: GenerationLifecycleOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.progressInterval = Math.max(
      1,
      options.progressCharacterInterval ?? 160,
    );
  }

  async initialize(): Promise<void> {
    await this.db.execAsync(`
      CREATE TABLE IF NOT EXISTS generation_lifecycle (
        run_id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        execution TEXT NOT NULL CHECK (execution IN ('local','remote')),
        remote_job_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('running','remote_pending','interrupted','completed','canceled','failed')),
        last_sequence INTEGER NOT NULL DEFAULT -1 CHECK (last_sequence >= -1),
        partial_text TEXT NOT NULL DEFAULT '',
        partial_reasoning TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        last_notified_characters INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS generation_lifecycle_conversation_updated
      ON generation_lifecycle(conversation_id, updated_at);
    `);
  }

  async start(input: {
    runId: string;
    conversationId: string;
    execution: "local" | "remote";
    remoteJobId?: string;
    stop?: () => Promise<void> | void;
  }): Promise<GenerationSnapshot> {
    const timestamp = this.now();
    const stop =
      input.stop ??
      (input.execution === "local" && this.options.stopLocal
        ? () => this.options.stopLocal!(input.runId)
        : undefined);
    let snapshot!: GenerationSnapshot;
    let previousStop: (() => Promise<void> | void) | undefined;
    let registered = false;
    try {
      await this.db.withTransactionAsync(async (transaction) => {
        const scopedDb = transaction ?? this.db;
        await scopedDb.runAsync(
          `INSERT INTO generation_lifecycle
        (run_id,conversation_id,execution,remote_job_id,state,updated_at)
       VALUES (?,?,?,?, 'running', ?)
       ON CONFLICT(run_id) DO NOTHING`,
          input.runId,
          input.conversationId,
          input.execution,
          input.remoteJobId ?? null,
          timestamp,
        );
        const row = await this.row(input.runId, scopedDb);
        if (!row || row.conversation_id !== input.conversationId)
          throw new Error(
            "Run identity is already bound to another conversation",
          );
        snapshot = decode(row);
        // Register before releasing the DB queue so a queued suspension can stop it.
        if (stop && snapshot.state === "running") {
          previousStop = this.localStops.get(input.runId);
          this.localStops.set(input.runId, stop);
          registered = true;
        }
      });
    } catch (error) {
      if (registered && this.localStops.get(input.runId) === stop) {
        if (previousStop) this.localStops.set(input.runId, previousStop);
        else this.localStops.delete(input.runId);
      }
      throw error;
    }
    await this.notify(snapshot, true);
    return snapshot;
  }

  async record(event: RunEvent): Promise<boolean> {
    const parsed = RunEventSchema.parse(event);
    let updated: LifecycleRow | null = null;
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      const row = await this.row(parsed.runId, scopedDb);
      if (!row) throw new Error("Generation lifecycle has not been started");
      if (row.state !== "running" || parsed.sequence <= row.last_sequence)
        return;
      const state = stateForEvent(parsed);
      await scopedDb.runAsync(
        `UPDATE generation_lifecycle SET
          state=?, last_sequence=?, partial_text=?, partial_reasoning=?, updated_at=?
         WHERE run_id=? AND state='running' AND last_sequence < ?`,
        state,
        parsed.sequence,
        row.partial_text + (parsed.type === "TextDelta" ? parsed.text : ""),
        row.partial_reasoning +
          (parsed.type === "ReasoningDelta" ? parsed.text : ""),
        this.now(),
        parsed.runId,
        parsed.sequence,
      );
      updated = await this.row(parsed.runId, scopedDb);
    });
    if (!updated) return false;
    const snapshot = decode(updated);
    await this.notify(snapshot, isStateTerminal(snapshot.state));
    if (isStateTerminal(snapshot.state)) this.localStops.delete(parsed.runId);
    return true;
  }

  /** Persist suspension honestly; local inference is not reported as resumable. */
  async suspend(runId: string): Promise<GenerationSnapshot | null> {
    let changed = false;
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      const current = await this.row(runId, scopedDb);
      if (!current || current.state !== "running") return;
      const state: GenerationState =
        current.execution === "remote" && current.remote_job_id
          ? "remote_pending"
          : "interrupted";
      await scopedDb.runAsync(
        "UPDATE generation_lifecycle SET state=?,updated_at=? WHERE run_id=? AND state='running'",
        state,
        this.now(),
        runId,
      );
      changed = true;
    });
    if (!changed) return this.get(runId);
    const row = await this.row(runId);
    if (!row) return null;
    const stop = this.localStops.get(runId);
    this.localStops.delete(runId);
    // A plain provider stream has no durable remote job to resume after suspension.
    if (row.state === "interrupted" && stop) await stop();
    const snapshot = decode(row);
    await this.notify(snapshot, true);
    return snapshot;
  }

  async cancel(runId: string): Promise<GenerationSnapshot | null> {
    let changed = false;
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      const current = await this.row(runId, scopedDb);
      if (!current || current.state !== "running") return;
      await scopedDb.runAsync(
        "UPDATE generation_lifecycle SET state='canceled',updated_at=? WHERE run_id=? AND state='running'",
        this.now(),
        runId,
      );
      changed = true;
    });
    const row = changed ? await this.row(runId) : null;
    const stop = this.localStops.get(runId);
    this.localStops.delete(runId);
    if (stop) await stop();
    if (!row) return this.get(runId);
    const snapshot = decode(row);
    await this.notify(snapshot, true);
    return snapshot;
  }

  /** Only remote jobs with durable IDs can be reconciled after suspension. */
  async resume(
    runId: string,
    signal = new AbortController().signal,
  ): Promise<GenerationSnapshot | null> {
    const snapshot = await this.get(runId);
    if (!snapshot) return null;
    if (snapshot.state !== "remote_pending" || !snapshot.remoteJobId)
      return snapshot;
    if (!this.options.remoteRuns)
      throw new Error("Remote generation reconciliation is unavailable");
    await this.db.runAsync(
      "UPDATE generation_lifecycle SET state='running',updated_at=? WHERE run_id=? AND state='remote_pending'",
      this.now(),
      runId,
    );
    for await (const event of this.options.remoteRuns.reconcile(
      snapshot.remoteJobId,
      signal,
    )) {
      if (signal.aborted) break;
      await this.record(event);
    }
    return this.get(runId);
  }

  /** The native bridge decides whether iOS granted the requested short window. */
  async withShortBackgroundWindow<T>(
    runId: string,
    work: () => Promise<T>,
    requestedMs = 20_000,
  ): Promise<T> {
    const background = this.options.backgroundExecution;
    if (!background) return work();
    const maximumDurationMs = Math.max(1, Math.min(25_000, requestedMs));
    let expired = false;
    const token = await background.begin({
      runId,
      maximumDurationMs,
      onExpiration: async () => {
        expired = true;
        await this.suspend(runId);
      },
    });
    try {
      const result = await work();
      if (expired) throw new Error("Background execution window expired");
      return result;
    } finally {
      await background.end(token);
    }
  }

  async get(runId: string): Promise<GenerationSnapshot | null> {
    const row = await this.row(runId);
    return row ? decode(row) : null;
  }

  private async row(runId: string, db = this.db): Promise<LifecycleRow | null> {
    return db.getFirstAsync<LifecycleRow>(
      "SELECT * FROM generation_lifecycle WHERE run_id=?",
      runId,
    );
  }

  private async notify(
    snapshot: GenerationSnapshot,
    force: boolean,
  ): Promise<void> {
    if (!this.options.notifications) return;
    const total =
      snapshot.partialText.length + snapshot.partialReasoning.length;
    const row = await this.row(snapshot.runId);
    if (
      !force &&
      row &&
      total - row.last_notified_characters < this.progressInterval
    )
      return;
    if (row)
      await this.db.runAsync(
        "UPDATE generation_lifecycle SET last_notified_characters=? WHERE run_id=?",
        total,
        snapshot.runId,
      );
    await this.options.notifications.publish({
      runId: snapshot.runId,
      state: snapshot.state,
      partialCharacters: total,
      updatedAt: snapshot.updatedAt,
    });
  }
}

function decode(row: LifecycleRow): GenerationSnapshot {
  return {
    runId: row.run_id,
    conversationId: row.conversation_id,
    execution: row.execution,
    ...(row.remote_job_id ? { remoteJobId: row.remote_job_id } : {}),
    state: row.state,
    lastSequence: row.last_sequence,
    partialText: row.partial_text,
    partialReasoning: row.partial_reasoning,
    updatedAt: row.updated_at,
  };
}

function stateForEvent(event: RunEvent): GenerationState {
  switch (event.type) {
    case "RunCompleted":
      return "completed";
    case "RunCanceled":
      return "canceled";
    case "RunFailed":
      return "failed";
    default:
      return "running";
  }
}

function isStateTerminal(state: GenerationState): boolean {
  return terminal.has(state);
}
