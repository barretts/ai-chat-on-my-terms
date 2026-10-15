import { errorDetails } from "@locallab/network-http";
import {
  whisperLanguages,
  whisperModelById,
  whisperModels,
} from "./catalog";
import type {
  ListenHandle,
  OfflineTranscription,
  TranscriptionOutcome,
  TranscriptionState,
} from "./types";

/** Subset of @siteed/sherpa-onnx.rn used here; fakes implement it in tests. */
export interface AsrEngine {
  initAsr(config: {
    modelDir: string;
    modelType: "whisper";
    language: string;
    modelFiles: { encoder: string; decoder: string; tokens: string };
  }): Promise<{ success: boolean; error?: string }>;
  recognizeFromFile(
    filePath: string,
  ): Promise<{ success: boolean; text?: string; error?: string }>;
  recognizeFromSamples(input: {
    sampleRate: number;
    samples: number[];
  }): Promise<{ success: boolean; text?: string; error?: string }>;
  releaseAsr(): Promise<{ released: boolean }>;
}

export interface ModelFs {
  exists(path: string): Promise<boolean>;
  readJson(path: string): Promise<unknown>;
  writeJson(path: string, value: unknown): Promise<void>;
  ensureDir(path: string): Promise<void>;
  removeTree(path: string): Promise<void>;
  fileSize(path: string): Promise<number>;
  /** Resolves with the downloaded file size; rejects on abort. */
  download(
    url: string,
    destination: string,
    onProgress: (doneBytes: number, totalBytes: number) => void,
    signal: AbortSignal,
  ): Promise<number>;
  availableDiskBytes(): number;
}

export interface PcmCapture {
  requestPermission(): Promise<boolean>;
  start(sampleRate: number): Promise<void>;
  /** Stops capture and returns everything recorded so far. */
  stop(): Promise<{ sampleRate: number; samples: number[] }>;
  cancel(): Promise<void>;
}

export interface WhisperDeps {
  root: string;
  fs: ModelFs;
  engine(): Promise<AsrEngine>;
  capture: PcmCapture;
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

export class WhisperTranscriber implements OfflineTranscription {
  private state: TranscriptionState = {
    phase: "idle",
    modelId: "whisper-small",
    language: "",
    installedModelIds: [],
    message: "Download a Whisper model once, then transcribe offline.",
    progress: null,
  };
  private listeners = new Set<() => void>();
  private engine: AsrEngine | null = null;
  private loaded: string | null = null;
  private installController: AbortController | null = null;

  constructor(private readonly deps: WhisperDeps) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(values: Partial<TranscriptionState>) {
    this.state = { ...this.state, ...values };
    for (const listener of this.listeners) listener();
  }
  private fail(error: unknown) {
    this.update({
      phase: "error",
      progress: null,
      message: errorDetails(error),
    });
  }

  private markerPath(modelId: string): string {
    return `${this.deps.root}${whisperModelById(modelId).directory}/ready.json`;
  }
  private directory(modelId: string): string {
    return `${this.deps.root}${whisperModelById(modelId).directory}/`;
  }

  async refresh(): Promise<void> {
    await this.deps.fs.ensureDir(this.deps.root);
    const installed: string[] = [];
    for (const model of whisperModels) {
      if (!(await this.deps.fs.exists(this.markerPath(model.id)))) continue;
      try {
        const marker = (await this.deps.fs.readJson(this.markerPath(model.id))) as {
          totalBytes?: number;
        };
        if (marker.totalBytes !== model.totalBytes) continue;
      } catch {
        continue;
      }
      const [encoder, decoder, tokens] = model.files;
      const sizes = await Promise.all([
        this.deps.fs.fileSize(`${this.directory(model.id)}${encoder.name}`),
        this.deps.fs.fileSize(`${this.directory(model.id)}${decoder.name}`),
        this.deps.fs.fileSize(`${this.directory(model.id)}${tokens.name}`),
      ]);
      if (
        sizes[0] === encoder.bytes &&
        sizes[1] === decoder.bytes &&
        sizes[2] === tokens.bytes
      )
        installed.push(model.id);
    }
    const selected = installed.includes(this.state.modelId)
      ? this.state.modelId
      : (installed[0] ?? this.state.modelId);
    this.update({ installedModelIds: installed, modelId: selected });
  }

  async install(modelId: string): Promise<void> {
    const model = whisperModelById(modelId);
    if (this.deps.fs.availableDiskBytes() < model.requiredFreeBytes) {
      this.update({
        phase: "error",
        progress: null,
        message: `${model.name} needs about ${Math.round(model.requiredFreeBytes / 1024 / 1024)} MB free (download plus room to keep working). Free space or choose a smaller model.`,
      });
      return;
    }
    const controller = new AbortController();
    this.installController = controller;
    this.update({
      phase: "downloading",
      progress: 0,
      message: `Downloading ${model.name}…`,
    });
    try {
      const directory = this.directory(model.id);
      await this.deps.fs.ensureDir(directory);
      let done = 0;
      for (const file of model.files) {
        const path = `${directory}${file.name}`;
        const existing = await this.deps.fs.fileSize(path);
        if (existing === file.bytes) {
          done += file.bytes;
          continue;
        }
        const base = done;
        const size = await this.deps.fs.download(
          file.url,
          path,
          (fileDone) =>
            this.update({
              progress: (base + fileDone) / model.totalBytes,
            }),
          controller.signal,
        );
        if (size !== file.bytes)
          throw new Error(
            `${model.name} downloaded the wrong size (${size} of ${file.bytes} bytes). Retry the download.`,
          );
        done += size;
      }
      await this.deps.fs.writeJson(`${directory}ready.json`, {
        modelId: model.id,
        totalBytes: model.totalBytes,
        verification: "size-only",
        files: model.files.map((file) => ({
          name: file.name,
          bytes: file.bytes,
        })),
      });
      if (this.loaded && this.loaded !== model.id) await this.releaseEngine();
      await this.refresh();
      this.update({
        phase: "idle",
        progress: null,
        modelId: this.state.installedModelIds.includes(this.state.modelId)
          ? this.state.modelId
          : model.id,
        message: `${model.name} is installed. Transcription works offline.`,
      });
    } catch (cause) {
      if (isAbort(cause)) {
        this.update({
          phase: "idle",
          progress: null,
          message: `${model.name} download canceled.`,
        });
        return;
      }
      this.fail(cause);
    } finally {
      if (this.installController === controller) this.installController = null;
    }
  }

  cancelInstall(): void {
    this.installController?.abort();
  }

  async remove(modelId: string): Promise<void> {
    const model = whisperModelById(modelId);
    await this.deps.fs.removeTree(this.directory(model.id));
    if (this.loaded === model.id) await this.releaseEngine();
    await this.refresh();
    this.update({ message: `${model.name} removed.` });
  }

  async setModel(modelId: string): Promise<void> {
    whisperModelById(modelId);
    if (!this.state.installedModelIds.includes(modelId))
      throw new Error("Download that model first.");
    if (this.loaded && this.loaded !== modelId) await this.releaseEngine();
    this.update({ modelId, message: `${whisperModelById(modelId).name} selected.` });
  }

  setLanguage(code: string): void {
    if (!whisperLanguages.some((item) => item.code === code))
      throw new Error("Choose a supported language.");
    if (this.loaded) {
      this.loaded = null;
      void this.engine?.releaseAsr();
    }
    this.update({ language: code });
  }

  private async releaseEngine(): Promise<void> {
    if (this.engine) await this.engine.releaseAsr();
    this.loaded = null;
  }

  private async ensureEngine(
    modelId: string,
    language: string,
  ): Promise<AsrEngine> {
    const engine = await this.deps.engine();
    this.engine = engine;
    const signature = `${modelId} ${language}`;
    if (this.loaded !== signature) {
      this.update({ phase: "loading", message: "Loading Whisper model…" });
      const model = whisperModelById(modelId);
      const result = await engine.initAsr({
        modelDir: this.directory(model.id),
        modelType: "whisper",
        language,
        modelFiles: {
          encoder: model.files[0].name,
          decoder: model.files[1].name,
          tokens: "tokens.txt",
        },
      });
      if (!result.success)
        throw new Error(
          `${model.name} could not start on this device.\nNative response:\n${errorDetails(result)}`,
        );
      this.loaded = signature;
    }
    return engine;
  }

  async transcribeFile(
    path: string,
    options: { language?: string } = {},
  ): Promise<string> {
    const language = options.language ?? this.state.language;
    if (!this.state.installedModelIds.includes(this.state.modelId)) {
      throw new Error("Download a Whisper model before transcribing files.");
    }
    this.update({
      phase: "transcribing",
      message: "Transcribing audio file…",
    });
    try {
      const engine = await this.ensureEngine(this.state.modelId, language);
      const result = await engine.recognizeFromFile(path);
      if (!result.success)
        throw new Error(`Transcription failed.\nNative response:\n${errorDetails(result)}`);
      this.update({
        phase: "idle",
        message: "Transcription finished.",
      });
      return (result.text ?? "").trim();
    } catch (cause) {
      this.fail(cause);
      throw cause;
    }
  }

  async listen(
    signal: AbortSignal,
  ): Promise<{ outcome: Promise<TranscriptionOutcome>; handle: ListenHandle }> {
    const finish = Promise.withResolvers<TranscriptionOutcome>();
    if (signal.aborted) {
      finish.resolve({ ok: false, code: "canceled", message: "Canceled." });
      return { outcome: finish.promise, handle: { stop: () => {} } };
    }
    if (!this.state.installedModelIds.includes(this.state.modelId)) {
      finish.resolve({
        ok: false,
        code: "unavailable",
        message: "Download a Whisper model before transcribing speech.",
      });
      return { outcome: finish.promise, handle: { stop: () => {} } };
    }
    if (!(await this.deps.capture.requestPermission())) {
      finish.resolve({
        ok: false,
        code: "permission",
        message: "Microphone access is off. Enable it in Settings to transcribe.",
      });
      return { outcome: finish.promise, handle: { stop: () => {} } };
    }
    let stopped = false;
    let canceled = false;
    const stopping = Promise.withResolvers<void>();
    const handle: ListenHandle = {
      stop: () => {
        if (stopped || canceled) return;
        stopped = true;
        stopping.resolve();
      },
    };
    const onAbort = () => {
      if (stopped || canceled) return;
      canceled = true;
      stopping.resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const pipeline = (async (): Promise<TranscriptionOutcome> => {
      try {
        await this.deps.capture.start(16000);
        this.update({
          phase: "transcribing",
          message: "Listening… tap to finish and transcribe.",
        });
        await stopping.promise;
        signal.removeEventListener("abort", onAbort);
        if (canceled) {
          await this.deps.capture.cancel();
          this.update({ phase: "idle", message: "Transcription canceled." });
          return { ok: false, code: "canceled", message: "Canceled." };
        }
        const audio = await this.deps.capture.stop();
        const engine = await this.ensureEngine(
          this.state.modelId,
          this.state.language,
        );
        const result = await engine.recognizeFromSamples(audio);
        if (!result.success)
          throw new Error(
            `Transcription failed.\nNative response:\n${errorDetails(result)}`,
          );
        this.update({ phase: "idle", message: "Transcription finished." });
        return { ok: true, text: (result.text ?? "").trim() };
      } catch (cause) {
        signal.removeEventListener("abort", onAbort);
        this.fail(cause);
        return { ok: false, code: "failed", message: errorDetails(cause) };
      }
    })();
    void pipeline.then((outcome) => finish.resolve(outcome));
    return { outcome: finish.promise, handle };
  }

  async dispose(): Promise<void> {
    this.installController?.abort();
    await this.releaseEngine();
    this.engine = null;
  }
}

