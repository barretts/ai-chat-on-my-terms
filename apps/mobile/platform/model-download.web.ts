import type { CatalogModel } from "@locallab/models-catalog";
import { httpResponseError } from "@locallab/network-http";
import {
  adoptDownloadedModel,
  assertDownloadedModel,
  beginModelDownload,
  discardModelDownload,
  managedModelPath,
  modelArtifact,
  newModelBlobId,
  readInstalledModels,
  recoverModelDownloads,
  removeInstalledModel,
  withModelDownload,
  type InstalledLocalModel,
  type LocalModelDownloadProgress,
} from "./model-storage";

export { LOCAL_MODELS_SCHEMA_SQL } from "./model-storage";
export type {
  InstalledLocalModel,
  LocalModelDownloadProgress,
} from "./model-storage";

const chunkBytes = 4 * 1024 * 1024;

async function modelDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!globalThis.isSecureContext || !navigator.storage?.getDirectory)
    throw new Error(
      "Model downloads require a browser with private file storage on HTTPS or localhost. Use a current Chromium browser or the iPhone app.",
    );
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle("locallab", { create: true });
  return app.getDirectoryHandle("blobs", { create: true });
}

async function removeFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError"))
      throw error;
  }
}

async function removeStage(blobId: string): Promise<void> {
  managedModelPath(blobId);
  const directory = await modelDirectory();
  await removeFile(directory, blobId);
  await removeFile(directory, `.model-partial-${blobId}`);
}

export async function listInstalledModels(): Promise<InstalledLocalModel[]> {
  await modelDirectory();
  await recoverModelDownloads(removeStage);
  return readInstalledModels();
}

/** Streaming browser storage only; native GGUF inference is unavailable on web. */
export async function downloadLocalModel(
  model: CatalogModel,
  onProgress: (progress: LocalModelDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<InstalledLocalModel> {
  signal?.throwIfAborted();
  const artifact = modelArtifact(model);
  const blobId = newModelBlobId();
  return withModelDownload(model, blobId, async () => {
    let reader:
      | ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>
      | undefined;
    let writer: FileSystemWritableFileStream | undefined;
    let writerClosed = false;
    let staged = false;
    let adopted = false;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      const directory = await modelDirectory();
      const estimate = await navigator.storage.estimate();
      if (
        typeof estimate.quota === "number" &&
        typeof estimate.usage === "number" &&
        estimate.quota - estimate.usage < artifact.sizeBytes
      )
        throw new Error(
          "This browser does not have enough private storage for the model. Free space or choose a smaller model.",
        );
      await beginModelDownload(model, blobId);
      staged = true;
      controller.signal.throwIfAborted();
      // The random file remains unpublished until the SQLite
      // adoption commit. No huge ArrayBuffer, IndexedDB copy or rename is needed.
      const handle = await directory.getFileHandle(blobId, { create: true });
      writer = await handle.createWritable({ keepExistingData: false });
      onProgress({ bytes: 0, total: artifact.sizeBytes, phase: "downloading" });
      const response = await fetch(artifact.url, {
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (!response.ok)
        throw await httpResponseError(response, {
          summary:
            "The model publisher rejected the download. Try again later.",
          signal: controller.signal,
        });
      if (new URL(response.url).protocol !== "https:" || !response.body)
        throw new Error(
          "The publisher did not return a secure streaming model download.",
        );
      reader = response.body.getReader();
      let bytes = 0;
      let prefix: Uint8Array = new Uint8Array();
      while (true) {
        controller.signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        for (
          let offset = 0;
          offset < chunk.value.length;
          offset += chunkBytes
        ) {
          controller.signal.throwIfAborted();
          const part = chunk.value.subarray(offset, offset + chunkBytes);
          if (bytes + part.length > artifact.sizeBytes)
            throw new Error(
              "The download exceeded the catalog file size. No model was installed.",
            );
          prefix = capturePrefix(prefix, part);
          await writer.write(part);
          bytes += part.length;
          onProgress({
            bytes,
            total: artifact.sizeBytes,
            phase: "downloading",
          });
        }
      }
      controller.signal.throwIfAborted();
      assertDownloadedModel(model, { byteLength: bytes, prefix });
      onProgress({ bytes, total: artifact.sizeBytes, phase: "saving" });
      await writer.close();
      writerClosed = true;
      reader.releaseLock();
      reader = undefined;
      const stored = await handle.getFile();
      assertDownloadedModel(model, {
        byteLength: stored.size,
        prefix: new Uint8Array(await stored.slice(0, 32).arrayBuffer()),
      });
      const entry = await adoptDownloadedModel(
        model,
        blobId,
        controller.signal,
      );
      adopted = true;
      return entry;
    } catch (error) {
      controller.signal.throwIfAborted();
      if (error instanceof DOMException && error.name === "QuotaExceededError")
        throw new Error(
          "The browser ran out of private storage. Free space or choose a smaller model, then download again.",
        );
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      controller.abort();
      try {
        try {
          if (reader) {
            try {
              await reader.cancel();
            } finally {
              reader.releaseLock();
            }
          }
        } finally {
          if (writer && !writerClosed) await writer.abort();
        }
      } finally {
        if (staged && !adopted) await discardModelDownload(blobId, removeStage);
      }
    }
  });
}

export async function deleteLocalModel(
  entry: InstalledLocalModel,
): Promise<void> {
  await removeInstalledModel(entry, async (path) => {
    if (path !== managedModelPath(entry.blobId))
      throw new Error("The model file is outside managed storage.");
    await removeFile(await modelDirectory(), entry.blobId);
  });
}

function capturePrefix(prefix: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (prefix.length >= 32) return prefix;
  const count = Math.min(32 - prefix.length, chunk.length);
  const next = new Uint8Array(prefix.length + count);
  next.set(prefix);
  next.set(chunk.subarray(0, count), prefix.length);
  return next;
}
