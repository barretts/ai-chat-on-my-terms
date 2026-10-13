import type {
  AudioAvailability,
  AudioResult,
  SpeechOutputPort,
} from "@locallab/audio-session";
import type { OfflineSpeech } from "../../platform/speech/types";

function failure(cause: unknown, fallback: string): AudioResult<never> {
  return {
    ok: false,
    error: {
      code: "failed",
      message: cause instanceof Error ? cause.message : fallback,
      recoverable: true,
    },
  };
}

/**
 * Exposes the shared offline TTS service as a SpeechOutputPort without
 * changing its voice packs, voice selection, rates, Persona preferences or
 * Stop behavior. `speak` resolves when playback finishes, matching the
 * coordinator's phase expectations.
 */
export function createOfflineSpeechOutput(
  speech: OfflineSpeech,
): SpeechOutputPort {
  return {
    async getAvailability(): Promise<AudioResult<AudioAvailability>> {
      const state = speech.snapshot();
      const ready =
        state.phase !== "error" && state.installedModelIds.length > 0;
      return { ok: true, value: ready ? "ready" : "unavailable" };
    },
    isSpeaking: () => speech.snapshot().phase === "playing",
    async speak(text, options): Promise<AudioResult<void>> {
      try {
        await speech.speak(text, options.voiceId, options.rate);
        return { ok: true, value: undefined };
      } catch (cause) {
        return failure(cause, "Playback failed.");
      }
    },
    async stop(): Promise<AudioResult<void>> {
      try {
        await speech.stop();
        return { ok: true, value: undefined };
      } catch (cause) {
        return failure(cause, "Playback could not be stopped.");
      }
    },
  };
}
