import type {
  CapabilityMap,
  PortResult,
  ProviderPort,
} from "@locallab/contracts/ports";
import { EntityIdSchema, type Revision } from "@locallab/contracts/identity";
import {
  localFailureCause,
  retainLocalFailureCause,
} from "@locallab/contracts/local-failure-details";
import {
  conservativeTokenCount,
  ContextBudgetError,
  type ContextMessage,
} from "@locallab/context";
import {
  RunEventSchema,
  RunRequestSchema,
  type RunEvent,
  type RunRequest,
} from "@locallab/contracts/run-events";
export { SQLiteToolInvocationStore, TOOL_ENGINE_SQL } from "./sqlite";
export type { StoredToolInvocation } from "./sqlite";

export interface ToolExecutionContext {
  readonly invocationId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly participantId?: string;
  readonly signal: AbortSignal;
}
export interface RegisteredTool {
  readonly name: string;
  readonly serverId: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
  /** A registered parser validates the arguments before any tool executes. */
  readonly parseInput: (input: unknown) => unknown;
  readonly execute: (
    input: unknown,
    context: ToolExecutionContext,
  ) => Promise<PortResult<unknown>>;
}
export interface ToolRunPolicy {
  readonly globalEnabled: boolean;
  readonly chatEnabled?: boolean;
  readonly participantEnabled?: boolean;
  readonly participantId?: string;
  readonly capabilities: CapabilityMap;
  /** null removes the round cap, retaining the deadline and resource limits. */
  readonly roundLimit?: number | null;
  readonly deadlineMs?: number;
  readonly maxToolCalls?: number;
  readonly maxGeneratedCharacters?: number;
  readonly maxArgumentBytes?: number;
  readonly maxResultBytes?: number;
  readonly maxContextBytes?: number;
  readonly maxEventBytes?: number;
  readonly maxEvents?: number;
  readonly maxTotalEventBytes?: number;
  /** Active model capacity, including the response reservation, checked on every round. */
  readonly tokenBudget?: number;
  readonly reservedOutputTokens?: number;
}
export interface ToolInvocationRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown | null;
  readonly state: "pending" | "running" | "completed" | "canceled" | "failed";
  readonly participantId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: Revision;
}
export type ToolInvocationTerminalState = Extract<
  ToolInvocationRecord["state"],
  "completed" | "failed" | "canceled"
>;
export interface ToolInvocationStore {
  begin(
    input: Omit<
      ToolInvocationRecord,
      "createdAt" | "updatedAt" | "revision" | "output" | "state"
    >,
  ): Promise<ToolInvocationRecord>;
  /** Atomically claim pending work; existing running/terminal work is never claimed twice. */
  claimExecution(id: string): Promise<{
    claimed: boolean;
    record: ToolInvocationRecord;
  }>;
  finish(
    id: string,
    state: ToolInvocationTerminalState,
    output: unknown | null,
  ): Promise<ToolInvocationRecord>;
}
export interface ToolLoopClock {
  now(): number;
  timestamp(): string;
  schedule(milliseconds: number, callback: () => void): () => void;
}
const defaultClock: ToolLoopClock = {
  now: () => performance.now(),
  timestamp: () => new Date().toISOString(),
  schedule(milliseconds, callback) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

export class ToolEngineError extends Error {
  constructor(
    readonly code:
      | "malformed"
      | "unsupported"
      | "permission"
      | "quota"
      | "timeout"
      | "canceled",
    message: string,
  ) {
    super(message);
    this.name = "ToolEngineError";
  }
}

/** Registry changes take effect on the next run, never halfway through execution. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  register(tool: RegisteredTool) {
    EntityIdSchema.parse(tool.serverId);
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name))
      throw new ToolEngineError(
        "malformed",
        "Use a stable tool name of up to 64 characters.",
      );
    if (this.tools.has(tool.name))
      throw new ToolEngineError(
        "malformed",
        "A tool with that name is already registered.",
      );
    if (
      tool.parameters.type !== "object" ||
      typeof tool.parseInput !== "function" ||
      typeof tool.execute !== "function"
    )
      throw new ToolEngineError(
        "malformed",
        "Tools require an object schema, argument parser, and executor.",
      );
    this.tools.set(
      tool.name,
      Object.freeze({ ...tool, parameters: immutableJson(tool.parameters) }),
    );
  }
  remove(name: string) {
    this.tools.delete(name);
  }
  setEnabled(name: string, enabled: boolean) {
    const tool = this.tools.get(name);
    if (!tool)
      throw new ToolEngineError(
        "malformed",
        "The selected tool is unavailable.",
      );
    this.tools.set(name, Object.freeze({ ...tool, enabled }));
  }
  snapshot(
    policy: ToolRunPolicy,
    permittedNames: readonly string[],
  ): readonly RegisteredTool[] {
    const enabled =
      policy.participantEnabled ?? policy.chatEnabled ?? policy.globalEnabled;
    if (!enabled || policy.capabilities.tools !== "yes") return [];
    return [...new Set(permittedNames)].flatMap((name) => {
      const tool = this.tools.get(name);
      return tool?.enabled ? [tool] : [];
    });
  }
}

export interface ToolLoopOptions {
  readonly registry: ToolRegistry;
  readonly store?: ToolInvocationStore;
  readonly createId?: () => string;
  readonly clock?: ToolLoopClock;
  /** Adapter-specific replay may replace the canonical role/JSON continuation. */
  readonly appendExchange?: (
    context: RunRequest["context"],
    exchange: ToolRoundExchange,
  ) => RunRequest["context"];
}
export interface ToolRoundExchange {
  readonly text: string;
  readonly calls: readonly {
    invocationId: string;
    name: string;
    input: unknown;
    output: unknown;
  }[];
}

/** Emits one aggregate run while provider rounds retain separate, strictly checked identities. */
export class ToolLoopEngine {
  constructor(private readonly options: ToolLoopOptions) {}
  wrap<C>(
    provider: ProviderPort<C>,
    policy: (request: RunRequest) => ToolRunPolicy | Promise<ToolRunPolicy>,
  ): ProviderPort<C> {
    const engine = this;
    return {
      listModels: provider.listModels.bind(provider),
      getCapabilities: provider.getCapabilities.bind(provider),
      ...(provider.dispose ? { dispose: provider.dispose.bind(provider) } : {}),
      async *startRun(request, signal) {
        let resolved: ToolRunPolicy;
        try {
          resolved = snapshotPolicy(
            await resolvePolicy(
              () => policy(request),
              signal,
              engine.options.clock ?? defaultClock,
            ),
          );
        } catch (error) {
          const clock = engine.options.clock ?? defaultClock;
          yield {
            type: "RunStarted",
            runId: request.runId,
            sequence: 0,
            timestamp: clock.timestamp(),
          };
          const failure = failureFor(error);
          yield {
            ...(failure.code === "canceled"
              ? { type: "RunCanceled" as const, reason: "canceled" }
              : { type: "RunFailed" as const, error: failure }),
            runId: request.runId,
            sequence: 1,
            timestamp: clock.timestamp(),
          };
          return;
        }
        yield* engine.startRun(request, provider, resolved, signal);
      },
    };
  }

  async *startRun(
    input: RunRequest,
    provider: Pick<ProviderPort, "startRun">,
    inputPolicy: ToolRunPolicy,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const request = immutableJson(RunRequestSchema.parse(input));
    const policy = snapshotPolicy(inputPolicy);
    const clock = this.options.clock ?? defaultClock;
    const createId = this.options.createId ?? uuid7;
    const tools = this.options.registry.snapshot(
      policy,
      request.permittedTools,
    );
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const roundLimit =
      policy.roundLimit === null
        ? null
        : bound(policy.roundLimit ?? 8, 1, 1024, "round limit");
    const deadlineMs = bound(
      policy.deadlineMs ?? 60_000,
      1,
      300_000,
      "deadline",
    );
    const maxCalls = bound(
      policy.maxToolCalls ?? 128,
      1,
      1024,
      "tool call limit",
    );
    const maxCharacters = bound(
      policy.maxGeneratedCharacters ?? 256_000,
      1,
      2_000_000,
      "output limit",
    );
    const maxArgumentBytes = bound(
      policy.maxArgumentBytes ?? 64_000,
      1,
      1_000_000,
      "argument limit",
    );
    const maxResultBytes = bound(
      policy.maxResultBytes ?? 128_000,
      1,
      2_000_000,
      "result limit",
    );
    const maxContextBytes = bound(
      policy.maxContextBytes ?? 4_000_000,
      1,
      16_000_000,
      "context limit",
    );
    const maxEventBytes = bound(
      policy.maxEventBytes ?? 256 * 1024,
      1024,
      1024 * 1024,
      "event byte limit",
    );
    const maxEvents = bound(
      policy.maxEvents ?? 20_000,
      2,
      20_000,
      "event count limit",
    );
    const maxTotalEventBytes = bound(
      policy.maxTotalEventBytes ?? 4 * 1024 * 1024,
      2048,
      32 * 1024 * 1024,
      "aggregate event byte limit",
    );
    if (policy.participantId) EntityIdSchema.parse(policy.participantId);
    const controller = new AbortController();
    const abort = () =>
      controller.abort(
        new ToolEngineError("canceled", "Tool generation was canceled."),
      );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const expiresAt = clock.now() + deadlineMs;
    const stopTimer = clock.schedule(deadlineMs, () =>
      controller.abort(
        new ToolEngineError("timeout", "Tool generation reached its deadline."),
      ),
    );
    let sequence = 0,
      generatedCharacters = 0,
      callCount = 0,
      providerEvents = 0,
      emittedBytes = 0;
    let context = immutableJson(
      request.context.filter((item) => item.kind !== "tool-definitions"),
    );
    let iterator: AsyncIterator<RunEvent> | undefined;
    const pending = new Set<string>();
    const claimed = new Set<string>();
    const seenCalls = new Set<string>();
    const emit = (value: EventPayload): RunEvent => {
      if (!isTerminal(value.type) && sequence >= maxEvents - 1)
        throw new ToolEngineError(
          "quota",
          "Tool generation reached its event count limit.",
        );
      const event = {
        ...value,
        runId: request.runId,
        sequence,
        timestamp: clock.timestamp(),
        ...(policy.participantId
          ? { participantId: policy.participantId }
          : {}),
      } as RunEvent;
      const bytes = assertBytes(
        event,
        maxEventBytes,
        "The tool event exceeds its size limit.",
      );
      // Reserve one safe terminal event when the aggregate budget fills.
      if (
        emittedBytes + bytes + (isTerminal(event.type) ? 0 : 1024) >
        maxTotalEventBytes
      )
        throw new ToolEngineError(
          "quota",
          "Tool generation reached its aggregate event size limit.",
        );
      emittedBytes += bytes;
      sequence++;
      return event;
    };
    const check = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (clock.now() >= expiresAt) {
        controller.abort(
          new ToolEngineError(
            "timeout",
            "Tool generation reached its deadline.",
          ),
        );
        throw controller.signal.reason;
      }
    };
    try {
      yield emit({ type: "RunStarted" });
      for (let round = 1; ; round++) {
        check();
        if (roundLimit !== null && round > roundLimit)
          throw new ToolEngineError(
            "quota",
            "Tool generation reached its round limit.",
          );
        assertBytes(
          context,
          maxContextBytes,
          "The tool conversation exceeds its context size limit.",
        );
        const definitions = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }));
        const parameters = withoutToolSchemas(request.parameters);
        if (definitions.length)
          parameters.tools = definitions.map((definition) => ({
            type: "function",
            function: definition,
          }));
        const child: RunRequest = {
          ...request,
          runId: createId(),
          parameters,
          permittedTools: tools.map((tool) => tool.name),
          context: [
            ...context,
            ...(definitions.length
              ? [{ kind: "tool-definitions", value: definitions }]
              : []),
          ],
        };
        assertBytes(
          { context: child.context, parameters: child.parameters },
          maxContextBytes,
          "The tool request exceeds its context size limit.",
        );
        checkTokenBudget(child, policy);
        EntityIdSchema.parse(child.runId);
        iterator = provider
          .startRun(child, controller.signal)
          [Symbol.asyncIterator]();
        let previous = -1,
          completed = false,
          finishReason: string | undefined,
          text = "";
        const calls: Array<{
          event: Extract<RunEvent, { type: "ToolCall" }>;
          tool: RegisteredTool;
          parsed: unknown;
        }> = [];
        while (!completed) {
          check();
          const next = await abortable(iterator.next(), controller.signal);
          check();
          if (next.done)
            throw new ToolEngineError(
              "malformed",
              "The provider stream ended without a terminal event.",
            );
          if (++providerEvents > maxEvents)
            throw new ToolEngineError(
              "quota",
              "Tool generation reached its provider event count limit.",
            );
          assertBytes(
            next.value,
            maxEventBytes,
            "The provider event exceeds its size limit.",
          );
          const event = RunEventSchema.parse(next.value);
          if (event.type === "RunFailed" && next.value.type === "RunFailed")
            retainLocalFailureCause(
              event.error,
              localFailureCause(next.value.error),
            );
          if (event.runId !== child.runId || event.sequence <= previous)
            throw new ToolEngineError(
              "malformed",
              "The provider emitted an invalid run identity or sequence.",
            );
          previous = event.sequence;
          if (event.type === "RunStarted") continue;
          if (event.type === "RunCanceled")
            throw new ToolEngineError(
              "canceled",
              "The provider canceled tool generation.",
            );
          if (event.type === "RunFailed") {
            yield emit({
              type: "RunFailed",
              error: event.error,
            });
            return;
          }
          if (event.type === "RunCompleted") {
            completed = true;
            finishReason = event.finishReason;
            continue;
          }
          if (event.type === "TextDelta" || event.type === "ReasoningDelta") {
            generatedCharacters += event.text.length;
            if (generatedCharacters > maxCharacters)
              throw new ToolEngineError(
                "quota",
                "Tool generation exceeds its output size limit.",
              );
            if (event.type === "TextDelta") text += event.text;
          }
          if (event.type === "ToolResult")
            throw new ToolEngineError(
              "malformed",
              "The provider cannot execute a registered client tool.",
            );
          if (event.type === "ToolCall") {
            const tool = byName.get(event.name);
            if (!tool)
              throw new ToolEngineError(
                "permission",
                "The provider requested a disabled or unsupported tool.",
              );
            if (seenCalls.has(event.invocationId))
              throw new ToolEngineError(
                "malformed",
                "The provider repeated a tool invocation identity.",
              );
            seenCalls.add(event.invocationId);
            if (++callCount > maxCalls)
              throw new ToolEngineError(
                "quota",
                "Tool generation reached its call limit.",
              );
            assertBytes(
              event.input,
              maxArgumentBytes,
              "Tool arguments exceed their size limit.",
            );
            let parsed: unknown;
            try {
              parsed = immutableJson(tool.parseInput(event.input));
            } catch (cause) {
              const failure = new ToolEngineError(
                "malformed",
                `Arguments for ${tool.name} did not match the registered schema.`,
              );
              retainLocalFailureCause(
                failure,
                cause !== null &&
                  (typeof cause === "object" || typeof cause === "function")
                  ? localFailureCause(cause)
                  : cause,
              );
              throw failure;
            }
            assertBytes(
              parsed,
              maxArgumentBytes,
              "Validated tool arguments exceed their size limit.",
            );
            await this.options.store?.begin({
              id: event.invocationId,
              conversationId: request.conversationId,
              runId: request.runId,
              serverId: tool.serverId,
              toolName: tool.name,
              input: parsed,
              ...(policy.participantId
                ? { participantId: policy.participantId }
                : {}),
            });
            pending.add(event.invocationId);
            // Registration precedes cancellation checks so every saved pending call is settled.
            check();
            calls.push({ event, tool, parsed });
          }
          const {
            runId: _runId,
            sequence: _sequence,
            timestamp: _timestamp,
            participantId: _participant,
            ...payload
          } = event;
          yield emit(payload);
        }
        const finishedIterator = iterator;
        iterator = undefined;
        void finishedIterator.return?.().catch(() => {});
        if (!calls.length) {
          yield emit({
            type: "RunCompleted",
            finishReason: finishReason ?? "stop",
          });
          return;
        }
        const exchange: ToolRoundExchange = { text, calls: [] };
        const results: Array<ToolRoundExchange["calls"][number]> = [];
        for (const call of calls) {
          check();
          let output: unknown;
          let state: ToolInvocationTerminalState = "completed";
          const execution = await this.options.store?.claimExecution(
            call.event.invocationId,
          );
          if (execution?.claimed) claimed.add(call.event.invocationId);
          check();
          if (execution && !execution.claimed) {
            if (
              execution.record.state === "running" ||
              execution.record.state === "pending"
            )
              throw new ToolEngineError(
                "malformed",
                "A previous tool invocation still needs recovery.",
              );
            output = immutableJson(execution.record.output);
            state = execution.record.state;
          } else {
            try {
              const result = await abortable(
                call.tool.execute(call.parsed, {
                  invocationId: call.event.invocationId,
                  conversationId: request.conversationId,
                  runId: request.runId,
                  ...(policy.participantId
                    ? { participantId: policy.participantId }
                    : {}),
                  signal: controller.signal,
                }),
                controller.signal,
              );
              check();
              if (result.ok) output = immutableJson(result.value);
              else {
                const error = immutableJson(result.error);
                retainLocalFailureCause(error, localFailureCause(result.error));
                output = { error };
              }
              state = result.ok ? "completed" : "failed";
              assertBytes(
                output,
                maxResultBytes,
                "The tool result exceeds its size limit.",
              );
            } catch (error) {
              if (controller.signal.aborted) throw controller.signal.reason;
              const known = error instanceof ToolEngineError;
              const failure = safeFailure(
                known ? error.code : "tool-error",
                known ? error.message : undefined,
              );
              retainLocalFailureCause(
                failure,
                error !== null &&
                  (typeof error === "object" || typeof error === "function")
                  ? localFailureCause(error)
                  : error,
              );
              output = {
                error: failure,
              };
              state = "failed";
            }
            await this.options.store?.finish(
              call.event.invocationId,
              state,
              output,
            );
          }
          assertBytes(
            output,
            maxResultBytes,
            "The saved tool result exceeds its size limit.",
          );
          pending.delete(call.event.invocationId);
          claimed.delete(call.event.invocationId);
          results.push({
            invocationId: call.event.invocationId,
            name: call.tool.name,
            input: call.parsed,
            output,
          });
          yield emit({
            type: "ToolResult",
            invocationId: call.event.invocationId,
            output,
          });
        }
        context = immutableJson(
          (this.options.appendExchange ?? appendToolExchange)(context, {
            ...exchange,
            calls: results,
          }),
        );
      }
    } catch (error) {
      const failure = failureFor(error);
      yield failure.code === "canceled"
        ? emit({ type: "RunCanceled", reason: "canceled" })
        : emit({ type: "RunFailed", error: failure });
    } finally {
      if (!controller.signal.aborted)
        controller.abort(
          new ToolEngineError("canceled", "Tool generation closed."),
        );
      stopTimer();
      signal.removeEventListener("abort", abort);
      void iterator?.return?.().catch(() => {});
      for (const id of pending) {
        // A losing/replayed loop must never cancel work claimed by another loop.
        const ownClaim = claimed.has(id)
          ? true
          : (await this.options.store?.claimExecution(id))?.claimed;
        if (ownClaim)
          await this.options.store?.finish(id, "canceled", {
            error: safeFailure("canceled"),
          });
      }
    }
  }
}

/** Canonical structured replay; an adapter may project it into its vendor protocol. */
export function appendToolExchange(
  context: RunRequest["context"],
  exchange: ToolRoundExchange,
): RunRequest["context"] {
  return [
    ...context,
    {
      kind: "assistant",
      value: {
        role: "assistant",
        content: exchange.text,
        tool_calls: exchange.calls.map((call) => ({
          id: call.invocationId,
          type: "function",
          function: { name: call.name, arguments: call.input },
        })),
      },
    },
    ...exchange.calls.map((call) => ({
      kind: "tool",
      value: {
        role: "tool",
        tool_call_id: call.invocationId,
        name: call.name,
        content: JSON.stringify(call.output),
      },
    })),
  ];
}

type EventPayload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp" | "participantId">
    : never
  : never;
function withoutToolSchemas(parameters: RunRequest["parameters"]) {
  const result = { ...parameters };
  delete result.tools;
  delete result.tool_choice;
  delete result.functions;
  delete result.function_call;
  return result;
}
function bound(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new ToolEngineError("malformed", "Invalid " + label + ".");
  return value;
}
function assertBytes(value: unknown, maximum: number, message: string) {
  const json = JSON.stringify(value);
  if (json === undefined || json.length > maximum)
    throw new ToolEngineError("quota", message);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > maximum) throw new ToolEngineError("quota", message);
  return bytes;
}
function snapshotPolicy(input: ToolRunPolicy): ToolRunPolicy {
  const policy = immutableJson(input);
  for (const [name, value] of [
    ["globalEnabled", policy.globalEnabled],
    ["chatEnabled", policy.chatEnabled],
    ["participantEnabled", policy.participantEnabled],
  ] as const) {
    if (
      (name === "globalEnabled" || value !== undefined) &&
      typeof value !== "boolean"
    )
      throw new ToolEngineError(
        "malformed",
        "Tool-use switches require boolean values.",
      );
  }
  if (
    !policy.capabilities ||
    typeof policy.capabilities !== "object" ||
    Array.isArray(policy.capabilities) ||
    Object.values(policy.capabilities).some(
      (value) => !["yes", "no", "unknown"].includes(value),
    )
  )
    throw new ToolEngineError(
      "malformed",
      "Tool capabilities require verified capability states.",
    );
  return policy;
}
function isTerminal(type: RunEvent["type"]): boolean {
  return (
    type === "RunCompleted" || type === "RunCanceled" || type === "RunFailed"
  );
}
async function resolvePolicy(
  resolve: () => ToolRunPolicy | Promise<ToolRunPolicy>,
  signal: AbortSignal,
  clock: ToolLoopClock,
): Promise<ToolRunPolicy> {
  if (signal.aborted)
    throw new ToolEngineError("canceled", "Tool setup was canceled.");
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      new ToolEngineError("canceled", "Tool setup was canceled."),
    );
  signal.addEventListener("abort", abort, { once: true });
  const stopTimer = clock.schedule(60_000, () =>
    controller.abort(
      new ToolEngineError("timeout", "Tool setup reached its deadline."),
    ),
  );
  try {
    return await abortable(Promise.resolve().then(resolve), controller.signal);
  } finally {
    stopTimer();
    signal.removeEventListener("abort", abort);
  }
}
function immutableJson<T>(value: T): T {
  const clone: T = JSON.parse(JSON.stringify(value));
  const freeze = (item: unknown) => {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(clone);
  return clone;
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    throw signal.reason;
  }
  let cancel!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
function safeFailure(code: string, knownMessage?: string) {
  const messages: Record<string, string> = {
    unauthorized: "The provider rejected its saved credential.",
    offline: "The selected provider is offline.",
    "missing-model": "Select an available model before retrying.",
    "context-full": "Shorten the context before retrying.",
    permission: "The requested tool is not permitted.",
    unsupported: "This model cannot use the selected tools.",
    canceled: "Tool generation was canceled.",
    timeout: "Tool generation reached its deadline.",
    quota: "Tool generation reached a resource limit.",
    malformed: "Tool generation received an invalid response.",
    "tool-error": "The tool could not complete the request.",
  };
  return {
    code: messages[code] ? code : "tool-error",
    message: knownMessage ?? messages[code] ?? messages["tool-error"]!,
    recoverable: true,
  };
}
function failureFor(cause: unknown) {
  const known =
    cause instanceof ToolEngineError || cause instanceof ContextBudgetError;
  const failure = safeFailure(
    known ? cause.code : "malformed",
    known ? cause.message : undefined,
  );
  retainLocalFailureCause(
    failure,
    cause !== null && (typeof cause === "object" || typeof cause === "function")
      ? localFailureCause(cause)
      : cause,
  );
  return failure;
}
function checkTokenBudget(request: RunRequest, policy: ToolRunPolicy) {
  if (policy.tokenBudget === undefined) return;
  const budget = bound(policy.tokenBudget, 2, 2_000_000, "token budget");
  const reserved = bound(
    policy.reservedOutputTokens ?? 512,
    1,
    budget - 1,
    "output reservation",
  );
  const messages: ContextMessage[] = request.context.map((item, index) => ({
    id: `tool-round-context-${index}`,
    role: ["system", "developer", "user", "assistant", "tool"].includes(
      item.kind,
    )
      ? (item.kind as ContextMessage["role"])
      : "system",
    parts: [
      {
        type: "text",
        text:
          typeof item.value === "string"
            ? item.value
            : JSON.stringify(item.value),
      },
    ],
  }));
  const estimate = conservativeTokenCount(messages);
  const capacity = budget - reserved;
  if (estimate > capacity)
    throw new ContextBudgetError(
      `Tool continuation needs approximately ${estimate} input tokens, but the input budget is ${capacity} (${budget} context tokens minus ${reserved} reserved for the response). Shorten the tool output or persona, increase context to match the active model, or lower the output token limit.`,
    );
}
function uuid7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let now = BigInt(Date.now());
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(now & 255n);
    now >>= 8n;
  }
  bytes[6] = (bytes[6]! & 15) | 112;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}
