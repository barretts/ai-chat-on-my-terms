import {
  audioFailure,
  type AudioResult,
  type ListenOptions,
} from "@locallab/audio-session";
import type { DictationInputPort } from "@locallab/speech-system";
import type { OfflineTranscription } from "../../platform/whisper/types";

const localeToWhisper: Record<string, string> = {
  "en-US": "en",
  "en-GB": "en",
  "de-DE": "de",
  "es-ES": "es",
  "fr-FR": "fr",
  "ru-RU": "ru",
  "it-IT": "it",
  "pt-BR": "pt",
  "zh-CN": "zh",
  "ja-JP": "ja",
};

/**
 * Routes local Whisper (T077) through the shared dictation contract. Same
 * finalize/cancel semantics as the system dictation port: aborting the
 * listen signal finalizes the capture for transcription, and `cancel()`
 * discards it without recognizing.
 */
export function createWhisperInputPort(
  whisper: OfflineTranscription,
): DictationInputPort {
  let active: { abort(): void } | null = null;
  let last: { locale: string; onDevice: boolean } | null = null;
  return {
    async getAvailability() {
      return whisper.snapshot().installedModelIds.length > 0
        ? { ok: true, value: "ready" as const }
        : audioFailure(
            "unavailable",
            "Download a Whisper model in Voice settings first.",
            true,
          );
    },
    async getLocales(): Promise<AudioResult<string[]>> {
      return { ok: true, value: Object.keys(localeToWhisper) };
    },
    operationInfo() {
      return last;
    },
    async listen(
      options: ListenOptions & { signal?: AbortSignal },
    ): Promise<AudioResult<string>> {
      if (active)
        return audioFailure("busy", "Transcription is already running.", true);
      if (options.signal?.aborted)
        return audioFailure("canceled", "Transcription was canceled.", true);
      const locale = options.locale;
      const mapped = locale === undefined ? undefined : localeToWhisper[locale];
      if (locale !== undefined && mapped === undefined)
        return audioFailure(
          "unsupported",
          `${locale} is not in the offline Whisper language list.`,
          true,
        );
      const code = mapped ?? whisper.snapshot().language;
      whisper.setLanguage(code);
      const internal = new AbortController();
      active = internal;
      const started = await whisper.listen(internal.signal);
      last = { locale: locale ?? "auto", onDevice: true };
      const finalize = () => started.handle.stop();
      const timer =
        options.maxListeningMs === undefined
          ? undefined
          : setTimeout(finalize, options.maxListeningMs);
      if (options.signal?.aborted) finalize();
      else options.signal?.addEventListener("abort", finalize, { once: true });
      const outcome = await started.outcome;
      options.signal?.removeEventListener("abort", finalize);
      clearTimeout(timer);
      if (active === internal) active = null;
      if (outcome.ok) {
        const text = outcome.text.trim();
        options.onPartial?.(text);
        return { ok: true, value: text };
      }
      return audioFailure(outcome.code, outcome.message, true);
    },
    async cancel(): Promise<void> {
      active?.abort();
    },
    async dispose(): Promise<void> {
      active?.abort();
      await whisper.dispose();
    },
  };
}
