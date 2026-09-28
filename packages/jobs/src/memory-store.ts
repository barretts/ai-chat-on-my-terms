import {
  JobRecordSchema,
  type CreateJobInput,
  type JobRecord,
  type JobState,
  type JobStore,
} from "./types.js";
import type { Revision } from "@locallab/contracts/identity";

/** Deterministic test adapter. Production must supply a transactional durable JobStore. */
export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly keys = new Map<string, string>();

  async create(
    input: CreateJobInput,
    now: string,
    id: string,
    revision: Revision,
  ) {
    const existingId = this.keys.get(input.idempotencyKey);
    if (existingId) return { job: this.jobs.get(existingId)!, created: false };
    const job = JobRecordSchema.parse({
      ...input,
      id,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      revision,
      startedAt: null,
      finishedAt: null,
      attempt: 0,
      progress: null,
    });
    this.jobs.set(id, job);
    this.keys.set(input.idempotencyKey, id);
    return { job, created: true };
  }

  async get(id: string) {
    return this.jobs.get(id);
  }
  async findByIdempotencyKey(key: string) {
    const id = this.keys.get(key);
    return id ? this.jobs.get(id) : undefined;
  }
  async listNonterminal() {
    return [...this.jobs.values()].filter(
      (j) => j.state === "queued" || j.state === "running",
    );
  }
  async listAll() {
    return [...this.jobs.values()].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async transition(
    id: string,
    expected: readonly JobState[],
    update: Partial<JobRecord>,
  ) {
    const current = this.jobs.get(id);
    if (!current || !expected.includes(current.state)) return undefined;
    const next = JobRecordSchema.parse({ ...current, ...update });
    this.jobs.set(id, next);
    return next;
  }
}
