import type { ProviderPort } from "@locallab/contracts/ports";
import type { BlobStore } from "@locallab/storage-blobs";

const unavailableError = {
  code: "unsupported" as const,
  message:
    "Local GGUF inference is unavailable in this browser. Use the iPhone app or configure a model server.",
  recoverable: true,
};

/** No native inference runtime or managed model files are opened on web. */
export function createLocalChatPort(_blobs: BlobStore): ProviderPort {
  return {
    async listModels() {
      return { ok: false, error: { ...unavailableError } };
    },
    async getCapabilities() {
      return { ok: false, error: { ...unavailableError } };
    },
    async *startRun(request, signal) {
      const base = {
        runId: request.runId,
        sequence: 0,
        timestamp: new Date().toISOString(),
      };
      if (signal.aborted) {
        yield { ...base, type: "RunCanceled", reason: "aborted" };
        return;
      }
      yield { ...base, type: "RunFailed", error: { ...unavailableError } };
    },
    async dispose() {},
  };
}
