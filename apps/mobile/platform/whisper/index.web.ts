import { whisperLanguages } from "./catalog";
import type {
  OfflineTranscription,
  TranscriptionOutcome,
  TranscriptionState,
} from "./types";

export { whisperLanguages, whisperModels } from "./catalog";
export type { OfflineTranscription, TranscriptionState } from "./types";

/**
 * Honest web stub: the browser preview does not ship a Whisper runtime, and
 * pretending otherwise would misreport "local" transcription. The capability
 * lives in iPhone app builds (T077).
 */
const message =
  "Local Whisper transcription runs in the iPhone app build. The web preview does not ship the Whisper runtime.";

class WebWhisperStub implements OfflineTranscription {
  private state: TranscriptionState = {
    phase: "idle",
    modelId: "whisper-small",
    language: "",
    installedModelIds: [],
    message,
    progress: null,
  };
  private listeners = new Set<() => void>();
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async refresh(): Promise<void> {}
  async install(): Promise<void> {
    throw new Error(message);
  }
  cancelInstall(): void {}
  async remove(): Promise<void> {}
  async setModel(): Promise<void> {
    throw new Error(message);
  }
  setLanguage(): void {}
  async transcribeFile(): Promise<string> {
    throw new Error(message);
  }
  async listen(): Promise<{
    outcome: Promise<TranscriptionOutcome>;
    handle: { stop(): void };
  }> {
    return {
      outcome: Promise.resolve({
        ok: false,
        code: "unavailable",
        message,
      }),
      handle: { stop: () => {} },
    };
  }
  async dispose(): Promise<void> {}
}

export const whisperTranscription: OfflineTranscription = new WebWhisperStub();
