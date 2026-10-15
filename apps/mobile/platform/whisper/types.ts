export type TranscriptionPhase =
  | "idle"
  | "downloading"
  | "loading"
  | "transcribing"
  | "error";

export interface TranscriptionState {
  phase: TranscriptionPhase;
  modelId: string;
  /** Whisper language hint; "" lets the model auto-detect. */
  language: string;
  installedModelIds: string[];
  message: string;
  progress: number | null;
}

export type TranscriptionFailureCode =
  | "unavailable"
  | "permission"
  | "canceled"
  | "failed";

export type TranscriptionOutcome =
  | { ok: true; text: string }
  | { ok: false; code: TranscriptionFailureCode; message: string };

export interface ListenHandle {
  /** Finish capture and transcribe what was recorded. */
  stop(): void;
}

export interface OfflineTranscription {
  snapshot(): TranscriptionState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  install(modelId: string): Promise<void>;
  cancelInstall(): void;
  remove(modelId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setLanguage(code: string): void;
  /** Transcribe an audio file already on the device (file-based VO-09). */
  transcribeFile(
    path: string,
    options?: { language?: string },
  ): Promise<string>;
  /**
   * Capture microphone PCM until the returned handle is stopped or the
   * signal aborts. Aborting cancels without recognizing.
   */
  listen(signal: AbortSignal): Promise<{
    outcome: Promise<TranscriptionOutcome>;
    handle: ListenHandle;
  }>;
  dispose(): Promise<void>;
}
