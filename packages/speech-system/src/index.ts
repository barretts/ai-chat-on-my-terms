import {
  audioFailure,
  type AudioAvailability,
  type AudioResult,
  type SpeechInputPort,
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
        final = await promise;
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
