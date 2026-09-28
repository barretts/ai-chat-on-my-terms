import { EntityIdSchema } from "@locallab/contracts/identity";
import {
  TypedErrorCodeSchema,
  type TypedErrorSchema,
} from "@locallab/contracts/entities";
import { RunEventSchema, type RunEvent } from "@locallab/contracts/run-events";
import type { z } from "zod";
import { SQLiteArenaStore } from "./sqlite-store";
import {
  ArenaSnapshotSchema,
  capabilityFailure,
  hasToolDefinitions,
  requestFor,
  type ArenaBinding,
  type ArenaContestant,
  type ArenaLiveUpdate,
  type ArenaModelLease,
  type ArenaRaceHandle,
  type ArenaRaceInput,
  type ArenaResult,
  type ArenaRun,
  type ArenaTiming,
} from "./types";

export { ARENA_SQL, SQLiteArenaStore } from "./sqlite-store";
export * from "./types";

export interface ArenaEngineOptions {
  readonly now?: () => Date;
  /** Must use a monotonic clock; wall time is reserved for entity timestamps/HLC. */
  readonly monotonicNow?: () => number;
  readonly createId?: () => string;
  readonly maxOutputCharacters?: number;
  readonly maxReasoningCharacters?: number;
  readonly maxSnapshotBytes?: number;
  readonly maxEventsPerContestant?: number;
  readonly maxRunMs?: number;
  readonly estimateTokens?: (text: string) => number;
  /** Receives a frozen snapshot with separate contestant identity; no event queue. */
  readonly onUpdate?: (update: ArenaLiveUpdate) => void;
}

type SafeError = z.infer<typeof TypedErrorSchema>;
type Control = {
  controller: AbortController;
  canceled: boolean;
  finished: Promise<void>;
};
type ActiveRace = {
  id: string;
  controls: Map<string, Control>;
  drains: Promise<void>[];
  handle: ArenaRaceHandle;
};
const terminal = new Set<ArenaContestant["state"]>([
  "completed",
  "failed",
  "canceled",
  "interrupted",
]);

/** One arena owns at most four live provider streams. Independent async workers
 * persist each stream with backpressure, and never choose a substitute binding. */
export class ArenaEngine {
  private active: ActiveRace | undefined;
  private starting = false;
  private closed = false;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly createId: () => string;
  private readonly maxOutput: number;
  private readonly maxReasoning: number;
  private readonly maxSnapshot: number;
  private readonly maxEvents: number;
  private readonly maxRunMs: number;
  private readonly estimateTokens: (text: string) => number;

  constructor(
    private readonly store: SQLiteArenaStore,
    private readonly options: ArenaEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.createId = options.createId ?? (() => uuidV7(this.now()));
    this.maxOutput = positiveInteger(
      options.maxOutputCharacters ?? 131_072,
      "Output character limit",
    );
    this.maxReasoning = positiveInteger(
      options.maxReasoningCharacters ?? 65_536,
      "Reasoning character limit",
    );
    this.maxSnapshot = positiveInteger(
      options.maxSnapshotBytes ?? 262_144,
      "Snapshot byte limit",
    );
    this.maxEvents = positiveInteger(
      options.maxEventsPerContestant ?? 20_000,
      "Event limit",
    );
    this.maxRunMs = positiveInteger(options.maxRunMs ?? 300_000, "Run timeout");
    this.estimateTokens =
      options.estimateTokens ?? ((text) => Math.ceil(text.length / 4));
  }

  async recover(): Promise<readonly string[]> {
    if (this.active || this.starting)
      throw new Error(
        "Do not recover arena history while a live race owns provider resources",
      );
    return this.store.recover();
  }

  async start(input: ArenaRaceInput): Promise<ArenaRaceHandle> {
    if (this.closed) throw new Error("Arena engine is closed");
    if (this.active || this.starting)
      throw new Error(
        "Wait for the current arena providers to drain before starting another race",
      );
    if (input.contestants.length < 1 || input.contestants.length > 4)
      throw new RangeError("An arena race requires one to four contestants");
    this.starting = true;
    try {
      const bindings = input.contestants.map((binding) =>
        Object.freeze({
          ...binding,
          ...(binding.connection === undefined
            ? {}
            : { connection: freezeJson(copyConnection(binding.connection)) }),
        }),
      );
      bindings.forEach((binding) => {
        EntityIdSchema.parse(binding.providerConnectionId);
        if (!binding.modelId.trim() || !binding.label.trim())
          throw new Error(
            "Arena contestants require an exact model ID and display label",
          );
      });
      const snapshot = freezeJson(
        ArenaSnapshotSchema.parse(
          cloneJson(
            {
              prompt: input.prompt,
              conversationId: input.conversationId ?? this.nextId(),
              messageId: input.messageId ?? this.nextId(),
              context: [
                ...(input.context ?? []),
                { kind: "user", value: input.prompt },
              ],
              parameters: input.parameters ?? {},
              permittedTools: input.permittedTools ?? [],
              attachmentRefs: input.attachmentRefs ?? [],
              reasoning: input.reasoning ?? false,
              json: input.json ?? false,
              requiredCapabilities: input.requiredCapabilities ?? [],
            },
            this.maxSnapshot,
          ),
        ),
      );
      if (!snapshot.prompt.trim())
        throw new Error("Arena prompt must contain text");
      if (hasToolDefinitions(snapshot) && snapshot.permittedTools.length === 0)
        throw new Error(
          "Tool definitions require explicit permitted tool names",
        );
      const runStamp = this.store.stamp();
      const id = this.nextId();
      const contestants: ArenaContestant[] = bindings.map(
        (binding, position) => {
          const stamp = this.store.stamp();
          return {
            id: this.nextId(),
            arenaRunId: id,
            position,
            providerConnectionId: binding.providerConnectionId,
            modelId: binding.modelId,
            label: binding.label,
            state: "queued",
            text: "",
            reasoningText: "",
            outputTruncated: false,
            capabilities: {},
            timing: emptyTiming(),
            lastSequence: -1,
            createdAt: stamp.updatedAt,
            updatedAt: stamp.updatedAt,
            revision: stamp.revision,
            startedAt: null,
            finishedAt: null,
            finishReason: null,
            error: null,
          };
        },
      );
      if (
        new Set([id, ...contestants.map((contestant) => contestant.id)])
          .size !==
        contestants.length + 1
      )
        throw new Error("Arena ID source must return unique IDs");
      const run: ArenaRun = {
        id,
        state: "running",
        snapshot,
        contestantIds: contestants.map((contestant) => contestant.id),
        createdAt: runStamp.updatedAt,
        updatedAt: runStamp.updatedAt,
        revision: runStamp.revision,
        finishedAt: null,
      };
      await this.store.create(run, contestants);
      const controls = new Map(
        contestants.map((contestant) => [
          contestant.id,
          {
            controller: new AbortController(),
            canceled: false,
            finished: Promise.resolve(),
          },
        ]),
      );
      if (this.closed)
        for (const control of controls.values()) {
          control.canceled = true;
          control.controller.abort(new ArenaAbort("canceled"));
        }
      let done!: Promise<ArenaResult>;
      let resourcesDrained!: Promise<void>;
      const handle: ArenaRaceHandle = {
        id,
        get done() {
          return done;
        },
        get resourcesDrained() {
          return resourcesDrained;
        },
        cancel: (contestantId) => this.cancel(id, contestantId),
        read: async () => {
          const result = await this.store.read(id);
          if (!result) throw new Error("Arena race is missing");
          return result;
        },
      };
      const active: ActiveRace = { id, controls, drains: [], handle };
      this.active = active;
      const workers = contestants.map((contestant, index) => {
        const control = controls.get(contestant.id)!;
        const worker = this.execute(
          run,
          contestant,
          bindings[index]!,
          control,
          active,
        );
        control.finished = worker;
        return worker;
      });
      done = Promise.all(workers).then(async () => {
        const result = await handle.read();
        const state = result.contestants.every(
          (contestant) => contestant.state === "canceled",
        )
          ? "canceled"
          : "completed";
        await this.store.finish(id, state);
        return handle.read();
      });
      resourcesDrained = done
        .then(async () => {
          await Promise.all(active.drains);
        })
        .finally(() => {
          if (this.active === active) this.active = undefined;
        });
      // The handle owns rejections; attaching observers avoids process-wide
      // unhandled rejections if a UI unmounts before awaiting a storage error.
      void done.catch(() => undefined);
      void resourcesDrained.catch(() => undefined);
      return handle;
    } finally {
      this.starting = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (!active) return;
    await active.handle.cancel();
    await active.handle.resourcesDrained;
  }

  private async cancel(id: string, contestantId?: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id) return;
    if (contestantId && !active.controls.has(contestantId))
      throw new Error("Contestant does not belong to this arena race");
    for (const [candidateId, control] of active.controls) {
      if (contestantId && contestantId !== candidateId) continue;
      control.canceled = true;
      control.controller.abort(new ArenaAbort("canceled"));
    }
    await Promise.all(
      [...active.controls.entries()]
        .filter(
          ([candidateId]) => !contestantId || candidateId === contestantId,
        )
        .map(([, control]) => control.finished),
    );
  }

  private async execute(
    run: ArenaRun,
    initial: ArenaContestant,
    binding: ArenaBinding,
    control: Control,
    active: ActiveRace,
  ): Promise<void> {
    const signal = control.controller.signal;
    const entered = this.monotonicNow();
    let requestStart: number | undefined;
    let firstOutput: number | undefined;
    let lastObserved = entered;
    let eventCount = 0;
    let iterator: AsyncIterator<RunEvent> | undefined;
    let pendingNext: Promise<IteratorResult<RunEvent>> | undefined;
    let lease: ArenaModelLease | undefined;
    let preparation: Promise<ArenaModelLease> | undefined;
    let current = initial;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      control.controller.abort(new ArenaAbort("timeout"));
    }, this.maxRunMs);
    const elapsed = (start: number, end: number) => Math.max(0, end - start);
    const metrics = (value: ArenaContestant, at: number): ArenaTiming => {
      const estimatedOutputTokens = this.estimateTokens(
        value.text + value.reasoningText,
      );
      if (
        !Number.isSafeInteger(estimatedOutputTokens) ||
        estimatedOutputTokens < 0
      )
        throw new Error(
          "Arena token estimator must return a nonnegative integer",
        );
      const decodeMs =
        firstOutput === undefined ? null : elapsed(firstOutput, at);
      return {
        ...value.timing,
        elapsedMs: requestStart === undefined ? 0 : elapsed(requestStart, at),
        ttftMs:
          requestStart === undefined || firstOutput === undefined
            ? null
            : elapsed(requestStart, firstOutput),
        decodeMs,
        decodeTimingSource:
          decodeMs === null ? null : "observed-output-interval",
        estimatedOutputTokens,
        estimatedTokensPerSecond:
          decodeMs === null || decodeMs <= 0
            ? null
            : (estimatedOutputTokens * 1000) / decodeMs,
        reportedTokenCountPerSecond:
          decodeMs === null ||
          decodeMs <= 0 ||
          value.timing.providerOutputTokens === null
            ? null
            : (value.timing.providerOutputTokens * 1000) / decodeMs,
      };
    };
    try {
      throwIfAborted(signal);
      if (binding.prepare) {
        preparation = binding.prepare(signal);
        lease = await abortable(preparation, signal);
      }
      throwIfAborted(signal);
      const port = lease?.port ?? binding.port;
      const capabilities = await abortable(
        port.getCapabilities(binding.connection, binding.modelId, signal),
        signal,
      );
      if (!capabilities.ok) throw new ArenaFailure(capabilities.error.code);
      const blocked = capabilityFailure(run.snapshot, capabilities.value);
      current = await this.store.updateContestant(initial.id, (value) => ({
        ...value,
        capabilities: { ...capabilities.value },
        timing: {
          ...value.timing,
          preparationMs: elapsed(entered, this.monotonicNow()),
        },
      }));
      if (blocked) throw new ArenaFailure("unsupported");
      throwIfAborted(signal);
      requestStart = this.monotonicNow();
      current = await this.store.updateContestant(initial.id, (value) => ({
        ...value,
        state: "running",
        startedAt: this.now().toISOString(),
      }));
      this.emit(current);
      const request = freezeJson(requestFor(run.snapshot, current));
      iterator = port.startRun(request, signal)[Symbol.asyncIterator]();
      for (;;) {
        throwIfAborted(signal);
        pendingNext = Promise.resolve(iterator.next());
        const next = await abortable(pendingNext, signal);
        pendingNext = undefined;
        throwIfAborted(signal);
        if (next.done) {
          if (!terminal.has(current.state)) throw new ArenaFailure("malformed");
          break;
        }
        if (++eventCount > this.maxEvents) throw new ArenaFailure("quota");
        const parsed = RunEventSchema.safeParse(next.value);
        if (
          !parsed.success ||
          parsed.data.runId !== initial.id ||
          !Number.isSafeInteger(parsed.data.sequence)
        )
          throw new ArenaFailure("malformed");
        const event = parsed.data;
        if (event.sequence <= current.lastSequence) continue;
        lastObserved = this.monotonicNow();
        if (
          (event.type === "TextDelta" || event.type === "ReasoningDelta") &&
          event.text.length > 0
        )
          firstOutput ??= lastObserved;
        let exceedsLimit = false;
        current = await this.store.updateContestant(initial.id, (value) => {
          let updated = { ...value, lastSequence: event.sequence };
          if (event.type === "TextDelta") {
            exceedsLimit =
              updated.text.length + event.text.length > this.maxOutput;
            updated.text += event.text.slice(
              0,
              Math.max(0, this.maxOutput - updated.text.length),
            );
          } else if (event.type === "ReasoningDelta") {
            exceedsLimit =
              updated.reasoningText.length + event.text.length >
              this.maxReasoning;
            updated.reasoningText += event.text.slice(
              0,
              Math.max(0, this.maxReasoning - updated.reasoningText.length),
            );
          } else if (event.type === "Usage") {
            updated.timing = {
              ...updated.timing,
              providerOutputTokens:
                event.outputTokens ?? updated.timing.providerOutputTokens,
              providerInputTokens:
                event.inputTokens ?? updated.timing.providerInputTokens,
            };
          } else if (event.type === "RunCompleted") {
            updated.state = "completed";
            updated.finishedAt = this.now().toISOString();
            updated.finishReason = cleanFinishReason(event.finishReason);
          } else if (event.type === "RunCanceled") {
            updated.state = "canceled";
            updated.finishedAt = this.now().toISOString();
            updated.error = safeError("canceled");
          } else if (event.type === "RunFailed") {
            updated.state = "failed";
            updated.finishedAt = this.now().toISOString();
            updated.error = safeError(event.error.code);
          }
          updated.timing = metrics(updated, lastObserved);
          if (terminal.has(updated.state))
            updated.timing = reportedMetrics(
              updated.timing,
              readMetrics(binding, initial.id),
            );
          if (exceedsLimit)
            updated = {
              ...updated,
              outputTruncated: true,
              state: "failed",
              finishedAt: this.now().toISOString(),
              error: safeError("quota"),
            };
          return updated;
        });
        this.emit(current, event.type);
        if (exceedsLimit) control.controller.abort(new ArenaAbort("quota"));
        if (terminal.has(current.state)) break;
      }
    } catch (error) {
      lastObserved = this.monotonicNow();
      const code = control.canceled
        ? "canceled"
        : timedOut
          ? "timeout"
          : error instanceof ArenaFailure || error instanceof ArenaAbort
            ? error.code
            : "offline";
      current = await this.store.updateContestant(initial.id, (value) => ({
        ...value,
        state: code === "canceled" ? "canceled" : "failed",
        error: safeError(code),
        finishedAt: this.now().toISOString(),
        timing: reportedMetrics(
          {
            ...value.timing,
            elapsedMs:
              requestStart === undefined
                ? 0
                : elapsed(requestStart, lastObserved),
            preparationMs:
              requestStart === undefined
                ? elapsed(entered, lastObserved)
                : value.timing.preparationMs,
            ttftMs:
              requestStart === undefined || firstOutput === undefined
                ? null
                : elapsed(requestStart, firstOutput),
            decodeMs:
              firstOutput === undefined
                ? null
                : elapsed(firstOutput, lastObserved),
            decodeTimingSource:
              firstOutput === undefined ? null : "observed-output-interval",
          },
          readMetrics(binding, initial.id),
        ),
      }));
      this.emit(current);
      if (!signal.aborted) control.controller.abort(new ArenaAbort(code));
    } finally {
      clearTimeout(timer);
      // Do not release a local model lease while an uncooperative next()/load is
      // still running. Durable cancellation settles independently of draining.
      const drain = (async () => {
        try {
          if (pendingNext) await pendingNext.catch(() => undefined);
          if (iterator?.return) await iterator.return();
          if (!lease && preparation)
            lease = await preparation.catch(() => undefined);
        } finally {
          await lease?.release();
        }
      })();
      active.drains.push(drain);
      void drain.catch(() => undefined);
    }
  }

  private emit(
    contestant: ArenaContestant,
    eventType?: RunEvent["type"],
  ): void {
    try {
      this.options.onUpdate?.(
        freezeJson({
          arenaRunId: contestant.arenaRunId,
          contestant: JSON.parse(JSON.stringify(contestant)) as ArenaContestant,
          ...(eventType ? { eventType } : {}),
        }),
      );
    } catch {
      /* UI observer failures cannot cancel another contestant. */
    }
  }

  private nextId(): string {
    return EntityIdSchema.parse(this.createId());
  }
}

class ArenaFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
class ArenaAbort extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof ArenaAbort
      ? signal.reason
      : new ArenaAbort("canceled");
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}
function emptyTiming(): ArenaTiming {
  return {
    preparationMs: 0,
    ttftMs: null,
    elapsedMs: 0,
    decodeMs: null,
    decodeTimingSource: null,
    providerOutputTokens: null,
    providerInputTokens: null,
    providerReportedTokensPerSecond: null,
    reportedTokenCountPerSecond: null,
    estimatedOutputTokens: 0,
    estimatedTokensPerSecond: null,
  };
}
function cleanFinishReason(value: string | undefined): string | null {
  return value && /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : null;
}
function reportedMetrics(
  timing: ArenaTiming,
  reported:
    | { outputTokensPerSecond?: number; decodeDurationMs?: number }
    | undefined,
): ArenaTiming {
  if (!reported) return timing;
  const rate = reported.outputTokensPerSecond;
  const decode = reported.decodeDurationMs;
  const validRate =
    typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
  const validDecode =
    typeof decode === "number" && Number.isFinite(decode) && decode >= 0;
  const decodeMs = validDecode ? decode : timing.decodeMs;
  return {
    ...timing,
    providerReportedTokensPerSecond: validRate ? rate : null,
    decodeMs,
    decodeTimingSource: validDecode
      ? "provider-reported"
      : timing.decodeTimingSource,
    reportedTokenCountPerSecond:
      decodeMs !== null && decodeMs > 0 && timing.providerOutputTokens !== null
        ? (timing.providerOutputTokens * 1000) / decodeMs
        : null,
    estimatedTokensPerSecond:
      decodeMs !== null && decodeMs > 0
        ? (timing.estimatedOutputTokens * 1000) / decodeMs
        : null,
  };
}
function readMetrics(binding: ArenaBinding, id: string) {
  try {
    const value = binding.readReportedMetrics?.(id);
    if (!value) return undefined;
    const outputTokensPerSecond = value.outputTokensPerSecond;
    const decodeDurationMs = value.decodeDurationMs;
    return {
      ...(outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond }),
      ...(decodeDurationMs === undefined ? {} : { decodeDurationMs }),
    };
  } catch {
    return undefined;
  }
}
function safeError(input: string): SafeError {
  const parsed = TypedErrorCodeSchema.safeParse(input);
  const code = parsed.success ? parsed.data : "malformed";
  const messages: Record<SafeError["code"], string> = {
    offline: "The contestant connection stopped responding.",
    unauthorized: "The contestant requires valid credentials.",
    permission: "Permission is required for this contestant.",
    unsupported:
      "A requested feature is unsupported or unverified for this model.",
    "missing-model": "The selected model is unavailable.",
    "context-full": "The prompt exceeds the contestant context window.",
    quota: "The contestant reached the configured resource limit.",
    timeout: "The contestant exceeded its time limit.",
    "host-stopped": "The contestant host stopped.",
    malformed: "The contestant returned an invalid stream.",
    canceled: "The contestant was stopped.",
  };
  return {
    code,
    message: messages[code],
    recoverable: !["unsupported", "malformed", "quota"].includes(code),
  };
}
function cloneJson<T>(value: T, maxBytes: number): T {
  const seen = new Set<object>();
  function inspect(current: unknown, depth = 0): void {
    if (depth > 32) throw new Error("Arena snapshot is too deeply nested");
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    )
      return;
    if (typeof current === "number" && Number.isFinite(current)) return;
    if (typeof current !== "object")
      throw new Error("Arena snapshots require JSON values");
    if (seen.has(current))
      throw new Error("Arena snapshots cannot contain cycles");
    if (
      !Array.isArray(current) &&
      Object.getPrototypeOf(current) !== Object.prototype &&
      Object.getPrototypeOf(current) !== null
    )
      throw new Error("Arena snapshots require plain JSON objects");
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      if (
        /^(?:api_?key|authorization|headers|credentials?|password|secret|access_?token|refresh_?token|token)$/i.test(
          key,
        )
      )
        throw new Error(
          "Provider secrets must remain in the connection resolver",
        );
      inspect(child, depth + 1);
    }
    seen.delete(current);
  }
  inspect(value);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > maxBytes)
    throw new RangeError(
      "Arena prompt/settings snapshot exceeds the byte limit",
    );
  return JSON.parse(json) as T;
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function copyConnection(value: unknown): unknown {
  // Resolved connection secrets remain in this in-memory copy. Its JSON is never
  // passed to the store or observers. Non-JSON resources belong on the port/lease.
  const json = JSON.stringify(value);
  if (json === undefined || json.length > 65_536)
    throw new Error("Arena connections require a bounded JSON descriptor");
  return JSON.parse(json) as unknown;
}
function uuidV7(now: Date): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let stamp = Math.max(0, now.getTime());
  for (let index = 5; index >= 0; index--) {
    bytes[index] = stamp % 256;
    stamp = Math.floor(stamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
