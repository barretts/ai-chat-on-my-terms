import type { CatalogModel } from "@locallab/models-catalog";
import { Directory, DownloadTask, File, Paths } from "expo-file-system";
import { inspectAssetHeader } from "./asset-integrity";
import {
  adoptDownloadedModel,
  assertDownloadedModel,
  beginModelDownload,
  discardModelDownload,
  managedModelPath,
  modelArtifact,
  newModelBlobId,
  partialModelPath,
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

function modelDirectory(): Directory {
  const directory = new Directory(Paths.document, "locallab", "blobs");
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}

function managedFile(path: string): File {
  const match =
    /^locallab\/blobs\/(\.model-partial-)?([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.exec(
      path,
    );
  if (!match) throw new Error("The model file is outside managed storage.");
  return new File(modelDirectory(), `${match[1] ?? ""}${match[2]}`);
}

async function removeStage(blobId: string): Promise<void> {
  for (const path of [partialModelPath(blobId), managedModelPath(blobId)]) {
    const file = managedFile(path);
    if (file.exists) file.delete();
  }
}

export async function listInstalledModels(): Promise<InstalledLocalModel[]> {
  modelDirectory();
  await recoverModelDownloads(removeStage);
  return readInstalledModels();
}

/** Native downloads and header checks never load complete model weights into JS. */
export async function downloadLocalModel(
  model: CatalogModel,
  onProgress: (progress: LocalModelDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<InstalledLocalModel> {
  signal?.throwIfAborted();
  const artifact = modelArtifact(model);
  const blobId = newModelBlobId();
  return withModelDownload(model, blobId, async () => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let task: DownloadTask | undefined;
    let staged = false;
    let adopted = false;
    try {
      controller.signal.throwIfAborted();
      const availableBytes = Paths.availableDiskSpace;
      if (
        Number.isFinite(availableBytes) &&
        availableBytes < artifact.sizeBytes + 64 * 1024 * 1024
      )
        throw new Error(
          "There is not enough device storage for this model. Free space or choose a smaller model, then download again.",
        );
      const partial = managedFile(partialModelPath(blobId));
      await beginModelDownload(model, blobId);
      staged = true;
      controller.signal.throwIfAborted();
      onProgress({ bytes: 0, total: artifact.sizeBytes, phase: "downloading" });
      task = new DownloadTask(artifact.url, partial, {
        sessionType: "foreground",
        signal: controller.signal,
        onProgress(progress) {
          if (progress.bytesWritten > artifact.sizeBytes) {
            controller.abort(
              new Error(
                "The download exceeded the catalog file size. No model was installed.",
              ),
            );
            return;
          }
          onProgress({
            bytes: Math.max(0, progress.bytesWritten),
            total: artifact.sizeBytes,
            phase: "downloading",
          });
        },
      });
      // Expo settles this promise after native request cancellation, so cleanup
      // cannot unlink a file while its download is still writing to it.
      const downloaded = await task.downloadAsync();
      controller.signal.throwIfAborted();
      if (!downloaded || downloaded.uri !== partial.uri)
        throw new Error(
          "The model download did not finish in managed storage.",
        );
      if (downloaded.size !== artifact.sizeBytes)
        throw new Error(
          "The downloaded model size does not match the catalog. Download it again.",
        );
      onProgress({
        bytes: artifact.sizeBytes,
        total: artifact.sizeBytes,
        phase: "saving",
      });
      assertDownloadedModel(
        model,
        inspectAssetHeader(downloaded.uri, controller.signal),
      );
      controller.signal.throwIfAborted();
      downloaded.move(managedFile(managedModelPath(blobId)));
      const entry = await adoptDownloadedModel(
        model,
        blobId,
        controller.signal,
      );
      adopted = true;
      return entry;
    } catch (error) {
      controller.signal.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      try {
        if (task) {
          task.cancel();
          task.release();
        }
      } finally {
        if (staged && !adopted) await discardModelDownload(blobId, removeStage);
      }
    }
  });
}

/** An active inference lease or an unrelated saved reference refuses deletion. */
export async function deleteLocalModel(
  entry: InstalledLocalModel,
): Promise<void> {
  await removeInstalledModel(entry, async (path) => {
    const file = managedFile(path);
    if (file.exists) file.delete();
  });
}
