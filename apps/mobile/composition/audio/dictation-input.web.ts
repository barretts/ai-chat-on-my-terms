import { audioFailure, type AudioResult } from "@locallab/audio-session";
import type {
  DictationInputPort,
  DictationListenOptions,
} from "@locallab/speech-system";

const unavailable = "Dictation runs on the iPhone's system recognizer, which browsers do not expose.";

/** Honest web stub: no fake recording control, capture never starts. */
export const dictationInput: DictationInputPort = {
  async getAvailability(): Promise<AudioResult<"ready" | "unavailable">> {
    return { ok: true, value: "unavailable" };
  },
  async getLocales(): Promise<AudioResult<string[]>> {
    return { ok: true, value: [] };
  },
  async listen(
    _options: DictationListenOptions & { signal?: AbortSignal },
  ): Promise<AudioResult<string>> {
    return audioFailure("unavailable", unavailable, false);
  },
  async cancel(): Promise<void> {},
  operationInfo() {
    return null;
  },
};
