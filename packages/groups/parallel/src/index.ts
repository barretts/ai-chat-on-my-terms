import type {
  GroupTurnPlan,
  GroupTurnPort,
  GroupTurnSpeaker,
} from "@locallab/groups-turns";

export class LeaseCanceledError extends Error {}

export interface ModelLease {
  modelKey: string;
  hostKey: string;
  release(): void;
}

interface HostState {
  capacity: number;
  active: number;
  queue: {
    modelKey: string;
    granted: (lease: ModelLease) => void;
    rejected: (reason: Error) => void;
  }[];
}

/**
 * Per-host model-context leases (GR-10): incompatible same-device contexts
 * are serialized by capacity, models load once and unload only when no
 * lease still references them. Acquisition is FIFO per host, so waiters
 * never deadlock; every acquire path is abortable and a canceled waiter
 * holds nothing.
 */
export class ModelLeaseRegistry {
  private readonly hosts = new Map<string, HostState>();
  private readonly loaded = new Map<string, number>();

  setHostCapacity(hostKey: string, capacity: number): void {
    const state = this.hosts.get(hostKey);
    if (state) state.capacity = Math.max(1, capacity);
    else
      this.hosts.set(hostKey, {
        capacity: Math.max(1, capacity),
        active: 0,
        queue: [],
      });
  }

  loadedModels(): readonly string[] {
    return [...this.loaded.keys()];
  }

  activeContexts(hostKey: string): number {
    return this.hosts.get(hostKey)?.active ?? 0;
  }

  async acquire(
    modelKey: string,
    hostKey: string,
    signal?: AbortSignal,
  ): Promise<ModelLease> {
    if (!this.hosts.has(hostKey)) {
      throw new Error(
        `Unknown host "${hostKey}"; declare its capacity before scheduling.`,
      );
    }
    if (signal?.aborted) throw new LeaseCanceledError("Lease canceled.");
    const lease = this.tryGrantNow(modelKey, hostKey);
    if (lease) return lease;
    const { promise, resolve, reject } = Promise.withResolvers<ModelLease>();
    const waiter = { modelKey, granted: resolve, rejected: reject };
    this.hosts.get(hostKey)!.queue.push(waiter);
    signal?.addEventListener(
      "abort",
      () => {
        const state = this.hosts.get(hostKey)!;
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        reject(new LeaseCanceledError("Lease canceled."));
      },
      { once: true },
    );
    return promise;
  }

  private tryGrantNow(
    modelKey: string,
    hostKey: string,
  ): ModelLease | undefined {
    const state = this.hosts.get(hostKey)!;
    if (state.active >= state.capacity) return undefined;
    state.active += 1;
    this.loaded.set(modelKey, (this.loaded.get(modelKey) ?? 0) + 1);
    let released = false;
    return {
      modelKey,
      hostKey,
      release: () => {
        if (released) return;
        released = true;
        state.active -= 1;
        const count = this.loaded.get(modelKey) ?? 0;
        if (count <= 1) this.loaded.delete(modelKey);
        else this.loaded.set(modelKey, count - 1);
        this.pump(hostKey);
      },
    };
  }
  private pump(hostKey: string): void {
    const state = this.hosts.get(hostKey)!;
    while (state.active < state.capacity && state.queue.length > 0) {
      const waiter = state.queue.shift()!;
      const granted = this.tryGrantNow(waiter.modelKey, hostKey);
      if (granted) waiter.granted(granted);
    }
  }
}

export interface GroupParallelChunk {
  speaker: GroupTurnSpeaker;
  text: string;
}

export interface GroupParallelResult {
  speaker: GroupTurnSpeaker;
  status: "ok" | "failed";
  text: string;
  message?: string;
}

export interface GroupParallelPort {
  generate(input: {
    speaker: GroupTurnSpeaker;
    instruction: string;
    signal?: AbortSignal;
    onChunk?: (text: string) => void;
  }): Promise<string>;
}

export interface GroupParallelGroupOptions {
  /**
   * Maps a speaker to its local model/host for leasing; return null for
   * remote providers that need no local context slot.
   */
  localBinding(
    speaker: GroupTurnSpeaker,
  ): { modelKey: string; hostKey: string } | null;
  leases?: ModelLeaseRegistry;
  signal?: AbortSignal;
  onChunk?(chunk: GroupParallelChunk): void;
}

/**
 * Run every planned speaker's reply concurrently (GR-09). Interleaved
 * chunks stay attributed to their speaker; one participant failing keeps
 * the others' partial successes; cancellation releases every lease.
 */
export async function runGroupTurnParallel(
  plan: GroupTurnPlan,
  port: GroupParallelPort,
  options: GroupParallelGroupOptions,
): Promise<GroupParallelResult[]> {
  const scenarioNote = plan.scenario.trim();
  const instruction =
    scenarioNote === "" ? "" : `Room scenario: ${scenarioNote}`;
  const runOne = async (
    speaker: GroupTurnSpeaker,
  ): Promise<GroupParallelResult> => {
    const binding = options.localBinding(speaker);
    let lease: ModelLease | undefined;
    try {
      if (binding && options.leases)
        lease = await options.leases.acquire(
          binding.modelKey,
          binding.hostKey,
          options.signal,
        );
      const text = await port.generate({
        speaker,
        instruction,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onChunk
          ? {
              onChunk: (text: string) => options.onChunk!({ speaker, text }),
            }
          : {}),
      });
      return { speaker, status: "ok", text };
    } catch (cause) {
      return {
        speaker,
        status: "failed",
        text: "",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      lease?.release();
    }
  };
  return await Promise.all(plan.speakers.map((speaker) => runOne(speaker)));
}

export interface RoomLeaseOptions {
  modelKey: string;
  hostKey: string;
  leases: ModelLeaseRegistry;
}

/**
 * Room runtime v1 single-slot path: ALL generation traffic for one room —
 * persona replies and the topic-interest selector call alike — flows
 * through one host with capacity 1, reusing this registry's FIFO and
 * abortable waiters. No second scheduler exists for group traffic.
 */
export async function withModelLease<T>(
  run: () => Promise<T>,
  options: RoomLeaseOptions,
  signal?: AbortSignal,
): Promise<T> {
  const lease = await options.leases.acquire(
    options.modelKey,
    options.hostKey,
    signal,
  );
  try {
    return await run();
  } finally {
    lease.release();
  }
}

/**
 * Lease-wrapped view of the turn port: every generate() holds exactly one
 * slot while its request runs, then releases. The model itself stays
 * loaded between requests (reference-counted at the native layer); each
 * call rebuilds its complete prompt from scratch, so one persona's
 * instructions can never ride into another speaker's request.
 */
export function leasedTurnPort(
  port: GroupTurnPort,
  options: RoomLeaseOptions,
): GroupTurnPort {
  return {
    generate: (input) =>
      withModelLease(() => port.generate(input), options, input.signal),
  };
}
