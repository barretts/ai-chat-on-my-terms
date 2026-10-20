import { ModelLeaseRegistry, type ModelLease } from "@locallab/groups-parallel";

/**
 * GR-13 shared-model room runtime (T174).
 *
 * A v1 group room owns exactly ONE binding: the room's `sharedModelId`
 * resolved to an installed managed model. Per-seat
 * `providerConnectionId`/`modelId` stay on the seat rows for compatibility,
 * but the group runtime IGNORES them whenever a shared binding resolves —
 * persona replies and the topic-interest selector call all queue through
 * the same single-slot lease, and the model stays loaded between replies.
 */

export interface RoomModelBinding {
  providerConnectionId: string;
  modelRecordId: string;
  modelId: string;
}

/**
 * Resolve the room's shared model against installed models. Null means the
 * room has no shared binding; loading failure must surface as an actionable
 * error at the call site — NEVER a silent model substitution.
 */
export function resolveSharedRoomBinding(
  sharedModelId: string | null,
  installed: readonly RoomModelBinding[],
): RoomModelBinding | null {
  if (sharedModelId === null) return null;
  return installed.find((model) => model.modelId === sharedModelId) ?? null;
}

/** One lease key per shared room model so all room traffic serializes. */
export function groupModelKey(binding: RoomModelBinding): string {
  return `room:${binding.providerConnectionId}:${binding.modelId}`;
}

export interface GroupRuntimeOptions {
  registry: ModelLeaseRegistry;
  hostKey: string;
  modelKey: string;
  /**
   * Native unload hook (gguf `ManagedModelFiles` reference drop). Called
   * exactly once per release, only after in-flight requests settle.
   */
  unload?(modelKey: string): void | Promise<void>;
}

/**
 * Single shared model context for one room. `schedule` funnels every
 * generation through the room's capacity-1 slot (the registry's FIFO and
 * abortable waiters; no second scheduler). `release` implements the release
 * triggers — app backgrounding (ShortBackgroundExecution grace first),
 * leaving the room screen, the model-change picker, and a native
 * memory-pressure signal when the bridge exposes one: in-flight requests
 * settle or are canceled, leases drop, then the unload hook fires.
 */
export class GroupModelRuntime {
  private active = 0;
  private releasing = false;
  private idle = Promise.withResolvers<void>();
  private releasePromise: Promise<void> | undefined;

  constructor(private readonly options: GroupRuntimeOptions) {
    options.registry.setHostCapacity(options.hostKey, 1);
  }

  async schedule<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.releasing)
      throw new Error(
        "The room model is releasing; start the turn again once it has unloaded.",
      );
    // Reserve before acquiring so a release also waits for queued waiters.
    this.active += 1;
    let lease: ModelLease | undefined;
    try {
      lease = await this.options.registry.acquire(
        this.options.modelKey,
        this.options.hostKey,
        signal,
      );
      return await run();
    } finally {
      this.active -= 1;
      lease?.release();
      if (this.active === 0) this.idle.resolve();
    }
  }

  /** Shared-model rooms release atomically; concurrent calls unload once. */
  async release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.releasePromise = this.quiesceAndUnload().finally(() => {
      this.releasePromise = undefined;
    });
    return this.releasePromise;
  }

  private async quiesceAndUnload(): Promise<void> {
    if (this.active > 0) {
      this.releasing = true;
      try {
        await this.idle.promise;
      } finally {
        this.releasing = false;
        this.idle = Promise.withResolvers<void>();
      }
    }
    await this.options.unload?.(this.options.modelKey);
  }
}
