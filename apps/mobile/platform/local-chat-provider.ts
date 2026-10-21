import type { ProviderPort } from "@locallab/contracts/ports";
import type { BlobStore } from "@locallab/storage-blobs";
import {
  createGgufInferencePort,
  createBlobManagedModelFiles,
  withGrammarGuard,
} from "@locallab/gguf-ios";
import { getGrammarGuard } from "./grammar-guard";
import { File, Paths } from "expo-file-system";
import { inspectAssetHeader } from "./asset-integrity";

/** Native GGUF inference with the existing managed file staging and release. */
export function createLocalChatPort(blobs: BlobStore): ProviderPort {
  const inference = createGgufInferencePort({
    contextSize: 4096,
    files: createBlobManagedModelFiles(blobs, {
      async stageMetadata(metadata, _leaseToken, signal) {
        if (
          !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
            metadata.id,
          ) ||
          metadata.managedPath !== `locallab/blobs/${metadata.id}`
        )
          throw Object.assign(
            new Error("GGUF path is outside app-private managed storage"),
            {
              code: "permission",
            },
          );
        const file = new File(Paths.document, "locallab", "blobs", metadata.id);
        if (!file.exists)
          throw Object.assign(
            new Error("The managed GGUF file is missing. Import it again."),
            {
              code: "missing-model",
            },
          );
        const inspected = inspectAssetHeader(file.uri, signal);
        if (
          inspected.byteLength !== metadata.byteLength ||
          inspected.prefix.length < 4 ||
          inspected.prefix[0] !== 0x47 ||
          inspected.prefix[1] !== 0x47 ||
          inspected.prefix[2] !== 0x55 ||
          inspected.prefix[3] !== 0x46
        )
          throw Object.assign(
            new Error(
              "The GGUF file is incomplete or has an invalid header. Remove it and download again.",
            ),
            {
              code: "malformed",
            },
          );
        // Keep the original protected by its blob lease; no full-file JS read
        // or second cache copy is needed before native model loading.
        return file.uri;
      },
      async release() {},
    }),
  });
  return {
    async listModels() {
      return { ok: true as const, value: [] as readonly string[] };
    },
    async getCapabilities() {
      return {
        ok: true as const,
        value: {
          streaming: "yes" as const,
          tools: "yes" as const,
          "parameter.contextWindow": "yes" as const,
          "parameter.max_output_tokens": "yes" as const,
          "parameter.temperature": "yes" as const,
          "parameter.top_p": "yes" as const,
          "parameter.top_k": "yes" as const,
          "parameter.penalty_repeat": "yes" as const,
          "parameter.enable_thinking": "yes" as const,
        },
      };
    },
    startRun: (request, signal) =>
      withGrammarGuard(getGrammarGuard(), request, (guarded) =>
        inference.startRun(guarded, signal),
      ),
    dispose: inference.dispose,
  };
}
