import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { Revision } from "@locallab/contracts/identity";
import {
  JobRecordSchema,
  type CreateJobInput,
  type JobRecord,
  type JobState,
  type JobStore,
} from "./types.js";

type Row = {
  id: string;
  kind: string;
  category: JobRecord["category"];
  idempotency_key: string;
  input_json: string;
  state: JobState;
  progress: number | null;
  started_at: string | null;
  finished_at: string | null;
  attempt: number;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  revision_wall_ms: number;
  revision_counter: number;
  revision_device_id: string;
};

function decode(row: Row): JobRecord {
  return JobRecordSchema.parse({
    id: row.id,
    kind: row.kind,
    category: row.category,
    idempotencyKey: row.idempotency_key,
    input: JSON.parse(row.input_json) as unknown,
    state: row.state,
    progress: row.progress,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    attempt: row.attempt,
    ...(row.result_json === null
      ? {}
      : { result: JSON.parse(row.result_json) as unknown }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: {
      wallMs: row.revision_wall_ms,
      counter: row.revision_counter,
      deviceId: row.revision_device_id,
    },
  });
}

/** Transactional SQLite JobStore. Call only after schema migration 0003. */
export class SQLiteJobStore implements JobStore {
  constructor(private readonly db: SQLiteDatabasePort) {}

  async create(
    input: CreateJobInput,
    now: string,
    id: string,
    revision: Revision,
  ) {
    let result: { job: JobRecord; created: boolean } | undefined;
    await this.db.withTransactionAsync(async (transaction) => {
      const db = transaction ?? this.db;
      const existing = await db.getFirstAsync<Row>(
        "SELECT * FROM scheduled_jobs WHERE idempotency_key = ?",
        input.idempotencyKey,
      );
      if (existing) {
        result = { job: decode(existing), created: false };
        return;
      }
      await db.runAsync(
        `INSERT INTO scheduled_jobs (id,kind,category,idempotency_key,input_json,state,progress,started_at,finished_at,attempt,result_json,error,created_at,updated_at,revision_wall_ms,revision_counter,revision_device_id)
         VALUES (?,?,?,?,?,'queued',NULL,NULL,NULL,0,NULL,NULL,?,?,?,?,?)`,
        id,
        input.kind,
        input.category,
        input.idempotencyKey,
        JSON.stringify(input.input),
        now,
        now,
        revision.wallMs,
        revision.counter,
        revision.deviceId,
      );
      const row = await db.getFirstAsync<Row>(
        "SELECT * FROM scheduled_jobs WHERE id = ?",
        id,
      );
      if (!row) throw new Error("Inserted job could not be read back");
      result = { job: decode(row), created: true };
    });
    if (!result) throw new Error("Job creation transaction returned no record");
    return result;
  }

  async get(id: string) {
    const row = await this.db.getFirstAsync<Row>(
      "SELECT * FROM scheduled_jobs WHERE id = ?",
      id,
    );
    return row ? decode(row) : undefined;
  }

  async findByIdempotencyKey(key: string) {
    const row = await this.db.getFirstAsync<Row>(
      "SELECT * FROM scheduled_jobs WHERE idempotency_key = ?",
      key,
    );
    return row ? decode(row) : undefined;
  }

  async listNonterminal() {
    const rows = await this.db.getAllAsync<Row>(
      "SELECT * FROM scheduled_jobs WHERE state IN ('queued','running') ORDER BY created_at,id",
    );
    return rows.map(decode);
  }

  async listAll() {
    const rows = await this.db.getAllAsync<Row>(
      "SELECT * FROM scheduled_jobs ORDER BY created_at,id",
    );
    return rows.map(decode);
  }

  async transition(
    id: string,
    expected: readonly JobState[],
    update: Partial<JobRecord>,
  ) {
    let result: JobRecord | undefined;
    await this.db.withTransactionAsync(async (transaction) => {
      const db = transaction ?? this.db;
      const row = await db.getFirstAsync<Row>(
        "SELECT * FROM scheduled_jobs WHERE id = ?",
        id,
      );
      if (!row) return;
      const current = decode(row);
      if (!expected.includes(current.state)) return;
      const next = JobRecordSchema.parse({
        ...current,
        ...update,
        id: current.id,
        kind: current.kind,
        category: current.category,
        idempotencyKey: current.idempotencyKey,
        input: current.input,
        createdAt: current.createdAt,
      });
      const resultJson = Object.hasOwn(update, "result")
        ? JSON.stringify(update.result)
        : row.result_json;
      const error = Object.hasOwn(update, "error")
        ? (update.error ?? null)
        : row.error;
      await db.runAsync(
        `UPDATE scheduled_jobs SET state=?, progress=?, started_at=?, finished_at=?, attempt=?, result_json=?, error=?, updated_at=?, revision_wall_ms=?, revision_counter=?, revision_device_id=? WHERE id=? AND state=?`,
        next.state,
        next.progress,
        next.startedAt,
        next.finishedAt,
        next.attempt,
        resultJson,
        error,
        next.updatedAt,
        next.revision.wallMs,
        next.revision.counter,
        next.revision.deviceId,
        id,
        current.state,
      );
      const updated = await db.getFirstAsync<Row>(
        "SELECT * FROM scheduled_jobs WHERE id = ?",
        id,
      );
      result = updated ? decode(updated) : undefined;
    });
    return result;
  }
}
