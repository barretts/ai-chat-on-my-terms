import { z } from "zod";
import { TypedErrorSchema } from "@locallab/contracts/entities";
import { EntityIdSchema } from "@locallab/contracts/identity";
import { JobScheduler, type JobRecord } from "@locallab/jobs";

/** IM-01/IM-02 policy: master enable, prompt review, automatic generation. */
export const MediaSettingsSchema = z
  .object({
    enabled: z.boolean(),
    promptReview: z.boolean(),
    autoGenerate: z.boolean(),
  })
  .strict();
export type MediaSettings = z.infer<typeof MediaSettingsSchema>;

export interface MediaSettingsStore {
  load(): Promise<MediaSettings>;
  save(next: MediaSettings): Promise<void>;
}

/** The prompt, settings and workflow snapshot a job freezes at enqueue time. */
export const MediaSnapshotSchema = z
  .object({
    conversationId: z.string().min(1),
    prompt: z.string().min(1),
    inputRefs: z.array(z.string()),
    workflowSnapshot: z
      .object({
        name: z.string().min(1),
        definition: z.record(z.string(), z.unknown()),
      })
      .strict(),
    capturedAt: z.string(),
  })
  .strict();
export type MediaSnapshot = z.infer<typeof MediaSnapshotSchema>;

export interface MediaGenerationRequest {
  conversationId: string;
  prompt: string;
  /** "chat" requests obey the auto-generate toggle; the chat image button is "button". */
  requestedBy: "chat" | "button";
  inputRefs?: string[];
  workflow: { name: string; definition: Record<string, unknown> };
}

/** Backend failures carry the frozen typed error, never provider strings. */
export class MediaBackendError extends Error {
  constructor(readonly failure: z.infer<typeof TypedErrorSchema>) {
    super(failure.message);
    this.name = "MediaBackendError";
  }
}

export interface MediaBackendPort {
  generate(context: {
    snapshot: MediaSnapshot;
    jobId: string;
    signal: AbortSignal;
    reportProgress(progress: number): Promise<void>;
    /** As soon as the backend obtains a server-side job id. */
    reportServerJob(serverJobId: string): void;
  }): Promise<{ outputRefs: string[] }>;
  /** Re-attach to an already-submitted server job without resubmitting. */
  resume?(context: {
    serverJobId: string;
    snapshot: MediaSnapshot;
    signal: AbortSignal;
    reportProgress(progress: number): Promise<void>;
  }): Promise<{ outputRefs: string[] }>;
}

export const MediaReviewDraftSchema = z
  .object({
    id: EntityIdSchema,
    idempotencyKey: z.string().min(1),
    snapshot: MediaSnapshotSchema,
    createdAt: z.string(),
  })
  .strict();
export type MediaReviewDraft = z.infer<typeof MediaReviewDraftSchema>;

/** Durable prompt-review queue (promptReview mode). */
export interface MediaReviewStore {
  save(draft: MediaReviewDraft): Promise<void>;
  get(id: string): Promise<MediaReviewDraft | undefined>;
  findByIdempotencyKey(key: string): Promise<MediaReviewDraft | undefined>;
  delete(id: string): Promise<void>;
  list(): Promise<MediaReviewDraft[]>;
}

export type MediaRequestOutcome =
  | { kind: "job"; job: JobRecord }
  | { kind: "review"; draft: MediaReviewDraft }
  | { kind: "suppressed"; reason: string };

export const IMAGE_GENERATE_KIND = "image-generate";

export class MediaJobService {
  constructor(
    private readonly scheduler: JobScheduler,
    private readonly settings: MediaSettingsStore,
    private readonly backend: MediaBackendPort,
    private readonly reviews: MediaReviewStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    scheduler.register(IMAGE_GENERATE_KIND, async (input, context) => {
      const snapshot = MediaSnapshotSchema.parse(input);
      try {
        const { outputRefs } = await this.backend.generate({
          snapshot,
          jobId: context.job.id,
          signal: context.signal,
          reportProgress: context.reportProgress,
          reportServerJob: () => undefined,
        });
        return { outputRefs };
      } catch (error) {
        if (context.signal.aborted) throw error;
        const failure =
          error instanceof MediaBackendError
            ? error.failure
            : TypedErrorSchema.parse({
                code: "host-stopped",
                message:
                  error instanceof Error ? error.message : String(error),
                recoverable: true,
                backend: "media",
              });
        // job.error stores the JSON-serialized TypedError so the UI never
        // parses provider error strings.
        throw new Error(JSON.stringify(failure));
      }
    });
  }

  async requestGeneration(
    request: MediaGenerationRequest,
  ): Promise<MediaRequestOutcome> {
    const settings = await this.settings.load();
    if (!settings.enabled)
      return {
        kind: "suppressed",
        reason: "Image generation is turned off in Settings.",
      };
    if (request.requestedBy === "chat" && !settings.autoGenerate)
      return {
        kind: "suppressed",
        reason: "Automatic image generation is off; use the image button.",
      };
    const snapshot = MediaSnapshotSchema.parse({
      conversationId: request.conversationId,
      prompt: request.prompt,
      inputRefs: request.inputRefs ?? [],
      workflowSnapshot: request.workflow,
      capturedAt: this.now().toISOString(),
    });
    const idempotencyKey = mediaIdempotencyKey(snapshot);
    if (settings.promptReview) {
      const existing = await this.reviews.findByIdempotencyKey(idempotencyKey);
      if (existing) return { kind: "review", draft: existing };
      const draft: MediaReviewDraft = MediaReviewDraftSchema.parse({
        id: createUuidV7(this.now()),
        idempotencyKey,
        snapshot,
        createdAt: this.now().toISOString(),
      });
      await this.reviews.save(draft);
      return { kind: "review", draft };
    }
    const job = await this.scheduler.start({
      kind: IMAGE_GENERATE_KIND,
      category: "media",
      idempotencyKey,
      input: snapshot,
    });
    return { kind: "job", job };
  }

  /** Approves a review draft; the durable job carries the frozen snapshot. */
  async approveReview(draftId: string): Promise<JobRecord | undefined> {
    const draft = await this.reviews.get(draftId);
    if (!draft) return undefined;
    const job = await this.scheduler.start({
      kind: IMAGE_GENERATE_KIND,
      category: "media",
      idempotencyKey: draft.idempotencyKey,
      input: draft.snapshot,
    });
    await this.reviews.delete(draftId);
    return job;
  }

  async cancelReview(draftId: string): Promise<void> {
    await this.reviews.delete(draftId);
  }

  /** Canceled jobs are never marked complete; late backend results lose. */
  async cancelJob(jobId: string): Promise<JobRecord | undefined> {
    return this.scheduler.cancel(jobId);
  }
}

export function mediaIdempotencyKey(snapshot: MediaSnapshot): string {
  return [
    snapshot.conversationId,
    snapshot.prompt.trim().toLowerCase(),
    snapshot.workflowSnapshot.name,
  ].join("|");
}

/** Durable SQLite adapter for the review queue (owned by this package). */
export class SqliteMediaReviewStore implements MediaReviewStore {
  constructor(private readonly db: {
    execAsync(sql: string): Promise<void>;
    runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
    getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
    getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  }) {}

  initialize(): Promise<void> {
    return this.db.execAsync(`
CREATE TABLE IF NOT EXISTS media_review_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL
);`);
  }

  async save(draft: MediaReviewDraft): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO media_review_drafts (id, idempotency_key, snapshot_json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      draft.id,
      draft.idempotencyKey,
      JSON.stringify(draft.snapshot),
      draft.createdAt,
    );
  }

  async get(id: string): Promise<MediaReviewDraft | undefined> {
    const row = await this.db.getFirstAsync<{
      id: string;
      idempotency_key: string;
      snapshot_json: string;
      created_at: string;
    }>(`SELECT * FROM media_review_drafts WHERE id = ?`, id);
    return row ? this.fromRow(row) : undefined;
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<MediaReviewDraft | undefined> {
    const row = await this.db.getFirstAsync<{
      id: string;
      idempotency_key: string;
      snapshot_json: string;
      created_at: string;
    }>(`SELECT * FROM media_review_drafts WHERE idempotency_key = ?`, key);
    return row ? this.fromRow(row) : undefined;
  }

  async delete(id: string): Promise<void> {
    await this.db.runAsync(`DELETE FROM media_review_drafts WHERE id = ?`, id);
  }

  async list(): Promise<MediaReviewDraft[]> {
    const rows = await this.db.getAllAsync<{
      id: string;
      idempotency_key: string;
      snapshot_json: string;
      created_at: string;
    }>(`SELECT * FROM media_review_drafts ORDER BY created_at ASC, id ASC`);
    return rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: {
    id: string;
    idempotency_key: string;
    snapshot_json: string;
    created_at: string;
  }): MediaReviewDraft {
    return MediaReviewDraftSchema.parse({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      snapshot: JSON.parse(row.snapshot_json),
      createdAt: row.created_at,
    });
  }
}

function createUuidV7(now: Date): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = now.getTime();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
