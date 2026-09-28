import type {
  ModelManagerPort,
  PortResult,
  ProviderPort,
} from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";

export interface FakeNativePortCalls {
  readonly providerModels: string[];
  readonly downloadedModels: string[];
  readonly canceledJobs: string[];
  readonly loadedModels: string[];
  readonly unloadedModels: string[];
  disposed: boolean;
}

export interface FakeNativePorts {
  readonly calls: FakeNativePortCalls;
  readonly provider: ProviderPort;
  readonly modelManager: ModelManagerPort<string, number>;
}

const ok = <T>(value: T): PortResult<T> => ({ ok: true, value });

/** Deterministic in-memory native bridges for contract tests; no OS APIs or keys are used. */
export function createFakeNativePorts(
  events: readonly RunEvent[] = [],
): FakeNativePorts {
  const calls: FakeNativePortCalls = {
    providerModels: [],
    downloadedModels: [],
    canceledJobs: [],
    loadedModels: [],
    unloadedModels: [],
    disposed: false,
  };

  const provider: ProviderPort = {
    async listModels() {
      return ok(["fixture-model"]);
    },
    async getCapabilities(_connection, modelId) {
      calls.providerModels.push(modelId);
      return ok({ streaming: "yes", tools: "unknown" });
    },
    async *startRun(request: RunRequest, signal: AbortSignal) {
      let nextSequence = 0;
      for (const event of events) {
        if (signal.aborted) {
          yield canceledEvent(request.runId, nextSequence);
          return;
        }
        yield event;
        nextSequence = event.sequence + 1;
        if (isTerminal(event)) return;
      }
      if (signal.aborted) {
        yield canceledEvent(request.runId, nextSequence);
      }
    },
    dispose() {
      calls.disposed = true;
    },
  };

  const modelManager: ModelManagerPort<string, number> = {
    async list() {
      return ok(["fixture-model"]);
    },
    async download(modelId, signal, onProgress) {
      if (signal.aborted) {
        return {
          ok: false,
          error: {
            code: "canceled",
            message: "Fixture download canceled",
            recoverable: true,
          },
        };
      }
      calls.downloadedModels.push(modelId);
      onProgress?.(1);
      return ok(undefined);
    },
    async cancel(jobId) {
      calls.canceledJobs.push(jobId);
      return ok(undefined);
    },
    async load(modelId) {
      calls.loadedModels.push(modelId);
      return ok(undefined);
    },
    async unload(modelId) {
      calls.unloadedModels.push(modelId);
      return ok(undefined);
    },
    async status() {
      return ok("ready");
    },
    dispose() {
      calls.disposed = true;
    },
  };

  return { calls, provider, modelManager };
}

function isTerminal(event: RunEvent): boolean {
  return (
    event.type === "RunCompleted" ||
    event.type === "RunCanceled" ||
    event.type === "RunFailed"
  );
}

function canceledEvent(runId: string, sequence: number): RunEvent {
  return {
    runId,
    sequence,
    timestamp: "2025-01-01T00:00:00.000Z",
    type: "RunCanceled",
    reason: "fixture cancellation",
  };
}
