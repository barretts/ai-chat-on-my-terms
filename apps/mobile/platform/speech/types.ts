export interface SpeechVoice {
  id: string;
  name: string;
  modelId: string;
  speakerId: number;
  /** BCP-47 tag of the language this voice speaks. */
  language: string;
  /** Language name shown to users, e.g. in the pack filter. */
  languageName: string;
  description: string;
}

export interface SpeechState {
  phase:
    | "idle"
    | "downloading"
    | "loading"
    | "generating"
    | "playing"
    | "error";
  selectedVoiceId: string;
  installedModelIds: readonly string[];
  message: string;
  progress: number | null;
  audioUri: string | null;
  rate: number;
}

export interface OfflineSpeech {
  snapshot(): SpeechState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  selectVoice(voiceId: string): Promise<void>;
  setRate(rate: number): Promise<void>;
  /** Browser runtime repair preserves the separately cached voice packs. */
  repairRuntime?(): Promise<void>;
  install(modelId: string): Promise<void>;
  remove(modelId: string): Promise<void>;
  speak(text: string, voiceId?: string, rate?: number): Promise<void>;
  stop(): Promise<void>;
}
