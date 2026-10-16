import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import type { BlobMetadata, BlobStore } from "@locallab/storage-blobs";
import type { LlamaContext } from "llama.rn";
import {
  createLlamaStreamDecoder,
  type StreamDeltas,
} from "./stream-decoder";

type RunEventFields = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, "runId" | "sequence" | "timestamp">
    : never
  : never;

export interface InferencePort {
  startRun(request: RunRequest, signal: AbortSignal): AsyncIterable<RunEvent>;
  dispose(): Promise<void>;
}

export interface ManagedModelFile {
  /** Blob ID from the app-owned blob catalog; arbitrary paths and URIs are rejected. */
  blobId: string;
}

export interface ModelFileLease {
  uri: string;
  release(): Promise<void>;
}

export interface ManagedModelFiles {
  /** Verifies the catalog entry and GGUF signature, then returns a protected runtime lease. */
  acquire(
    model: ManagedModelFile,
    signal?: AbortSignal,
  ): Promise<ModelFileLease>;
}

export type LlamaRuntime = {
  initLlama(
    options: {
      model: string;
      n_ctx: number;
      n_batch: number;
      n_gpu_layers: number;
      n_parallel: number;
      use_mlock: boolean;
    },
    onProgress?: (fraction: number) => void,
  ): Promise<LlamaContext>;
};

export type GgufInferenceOptions = {
  files: ManagedModelFiles;
  runtime?: LlamaRuntime;
  contextSize?: number;
  batchSize?: number;
  gpuLayers?: number;
  memory?: { availableBytes(): Promise<number> };
  thermal?: {
    currentState(): Promise<
      "nominal" | "fair" | "serious" | "critical" | "unknown"
    >;
  };
  maxContextSize?: number;
};

/** Converts the shared RunRequest stream contract to the pinned llama.rn API. */
export function createGgufInferencePort(
  options: GgufInferenceOptions,
): InferencePort {
  const active = new Set<{
    cancel(): Promise<void>;
    resourcesDrained: Promise<void>;
  }>();
  let disposed = false;
  return {
    async *startRun(request, signal) {
      if (disposed) throw typedError("host-stopped", "GGUF worker is disposed");
      if (signal.aborted) {
        yield event(request, 0, { type: "RunCanceled", reason: "aborted" });
        return;
      }
      let sequence = 0;
      const emit = (fields: RunEventFields): RunEvent =>
        event(request, sequence++, fields);
      yield emit({ type: "RunStarted" });

      let lease: ModelFileLease | undefined;
      let context: LlamaContext | undefined;
      let run:
        | Awaited<ReturnType<LlamaContext["parallel"]["completion"]>>
        | undefined;
      let canceled = false;
      let settled = false;
      let cancelPromise: Promise<void> | undefined;
      let resolveDrained!: () => void;
      let rejectDrained!: (error: unknown) => void;
      const resourcesDrained = new Promise<void>((resolve, reject) => {
        resolveDrained = resolve;
        rejectDrained = reject;
      });
      // Cleanup failures are reported by the iterator/dispose caller.
      void resourcesDrained.catch(() => undefined);
      const cancel = async () => {
        if (settled || canceled) return;
        canceled = true;
        cancelPromise = run ? run.stop() : Promise.resolve();
        await cancelPromise;
      };
      const onAbort = () => {
        void cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const activeRun = { cancel, resourcesDrained };
      active.add(activeRun);
      try {
        if (disposed || signal.aborted) {
          canceled = true;
          yield emit({
            type: "RunCanceled",
            reason: "host stopped or aborted",
          });
          return;
        }
        const model = parseManagedModel(request.modelId);
        lease = await options.files.acquire(model, signal);
        if (canceled || signal.aborted) {
          canceled = true;
          yield emit({
            type: "RunCanceled",
            reason: "aborted during model validation",
          });
          return;
        }
        const memory = await options.memory?.availableBytes();
        const chosenContext = boundedInteger(
          request.parameters["contextWindow"] ?? request.parameters["n_ctx"],
          options.contextSize ?? 2048,
          256,
          options.maxContextSize ?? 8192,
        );
        const thermal = (await options.thermal?.currentState()) ?? "unknown";
        const thermalBound =
          thermal === "critical"
            ? 512
            : thermal === "serious"
              ? 1024
              : (options.maxContextSize ?? 8192);
        const availableBound =
          memory === undefined
            ? chosenContext
            : Math.max(256, Math.floor(memory / 1_500_000));
        const nCtx = Math.min(
          chosenContext,
          availableBound,
          thermalBound,
          options.maxContextSize ?? 8192,
        );
        const nBatch = boundedInteger(
          request.parameters["n_batch"],
          options.batchSize ?? 256,
          32,
          Math.min(nCtx, 1024),
        );
        const thermalGpuBound =
          thermal === "critical" ? 0 : thermal === "serious" ? 16 : 256;
        const nGpuLayers = boundedInteger(
          request.parameters["n_gpu_layers"],
          options.gpuLayers ?? 99,
          0,
          Math.min(256, thermalGpuBound),
        );
        const runtime = options.runtime ?? (await loadRuntime());
        context = await runtime.initLlama(
          {
            model: lease.uri,
            n_ctx: nCtx,
            n_batch: nBatch,
            n_gpu_layers: nGpuLayers,
            n_parallel: 1,
            use_mlock: false,
          },
          (fraction) => {
            void fraction;
          },
        );
        if (canceled || signal.aborted) {
          canceled = true;
          yield emit({
            type: "RunCanceled",
            reason: "aborted during model load",
          });
          return;
        }

        // Queued completions require parallel mode in llama.rn 0.12.4.
        // One slot retains the full selected context for this foreground
        // run; initLlama already reserved that slot via n_parallel: 1, so
        // runtimes without a runtime enable/configure toggle are valid and
        // must not be failed by an unconditional enable call.
        if (typeof context.parallel.enable === "function") {
          await context.parallel.enable({ n_parallel: 1, n_batch: nBatch });
        }
        if (canceled || signal.aborted) {
          canceled = true;
          yield emit({
            type: "RunCanceled",
            reason: "aborted during admission",
          });
          return;
        }

        const messages = request.context.map(({ kind, value }) => ({
          role: kind === "text" ? "user" : kind,
          content: textOf(value),
        }));
        const prompt = textOf(request.context.at(-1)?.value);
        const params = request.parameters;
        const completionParams = {
          messages,
          n_predict: boundedInteger(
            params["max_output_tokens"] ??
              params["max_tokens"] ??
              params["maxOutputTokens"],
            512,
            1,
            8192,
          ),
          temperature: boundedNumber(params["temperature"], 0.7, 0, 2),
          top_p: boundedNumber(params["top_p"], 0.95, 0, 1),
          enable_thinking:
            typeof params["enable_thinking"] === "boolean"
              ? params["enable_thinking"]
              : request.reasoning,
          // Native parsing moves template think blocks into reasoning_content.
          reasoning_format: "auto" as const,
          ...(request.json
            ? { response_format: { type: "json_object" as const } }
            : {}),
          ...(messages.length ? {} : { prompt }),
        };
        const queued: RunEvent[] = [];
        let wake: (() => void) | undefined;
        const notify = () => {
          wake?.();
          wake = undefined;
        };
        const decoder = createLlamaStreamDecoder();
        const queueDeltas = ({ reasoning, text }: StreamDeltas) => {
          if (reasoning)
            queued.push(emit({ type: "ReasoningDelta", text: reasoning }));
          if (text) queued.push(emit({ type: "TextDelta", text }));
        };
        const pending = await context.parallel.completion(
          completionParams,
          (_id, token) => {
            queueDeltas(decoder.push(token));
            notify();
          },
        );
        run = pending;
        // Abort may race while llama.rn creates the request handle.
        if (canceled) {
          cancelPromise = pending.stop();
          await cancelPromise;
        }
        const resultPromise = pending.promise;
        const streamPromise = resultPromise.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        void streamPromise.then(notify);
        // Drain queued token events while waiting for completion, with no polling delay.
        while (true) {
          while (queued.length) yield queued.shift()!;
          const outcome = await Promise.race([
            streamPromise,
            new Promise<undefined>((resolve) => {
              wake = () => resolve(undefined);
            }),
          ]);
          if (!outcome) continue;
          if ("error" in outcome) {
            if (!canceled) throw outcome.error;
          }
          break;
        }
        while (queued.length) yield queued.shift()!;
        settled = true;
        if (cancelPromise) await cancelPromise;
        if (canceled || signal.aborted)
          yield emit({ type: "RunCanceled", reason: "aborted" });
        else {
          const result = (
            (await streamPromise) as {
              value: {
                text?: string;
                content?: string;
                reasoning_content?: string;
                accumulated_text?: string;
                timings?: { prompt_n?: number; predicted_n?: number };
                stopped_limit?: number;
              };
            }
          ).value;
          queueDeltas(decoder.finish(result));
          while (queued.length) yield queued.shift()!;
          yield emit({
            type: "Usage",
            ...(result.timings?.prompt_n === undefined
              ? {}
              : { inputTokens: result.timings.prompt_n }),
            ...(result.timings?.predicted_n === undefined
              ? {}
              : { outputTokens: result.timings.predicted_n }),
          });
          yield emit({
            type: "RunCompleted",
            finishReason: result.stopped_limit ? "length" : "stop",
          });
        }
      } catch (error) {
        settled = true;
        if (canceled || signal.aborted)
          yield emit({ type: "RunCanceled", reason: "aborted" });
        else {
          const mapped = mapError(error);
          yield emit({
            type: "RunFailed",
            error: {
              code: mapped.code,
              message: mapped.message,
              recoverable: mapped.recoverable,
            },
          });
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        try {
          // An abandoned iterator must stop and drain the queued completion too.
          if (run && (!settled || canceled)) {
            if (!canceled) await cancel().catch(() => undefined);
            await cancelPromise?.catch(() => undefined);
            await run.promise.catch(() => undefined);
          }
          settled = true;
          if (context) await context.release();
          await lease?.release();
          resolveDrained();
          active.delete(activeRun);
        } catch (error) {
          rejectDrained(error);
          throw error;
        }
      }
    },
    async dispose() {
      disposed = true;
      const runs = [...active];
      await Promise.all(
        runs.map((item) => item.cancel().catch(() => undefined)),
      );
      await Promise.all(runs.map((item) => item.resourcesDrained));
    },
  };
}

function parseManagedModel(modelId: string): ManagedModelFile {
  const id = modelId.startsWith("blob:") ? modelId.slice(5) : modelId;
  if (!/^[\da-f]{8}-[\da-f-]{27,}$/i.test(id))
    throw typedError(
      "missing-model",
      "GGUF model must be referenced by a managed blob ID",
    );
  return { blobId: id };
}

export function createBlobManagedModelFiles(
  blobs: Pick<BlobStore, "read" | "acquireLease" | "releaseLease"> &
    Partial<Pick<BlobStore, "list">>,
  files: {
    /** Legacy/injected byte staging; native callers should use stageMetadata. */
    stage?(blobId: string, bytes: Uint8Array): Promise<string>;
    /** Verify and open/copy the app-owned file without reading all weights into JS. */
    stageMetadata?(
      metadata: BlobMetadata,
      leaseToken: string,
      signal?: AbortSignal,
    ): Promise<string>;
    release(path: string): Promise<void>;
  },
): ManagedModelFiles {
  return {
    async acquire(model, signal) {
      signal?.throwIfAborted();
      const blobLease = await blobs.acquireLease(
        model.blobId,
        "gguf-inference",
      );
      let path: string | undefined;
      try {
        signal?.throwIfAborted();
        if (files.stageMetadata) {
          if (!blobs.list)
            throw typedError(
              "malformed",
              "Managed model metadata lookup is unavailable",
            );
          const metadata = (await blobs.list()).find(
            (item) => item.id === model.blobId,
          );
          if (!metadata)
            throw typedError(
              "missing-model",
              "Managed GGUF is missing from the blob catalog",
            );
          validateManagedMetadata(metadata, model.blobId);
          path = await files.stageMetadata(metadata, blobLease.token, signal);
        } else {
          if (!files.stage)
            throw typedError(
              "malformed",
              "Managed model staging is unavailable",
            );
          const { metadata, bytes } = await blobs.read(model.blobId);
          validateManagedMetadata(metadata, model.blobId);
          if (metadata.byteLength !== bytes.byteLength)
            throw typedError(
              "malformed",
              "Managed GGUF byte length is invalid",
            );
          if (!hasGgufSignature(bytes))
            throw typedError(
              "malformed",
              "Managed model does not have a GGUF file signature",
            );
          signal?.throwIfAborted();
          path = await files.stage(model.blobId, bytes);
        }
        signal?.throwIfAborted();
        if (!path.startsWith("file://"))
          throw typedError(
            "permission",
            "Runtime model staging must return an app-private file URI",
          );
        return {
          uri: path,
          async release() {
            await files.release(path!);
            await blobs.releaseLease(blobLease.token);
          },
        };
      } catch (error) {
        if (path) await files.release(path).catch(() => undefined);
        await blobs.releaseLease(blobLease.token);
        throw error;
      }
    },
  };
}

function validateManagedMetadata(metadata: BlobMetadata, blobId: string): void {
  if (
    metadata.id !== blobId ||
    !metadata.managedPath ||
    !Number.isSafeInteger(metadata.byteLength) ||
    metadata.byteLength < 4 ||
    !/^[\da-f]{64}$/i.test(metadata.sha256)
  )
    throw typedError("malformed", "Managed GGUF metadata is invalid");
}

function hasGgufSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x47 &&
    bytes[2] === 0x55 &&
    bytes[3] === 0x46
  );
}

async function loadRuntime(): Promise<LlamaRuntime> {
  return (await import("llama.rn")) as unknown as LlamaRuntime;
}

function event(
  request: RunRequest,
  sequence: number,
  fields: RunEventFields,
): RunEvent {
  return {
    ...fields,
    runId: request.runId,
    sequence,
    timestamp: new Date().toISOString(),
  } as RunEvent;
}
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string"
  )
    return value.text;
  return "";
}
function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
  return Math.max(minimum, Math.min(maximum, number));
}
function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, number));
}
function typedError(
  code: string,
  message: string,
): Error & { code: string; recoverable: boolean } {
  return Object.assign(new Error(message), {
    code,
    recoverable: code !== "malformed",
  });
}
function mapError(error: unknown): {
  code: string;
  message: string;
  recoverable: boolean;
} {
  const message =
    error instanceof Error ? error.message : "GGUF inference failed";
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : /memory|alloc/i.test(message)
        ? "quota"
        : /context/i.test(message)
          ? "context-full"
          : "malformed";
  return { code, message, recoverable: code !== "malformed" };
}
