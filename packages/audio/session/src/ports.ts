/**
 * Shared speech contracts. One coordinator owns capture and playback so a
 * dictation microphone never records device output and cancellation stays
 * scoped to the work that was actually owned.
 */

export type AudioPortCode =
  | "unavailable"
  | "permission"
  | "unsupported"
  | "busy"
  | "draining"
  | "canceled"
  | "failed";

export interface AudioFailure {
  code: AudioPortCode;
  message: string;
  recoverable: boolean;
}

export type AudioResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AudioFailure };

export function audioFailure(
  code: AudioPortCode,
  message: string,
  recoverable: boolean,
): AudioResult<never> {
  return { ok: false, error: { code, message, recoverable } };
}

export type AudioAvailability = "ready" | "permission" | "unavailable";

export interface ListenOptions {
  locale?: string;
  signal: AbortSignal;
  onPartial?: (text: string) => void;
}

/** Recognition side, implemented later by the iOS dictation adapter (C04). */
export interface SpeechInputPort {
  getAvailability(): Promise<AudioResult<AudioAvailability>>;
  getLocales(): Promise<AudioResult<string[]>>;
  /**
   * Captures until the signal aborts and resolves with the final transcript;
   * partial hypotheses arrive through `onPartial`. A rejected promise must
   * stay a programming-error signal, not a normal cancellation path.
   */
  listen(options: ListenOptions): Promise<AudioResult<string>>;
  dispose?(): Promise<void>;
}

export interface SpeakOptions {
  voiceId?: string;
  rate?: number;
  signal?: AbortSignal;
}

/** Playback side, adapted from the existing offline TTS service. */
export interface SpeechOutputPort {
  getAvailability(): Promise<AudioResult<AudioAvailability>>;
  isSpeaking(): boolean;
  speak(text: string, options: SpeakOptions): Promise<AudioResult<void>>;
  /** Idempotent: stopping already-idle playback must succeed. */
  stop(): Promise<AudioResult<void>>;
  dispose?(): Promise<void>;
}
