import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import type { BenchRunRecord } from "./matrix";

/**
 * Decorator over the real provider port: captures wall-clock per run, Usage
 * tokens, and the terminal event, keyed by RunRequest.messageId so the
 * transcript rows pair with latencies. Events pass through untouched; the
 * topic-interest selector's json run is tagged, never measured as a reply.
 */
export function createRecordingPort(
  inner: ProviderPort,
  sink: BenchRunRecord[],
  now: () => number = () => Date.now(),
): ProviderPort {
  return {
    listModels: (connection, signal) => inner.listModels(connection, signal),
    getCapabilities: (connection, modelId, signal) =>
      inner.getCapabilities(connection, modelId, signal),
    dispose: () => inner.dispose?.(),
    startRun: async function* (request: RunRequest, signal: AbortSignal) {
      const startedAtMs = now();
      const partial = {
        runId: request.runId,
        messageId: request.messageId,
        modelId: request.modelId,
        jsonSelector: request.json,
        startedAtMs,
        inputTokens: null as number | null,
        outputTokens: null as number | null,
        finishReason: null as string | null,
        canceled: false,
      };
      const capture = (event: RunEvent): void => {
        if (event.type === "Usage") {
          if (event.inputTokens !== undefined)
            partial.inputTokens = event.inputTokens;
          if (event.outputTokens !== undefined)
            partial.outputTokens = event.outputTokens;
        } else if (event.type === "RunCompleted") {
          partial.finishReason = event.finishReason ?? "stop";
        } else if (event.type === "RunCanceled") {
          partial.canceled = true;
          partial.finishReason = "canceled";
        } else if (event.type === "RunFailed") {
          partial.finishReason = `failed: ${event.error.message}`;
        }
      };
      try {
        for await (const event of inner.startRun(request, signal)) {
          capture(event);
          yield event;
        }
      } finally {
        const endedAtMs = now();
        sink.push({
          ...partial,
          endedAtMs,
          durationMs: endedAtMs - startedAtMs,
        });
      }
    },
  };
}
