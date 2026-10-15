import * as FileSystem from "expo-file-system/legacy";
import { Paths } from "expo-file-system";
import { errorDetails } from "@locallab/network-http";
import { createPcmCapture } from "@locallab/speech-system";
import { speechSystemCaptureNative } from "@locallab/speech-system/expo";
import type { AsrEngine, ModelFs, WhisperDeps } from "./core";
import { WhisperTranscriber } from "./core";
import type { OfflineTranscription } from "./types";

export { whisperLanguages, whisperModels } from "./catalog";
export type { OfflineTranscription, TranscriptionState } from "./types";

type Sherpa = typeof import("@siteed/sherpa-onnx.rn").default;

const root = `${FileSystem.documentDirectory}local-whisper/`;

const fs: ModelFs = {
  async exists(path) {
    return (await FileSystem.getInfoAsync(path)).exists;
  },
  async readJson(path) {
    return JSON.parse(await FileSystem.readAsStringAsync(path));
  },
  async writeJson(path, value) {
    await FileSystem.writeAsStringAsync(path, JSON.stringify(value));
  },
  async ensureDir(path) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  },
  async removeTree(path) {
    if ((await FileSystem.getInfoAsync(path)).exists)
      await FileSystem.deleteAsync(path, { idempotent: true });
  },
  async fileSize(path) {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists && !info.isDirectory ? info.size : 0;
  },
  async download(url, destination, onProgress, signal) {
    signal.throwIfAborted();
    const download = FileSystem.createDownloadResumable(
      url,
      destination,
      { sessionType: FileSystem.FileSystemSessionType.FOREGROUND },
      (progress) =>
        onProgress(
          progress.totalBytesWritten,
          progress.totalBytesExpectedToWrite,
        ),
    );
    const onAbort = () => void download.cancelAsync().catch(() => {});
    signal.addEventListener("once", onAbort);
    try {
      const result = await download.downloadAsync();
      signal.throwIfAborted();
      if (!result)
        throw new Error(
          "The model download returned no response or saved file.",
        );
      if (result.status !== 200)
        throw new Error(
          `The model download returned HTTP ${result.status} for ${url}.`,
        );
      return await fs.fileSize(destination);
    } finally {
      signal.removeEventListener("once", onAbort);
    }
  },
  availableDiskBytes() {
    return Paths.availableDiskSpace;
  },
};
  // Lazy like the voice-pack module: a static import would eagerly load the
  // iPhone-only native bridge; only iPhone builds reach this code.
async function engine(): Promise<AsrEngine> {
  let sherpa: Sherpa;
  try {
    sherpa = (await import("@siteed/sherpa-onnx.rn")).default;
  } catch (cause) {
    throw new Error(
      "Local Whisper needs an iPhone app build containing the Sherpa speech module. It is not available in Expo Go.",
      { cause },
    );
  }
  const loaded = await sherpa.validateLibraryLoaded();
  if (!loaded.loaded)
    throw new Error(
      `The offline speech module is unavailable in this app build.\nNative response:\n${errorDetails(loaded)}`,
    );
  return sherpa;
}

const deps: WhisperDeps = {
  root,
  fs,
  engine,
  capture: createPcmCapture(speechSystemCaptureNative),
};

/** Shared by Voice Studio and transcript file import (T080). */
export const whisperTranscription: OfflineTranscription =
  new WhisperTranscriber(deps);
