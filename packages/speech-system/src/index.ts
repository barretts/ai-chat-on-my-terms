import {
  audioFailure,
  type AudioAvailability,
  type AudioResult,
  type SpeakOptions,
  type SpeechInputPort,
  type SpeechOutputPort,
} from "@locallab/audio-session";

export type NativePermission =
  | "granted"
  | "denied"
  | "restricted"
  | "notDetermined";

export interface NativeAvailabilityValue {
  availability: AudioAvailability;
  permission: NativePermission;
  onDeviceSupported: boolean;
  locales: string[];
}

export type NativeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

export interface PartialEvent {
  requestId: string;
  text: string;
  isFinal: boolean;
}

export interface NativeSpeechSystem {
  getAvailability(): Promise<NativeResult<NativeAvailabilityValue>>;
  requestPermission(): Promise<NativeResult<{ permission: NativePermission }>>;
  startListening(options: {
    requestId: string;
    locale?: string;
    onDeviceOnly: boolean;
  }): Promise<NativeResult<{ locale: string; onDevice: boolean }>>;
  stopListening(options: {
    requestId: string;
  }): Promise<NativeResult<{ text: string }>>;
  cancelListening(options: { requestId: string }): Promise<NativeResult<null>>;
  addListener(
    event: "partial",
    listener: (payload: PartialEvent) => void,
  ): { remove(): void };
}

export interface DictationListenOptions {
  locale?: string;
  signal: AbortSignal;
  onPartial?: (text: string) => void;
  /** Silence that may end dictation early; device speech applies it. */
  silenceTimeoutMs?: number;
  /** Hard cap on listening; recognition finalizes automatically once elapsed. */
  maxListeningMs?: number;
}

/**
 * Dictation input beyond the shared port: aborting the listen signal
 * finalizes the capture (stop), while cancel discards the temporary
 * recognition result.
 */
export interface DictationInputPort extends SpeechInputPort {
  listen(
    options: DictationListenOptions & { signal?: AbortSignal },
  ): Promise<AudioResult<string>>;
  cancel(): Promise<void>;
  /**
   * Locale and on-device status for the current or last capture. Set before
   * any partial reaches the caller so network-backed operation is disclosed
   * before dictated text is shown.
   */
  operationInfo(): { locale: string; onDevice: boolean } | null;
}

function mapNativeFailure(
  error: { code: string; message: string },
): AudioResult<never> {
  if (error.code === "PERMISSION_DENIED")
    return audioFailure("permission", error.message, true);
  if (error.code === "UNSUPPORTED_LOCALE" || error.code === "ON_DEVICE_UNAVAILABLE")
    return audioFailure("unsupported", error.message, true);
  if (error.code === "STALE_REQUEST")
    return audioFailure("canceled", error.message, true);
  return audioFailure("failed", error.message, true);
}

export function createSpeechSystemInput(
  native: NativeSpeechSystem,
  options: { requireOnDevice?: boolean } = {},
): DictationInputPort {
  let sequence = 0;
  let info: { locale: string; onDevice: boolean } | null = null;
  interface Active {
    requestId: string;
    canceled: boolean;
    remove: () => void;
    started: boolean;
  }
  let current: Active | null = null;

  const release = (entry: Active) => {
    entry.remove();
    if (current === entry) current = null;
  };

  const settleActive = async () => {
    if (!current) return;
    const entry = current;
    entry.canceled = true;
    await native.cancelListening({ requestId: entry.requestId });
    release(entry);
  };

  return {
    async getAvailability() {
      const result = await native.getAvailability();
      if (!result.ok) return mapNativeFailure(result.error);
      return { ok: true, value: result.value.availability };
    },
    async getLocales() {
      const result = await native.getAvailability();
      if (!result.ok) return mapNativeFailure(result.error);
      return { ok: true, value: result.value.locales };
    },
    async listen(listenOptions) {
      if (listenOptions.signal?.aborted)
        return audioFailure("canceled", "Dictation was canceled.", true);
      const availability = await native.getAvailability();
      if (!availability.ok) return mapNativeFailure(availability.error);
      const snapshot = availability.value;
      if (snapshot.permission !== "granted") {
        // Recognition is a user action, so the prompt happens right here.
        const requested = await native.requestPermission();
        if (!requested.ok) return mapNativeFailure(requested.error);
        if (requested.value.permission !== "granted")
          return audioFailure(
            "permission",
            "Speech recognition needs microphone permission. Your draft was left unchanged.",
            true,
          );
      }
      if (
        listenOptions.locale !== undefined &&
        !snapshot.locales.includes(listenOptions.locale)
      )
        return audioFailure(
          "unsupported",
          `Speech recognition does not support "${listenOptions.locale}" on this device.`,
          true,
        );
      if (options.requireOnDevice === true && !snapshot.onDeviceSupported)
        return audioFailure(
          "unsupported",
          "Offline-only recognition is not available for this language on this device.",
          true,
        );
      if (current) await settleActive();
      sequence += 1;
      const requestId = `dictation-${sequence}`;
      const entry: Active = {
        requestId,
        canceled: false,
        started: false,
        remove: () => {},
      };
      const listener = native.addListener("partial", (event) => {
        // Stale callbacks from canceled, finished or foreign requests die.
        if (
          event.requestId !== requestId ||
          entry.canceled ||
          !entry.started ||
          current !== entry
        )
          return;
        listenOptions.onPartial?.(event.text);
      });
      entry.remove = () => listener.remove();
      current = entry;
      const started = await native.startListening({
        ...(listenOptions.locale === undefined
          ? {}
          : { locale: listenOptions.locale }),
        requestId,
        onDeviceOnly: options.requireOnDevice === true,
      });
      if (!started.ok) {
        release(entry);
        return mapNativeFailure(started.error);
      }
      // Disclosure precedes any delivered text.
      info = started.value;
      entry.started = true;
      let final: AudioResult<string>;
      if (listenOptions.signal?.aborted) {
        final = audioFailure("canceled", "Dictation was canceled.", true);
      } else {
        const { promise, resolve } =
          Promise.withResolvers<AudioResult<string>>();
        const finalize = () => {
          void (async () => {
            if (entry.canceled) {
              resolve(
                audioFailure("canceled", "Dictation was discarded.", true),
              );
              return;
            }
            const stopped = await native.stopListening({ requestId });
            resolve(
              stopped.ok
                ? { ok: true, value: stopped.value.text }
                : mapNativeFailure(stopped.error),
            );
          })();
        };
        listenOptions.signal?.addEventListener("abort", finalize, {
          once: true,
        });
        const timer =
          listenOptions.maxListeningMs === undefined
            ? undefined
            : setTimeout(finalize, listenOptions.maxListeningMs);
        final = await promise;
        clearTimeout(timer);
      }
      release(entry);
      return final;
    },
    async cancel() {
      await settleActive();
    },
    operationInfo: () => info,
    async dispose() {
      await settleActive();
    },
  };
}

/** A system text-to-speech voice installed on the device. */
export interface SystemVoice {
  identifier: string;
  language: string;
  name: string;
}

export interface NativeSpeakOptions {
  text: string;
  language?: string;
  voiceIdentifier?: string;
  /** Rate multiplier around the system default; 1.0 = normal. */
  rate: number;
  /** Pitch multiplier; 1.0 = normal. */
  pitch: number;
}

/**
 * T072 system-output half: the native module exposes AVSpeechSynthesizer
 * here while capture stays on `NativeSpeechSystem`. The `speak` promise
 * settles when playback finishes, is stopped or is interrupted.
 */
export interface NativeSystemSpeechOutput {
  getSpeakAvailability(): Promise<
    NativeResult<{ availability: AudioAvailability }>
  >;
  getSpeechVoices(): Promise<NativeResult<SystemVoice[]>>;
  isSpeaking(): boolean;
  speak(options: NativeSpeakOptions): Promise<NativeResult<null>>;
  stopSpeaking(): Promise<NativeResult<null>>;
}

export interface SystemSpeechOutputPort extends SpeechOutputPort {
  getVoices(): Promise<AudioResult<SystemVoice[]>>;
}

function nativeErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function mapOutputFailure(
  error: { code: string; message: string },
): AudioResult<never> {
  if (error.code === "UNAVAILABLE")
    return audioFailure("unavailable", error.message, false);
  if (error.code === "BUSY")
    return audioFailure("busy", error.message, true);
  if (error.code === "CANCELED")
    return audioFailure("canceled", error.message, true);
  return audioFailure("failed", error.message, true);
}

export function createSystemSpeechOutput(
  native: NativeSystemSpeechOutput,
): SystemSpeechOutputPort {
  let disposed = false;
  return {
    async getAvailability(): Promise<AudioResult<AudioAvailability>> {
      if (disposed)
        return audioFailure(
          "unavailable",
          "The system voice was disposed.",
          false,
        );
      try {
        const result = await native.getSpeakAvailability();
        if (!result.ok) return mapOutputFailure(result.error);
        return { ok: true, value: result.value.availability };
      } catch (cause) {
        return audioFailure(
          "unavailable",
          nativeErrorMessage(cause, "The system voice is unavailable."),
          false,
        );
      }
    },
    async getVoices(): Promise<AudioResult<SystemVoice[]>> {
      try {
        const result = await native.getSpeechVoices();
        if (!result.ok) return mapOutputFailure(result.error);
        return { ok: true, value: result.value };
      } catch (cause) {
        return audioFailure(
          "unavailable",
          nativeErrorMessage(cause, "System voices could not be listed."),
          false,
        );
      }
    },
    isSpeaking(): boolean {
      try {
        return native.isSpeaking();
      } catch {
        return false;
      }
    },
    async speak(text, options): Promise<AudioResult<void>> {
      if (disposed)
        return audioFailure(
          "unavailable",
          "The system voice was disposed.",
          false,
        );
      if (text.trim() === "") return { ok: true, value: undefined };
      const signal = options.signal;
      if (signal?.aborted)
        return audioFailure(
          "canceled",
          "Playback was canceled before it started.",
          true,
        );
      const request: NativeSpeakOptions = {
        text,
        rate: options.rate ?? 1,
        pitch: options.pitch ?? 1,
      };
      if (options.language !== undefined) request.language = options.language;
      if (options.voiceId !== undefined)
        request.voiceIdentifier = options.voiceId;
      try {
        const started = native.speak(request);
        if (!signal) {
          const result = await started;
          return result.ok
            ? { ok: true, value: undefined }
            : mapOutputFailure(result.error);
        }
        const { promise: canceled, resolve: resolveCanceled } =
          Promise.withResolvers<AudioResult<void>>();
        signal.addEventListener(
          "abort",
          () => {
            // Stopping is best-effort; the canceled outcome is already final.
            void native.stopSpeaking().catch(() => {});
            resolveCanceled(
              audioFailure("canceled", "Playback was canceled.", true),
            );
          },
          { once: true },
        );
        return await Promise.race([
          started.then((result) =>
            result.ok
              ? { ok: true as const, value: undefined }
              : mapOutputFailure(result.error),
          ),
          canceled,
        ]);
      } catch (cause) {
        return audioFailure(
          "failed",
          nativeErrorMessage(cause, "System playback failed."),
          true,
        );
      }
    },
    async stop(): Promise<AudioResult<void>> {
      try {
        const result = await native.stopSpeaking();
        if (!result.ok) return mapOutputFailure(result.error);
        return { ok: true, value: undefined };
      } catch (cause) {
        return audioFailure(
          "failed",
          nativeErrorMessage(cause, "System playback could not be stopped."),
          true,
        );
      }
    },
    async dispose(): Promise<void> {
      disposed = true;
      try {
        await native.stopSpeaking();
      } catch {
        // Idle disposal must stay safe.
      }
    },
  };
}

/**
 * Raw PCM capture half of the native module (T077 local Whisper). Capture is
 * exclusive: the module rejects a second owner while dictation or another
 * capture holds the microphone.
 */
export interface NativePcmCaptureModule {
  requestCapturePermission(): Promise<NativeResult<{ granted: boolean }>>;
  startCapture(options: { sampleRate: number }): Promise<NativeResult<null>>;
  stopCapture(): Promise<
    NativeResult<{ sampleRate: number; samples: number[] }>
  >;
  cancelCapture(): Promise<NativeResult<null>>;
}

export interface PcmCapturePort {
  requestPermission(): Promise<boolean>;
  start(sampleRate: number): Promise<void>;
  stop(): Promise<{ sampleRate: number; samples: number[] }>;
  cancel(): Promise<void>;
}

export function createPcmCapture(
  native: NativePcmCaptureModule,
): PcmCapturePort {
  return {
    async requestPermission(): Promise<boolean> {
      try {
        const result = await native.requestCapturePermission();
        return result.ok && result.value.granted;
      } catch {
        return false;
      }
    },
    async start(sampleRate: number): Promise<void> {
      const result = await native.startCapture({ sampleRate });
      if (!result.ok)
        throw new Error(result.error.message || "Could not start audio capture.");
    },
    async stop(): Promise<{ sampleRate: number; samples: number[] }> {
      const result = await native.stopCapture();
      if (!result.ok)
        throw new Error(
          result.error.message || "Audio capture could not be finalized.",
        );
      return result.value;
    },
    async cancel(): Promise<void> {
      try {
        await native.cancelCapture();
      } catch {
        // Discarding a capture is best-effort.
      }
    },
  };
}
