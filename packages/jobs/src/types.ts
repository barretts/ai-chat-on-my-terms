import { z } from "zod";
import { JobSchema } from "@locallab/contracts/entities";
import { EntityIdSchema, RevisionSchema } from "@locallab/contracts/identity";

export const JobCategorySchema = z.enum(["streaming", "download", "media"]);
export type JobCategory = z.infer<typeof JobCategorySchema>;
export const JobStateSchema = JobSchema.shape.state;
export type JobState = z.infer<typeof JobStateSchema>;

export const JobRecordSchema = JobSchema.extend({
  category: JobCategorySchema,
  idempotencyKey: z.string().min(1),
  input: z.unknown(),
  attempt: z.number().int().nonnegative(),
  result: z.unknown().optional(),
  error: z.string().optional(),
}).strict();
export type JobRecord = z.infer<typeof JobRecordSchema>;

export interface CreateJobInput {
  kind: string;
  category: JobCategory;
  idempotencyKey: string;
  input: unknown;
}

/** Implementations must make idempotency-key insertion and state transitions atomic. */
export interface JobStore {
  create(
    input: CreateJobInput,
    now: string,
    id: z.infer<typeof EntityIdSchema>,
    revision: z.infer<typeof RevisionSchema>,
  ): Promise<{ job: JobRecord; created: boolean }>;
  get(id: string): Promise<JobRecord | undefined>;
  findByIdempotencyKey(key: string): Promise<JobRecord | undefined>;
  listNonterminal(): Promise<readonly JobRecord[]>;
  listAll(): Promise<readonly JobRecord[]>;
  transition(
    id: string,
    expected: readonly JobState[],
    update: Partial<JobRecord>,
  ): Promise<JobRecord | undefined>;
}

export type JobHandler = (
  input: unknown,
  context: {
    job: JobRecord;
    signal: AbortSignal;
    reportProgress(progress: number): Promise<void>;
  },
) => Promise<unknown>;

export interface JobLimits {
  streaming: number;
  download: number;
  media: number;
}
