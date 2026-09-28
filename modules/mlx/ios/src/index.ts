import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";

export type MlxCapability = "yes" | "no" | "unknown";
export interface MlxCapabilities {
  runtime: MlxCapability;
  streaming: "yes";
  tokenizer: "yes";
  temperature: "yes";
  topP: "yes";
  maxTokens: "yes";
  tools: "no";
  jsonMode: "no";
  ggufAlternative: "yes";
  explanation?: string;
}
export interface MlxModelFolder {
  /** The app-managed model root, never a caller supplied filesystem path. */
  resolveManagedFolder(modelId: string): Promise<string | undefined>;
  validateFolder(
    folder: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}
export interface MlxNativeRuntime {
  capabilities(): Promise<MlxCapabilities>;
  run(input: {
    folder: string;
    messages: readonly { role: string; content: string }[];
    sampling: { temperature: number; topP: number; maxTokens: number };
    signal: AbortSignal;
  }): AsyncIterable<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "usage"; inputTokens?: number; outputTokens?: number }
  >;
  dispose?(): Promise<void>;
}
export interface InferencePort {
  startRun(request: RunRequest, signal: AbortSignal): AsyncIterable<RunEvent>;
  dispose(): Promise<void>;
}

type EventFields = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp">
    : never
  : never;

/** Managed-folder MLX adapter. GGUF remains an independent backend and is never selected here. */
export function createMlxInferencePort(options: {
  folders: MlxModelFolder;
  runtime: MlxNativeRuntime;
}): InferencePort {
  let disposed = false;
  const active = new Set<AbortController>();
  return {
    async *startRun(request, signal) {
      let sequence = 0;
      const emit = (fields: EventFields): RunEvent =>
        ({
          ...fields,
          runId: request.runId,
          sequence: sequence++,
          timestamp: new Date().toISOString(),
        }) as RunEvent;
      yield emit({ type: "RunStarted" });
      if (disposed) {
        yield emit({
          type: "RunFailed",
          error: {
            code: "host-stopped",
            message: "MLX runtime is disposed",
            recoverable: false,
          },
        });
        return;
      }
      if (signal.aborted) {
        yield emit({ type: "RunCanceled", reason: "aborted" });
        return;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      active.add(controller);
      try {
        if (!request.modelId.startsWith("mlx:"))
          throw Object.assign(
            new Error("Selected model is not an MLX managed-folder model"),
            { code: "missing-model" },
          );
        const capabilities = await options.runtime.capabilities();
        if (capabilities.runtime !== "yes") {
          yield emit({
            type: "RunFailed",
            error: {
              code:
                capabilities.runtime === "no"
                  ? "unsupported-hardware"
                  : "capability-unknown",
              message:
                capabilities.explanation ??
                "MLX hardware capability is not confirmed; use GGUF or a remote provider.",
              recoverable: true,
            },
          });
          return;
        }
        const folder = await options.folders.resolveManagedFolder(
          request.modelId,
        );
        if (!folder)
          throw Object.assign(
            new Error("Selected model has no managed MLX folder"),
            { code: "missing-model" },
          );
        const validation = await options.folders.validateFolder(folder);
        if (!validation.ok)
          throw Object.assign(new Error(validation.reason), {
            code: "malformed",
          });
        if (controller.signal.aborted) {
          yield emit({
            type: "RunCanceled",
            reason: "aborted during model validation",
          });
          return;
        }
        const messages = request.context.map(({ kind, value }) => ({
          role: kind,
          content: textOf(value),
        }));
        const p = request.parameters;
        const sampling = {
          temperature: boundedNumber(p["temperature"], 0.7, 0, 2),
          topP: boundedNumber(p["top_p"], 0.95, 0.01, 1),
          maxTokens: boundedInteger(p["max_tokens"], 512, 1, 8192),
        };
        yield emit({
          type: "LoadProgress",
          fraction: 0,
          detail: "Loading managed MLX model folder",
        });
        for await (const item of options.runtime.run({
          folder,
          messages,
          sampling,
          signal: controller.signal,
        })) {
          if (item.type === "text" && item.text)
            yield emit({ type: "TextDelta", text: item.text });
          else if (item.type === "reasoning" && item.text && request.reasoning)
            yield emit({ type: "ReasoningDelta", text: item.text });
          else if (item.type === "usage")
            yield emit({
              type: "Usage",
              ...(item.inputTokens === undefined
                ? {}
                : { inputTokens: item.inputTokens }),
              ...(item.outputTokens === undefined
                ? {}
                : { outputTokens: item.outputTokens }),
            });
        }
        if (controller.signal.aborted)
          yield emit({ type: "RunCanceled", reason: "aborted" });
        else yield emit({ type: "RunCompleted", finishReason: "stop" });
      } catch (error) {
        if (controller.signal.aborted)
          yield emit({ type: "RunCanceled", reason: "aborted" });
        else {
          const message =
            error instanceof Error ? error.message : "MLX inference failed";
          const code =
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : /memory|alloc/i.test(message)
                ? "quota"
                : "inference-failed";
          yield emit({
            type: "RunFailed",
            error: { code, message, recoverable: code !== "malformed" },
          });
        }
      } finally {
        signal.removeEventListener("abort", abort);
        active.delete(controller);
      }
    },
    async dispose() {
      disposed = true;
      for (const controller of active) controller.abort();
      await options.runtime.dispose?.();
    },
  };
}

function textOf(value: unknown): string {
  return typeof value === "string"
    ? value
    : value &&
        typeof value === "object" &&
        "text" in value &&
        typeof value.text === "string"
      ? value.text
      : "";
}
function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, n));
}
function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return Math.trunc(boundedNumber(value, fallback, min, max));
}
