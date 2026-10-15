import { audioFailure, type AudioResult } from "@locallab/audio-session";
import type {
  SystemSpeechOutputPort,
  SystemVoice,
} from "@locallab/speech-system";

const unavailable =
  "The system voice runs on the iPhone's built-in synthesizer, which browsers do not expose.";

/** Honest web stub: browsers keep the neural packs; no fake system voice. */
export const systemSpeechOutput: SystemSpeechOutputPort = {
  async getAvailability(): Promise<AudioResult<"ready" | "unavailable">> {
    return { ok: true, value: "unavailable" };
  },
  async getVoices(): Promise<AudioResult<SystemVoice[]>> {
    return { ok: true, value: [] };
  },
  isSpeaking: () => false,
  async speak(): Promise<AudioResult<void>> {
    return audioFailure("unavailable", unavailable, false);
  },
  async stop(): Promise<AudioResult<void>> {
    return { ok: true, value: undefined };
  },
};
