import type {
  CreateJobInput,
  JobCategory,
  JobHandler,
  JobLimits,
  JobRecord,
  JobState,
  JobStore,
} from "./types.js";
import {
  EntityIdSchema,
  type EntityId,
  type Revision,
} from "@locallab/contracts/identity";

const defaultLimits: JobLimits = { streaming: 2, download: 2, media: 1 };
const terminal = new Set<JobState>(["completed", "failed", "canceled"]);

export class JobScheduler {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly active = new Set<string>();
  private started = false;
  private pumping = false;
  private readonly limits: JobLimits;

  constructor(
    private readonly store: JobStore,
    options: {
      limits?: Partial<JobLimits>;
      now?: () => Date;
      deviceId: EntityId;
      createId?: () => EntityId;
      revisionSource?: (
        previous: Revision | undefined,
        now: Date,
        deviceId: EntityId,
      ) => Revision;
    },
  ) {
    this.limits = { ...defaultLimits, ...options.limits };
    for (const category of ["streaming", "download", "media"] as const) {
      const limit = this.limits[category];
      if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError(
          `${category} concurrency must be a positive integer`,
        );
    }
    this.now = options.now ?? (() => new Date());
    this.deviceId = EntityIdSchema.parse(options.deviceId);
    this.createId = options.createId ?? (() => createUuidV7(this.now()));
    this.revisionSource = options.revisionSource ?? defaultRevisionSource;
  }

  private readonly now: () => Date;
  private readonly deviceId: EntityId;
  private readonly createId: () => EntityId;
  private readonly revisionSource: (
    previous: Revision | undefined,
    now: Date,
    deviceId: EntityId,
  ) => Revision;
  private stamp() {
    return this.now().toISOString();
  }

  register(kind: string, handler: JobHandler): void {
    if (this.handlers.has(kind))
      throw new Error(`Handler already registered for ${kind}`);
    this.handlers.set(kind, handler);
  }

  /** Requeues work interrupted while running; completed records are never scheduled again. */
  async recover(): Promise<readonly JobRecord[]> {
    const interrupted = [...(await this.store.listNonterminal())].sort(
      orderJobs,
    );
    for (const job of interrupted) {
      if (job.state === "running") {
        await this.transition(job.id, ["running"], {
          state: "queued",
          startedAt: null,
        });
      }
    }
    this.started = true;
    await this.pump();
    return this.store.listAll();
  }

  async start(input: CreateJobInput): Promise<JobRecord> {
    const now = this.now();
    const created = await this.store.create(
      input,
      now.toISOString(),
      this.createId(),
      this.revisionSource(undefined, now, this.deviceId),
    );
    if (!this.started) this.started = true;
    await this.pump();
    return (await this.store.get(created.job.id)) ?? created.job;
  }

  async get(id: string) {
    return this.store.get(id);
  }
  async list() {
    return this.store.listAll();
  }

  async cancel(id: string): Promise<JobRecord | undefined> {
    const current = await this.store.get(id);
    if (!current || terminal.has(current.state)) return current;
    const canceled = await this.transition(id, ["queued", "running"], {
      state: "canceled",
      finishedAt: this.stamp(),
    });
    if (canceled) this.controllers.get(id)?.abort(new Error("Job canceled"));
    await this.pump();
    return canceled ?? this.store.get(id);
  }

  private async pump(): Promise<void> {
    if (!this.started || this.pumping) return;
    this.pumping = true;
    try {
      const jobs = [...(await this.store.listNonterminal())].sort(orderJobs);
      for (const job of jobs) {
        if (job.state !== "queued" || this.active.size >= total(this.limits))
          continue;
        const category = job.category as JobCategory;
        if (this.activeFor(category) >= this.limits[category]) continue;
        const handler = this.handlers.get(job.kind);
        if (!handler) continue;
        const running = await this.transition(job.id, ["queued"], {
          state: "running",
          startedAt: this.stamp(),
          finishedAt: null,
          attempt: job.attempt + 1,
        });
        if (!running) continue;
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        this.active.add(job.id);
        this.activeCategories.set(job.id, job.category);
        void this.execute(running, handler, controller);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async execute(
    job: JobRecord,
    handler: JobHandler,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await handler(job.input, {
        job,
        signal: controller.signal,
        reportProgress: async (progress) => {
          if (!Number.isFinite(progress) || progress < 0 || progress > 1)
            throw new RangeError("progress must be from 0 to 1");
          await this.transition(job.id, ["running"], {
            progress,
          });
        },
      });
      await this.transition(job.id, ["running"], {
        state: "completed",
        result,
        progress: 1,
        finishedAt: this.stamp(),
      });
    } catch (error) {
      const canceled = controller.signal.aborted;
      await this.transition(job.id, ["running"], {
        state: canceled ? "canceled" : "failed",
        ...(canceled
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
        finishedAt: this.stamp(),
      });
    } finally {
      this.active.delete(job.id);
      this.controllers.delete(job.id);
      this.activeCategories.delete(job.id);
      await this.pump();
    }
  }

  private async transition(
    id: string,
    expected: readonly JobState[],
    update: Partial<JobRecord>,
  ): Promise<JobRecord | undefined> {
    const current = await this.store.get(id);
    if (!current || !expected.includes(current.state)) return undefined;
    const now = this.now();
    return this.store.transition(id, expected, {
      ...update,
      updatedAt: now.toISOString(),
      revision: this.revisionSource(current.revision, now, this.deviceId),
    });
  }

  private activeFor(category: JobRecord["category"]): number {
    return [...this.active].filter(
      (id) => this.activeCategories.get(id) === category,
    ).length;
  }
  private readonly activeCategories = new Map<string, JobRecord["category"]>();
}

function orderJobs(a: JobRecord, b: JobRecord): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
function total(limits: JobLimits) {
  return limits.streaming + limits.download + limits.media;
}

function defaultRevisionSource(
  previous: Revision | undefined,
  now: Date,
  deviceId: EntityId,
): Revision {
  const wallMs = Math.max(0, now.getTime());
  if (!previous || wallMs > previous.wallMs)
    return { wallMs, counter: 0, deviceId };
  return { wallMs: previous.wallMs, counter: previous.counter + 1, deviceId };
}

function createUuidV7(now: Date): EntityId {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Math.max(0, now.getTime());
  for (let index = 5; index >= 0; index--) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return EntityIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}
