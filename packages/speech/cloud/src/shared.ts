import { errorDetails, HttpTransportError } from "@locallab/network-http";
import { SecretStoreError } from "@locallab/security-secrets";

export type CloudVoiceProviderId = "elevenlabs" | "xai";

export interface CloudVoice {
  id: string;
  name: string;
  provider: CloudVoiceProviderId;
  /** Provider category/bucket label when the backend publishes one. */
  category: string;
  /** Free-form provider labels (language, accent, gender...). */
  labels: Record<string, string>;
}

export type CloudVoiceErrorCode =
  | "auth"
  | "entitlement"
  | "voice-not-found"
  | "rate-limit"
  | "region"
  | "validation"
  | "canceled"
  | "timeout"
  | "malformed"
  | "offline";

export interface CloudVoiceError {
  code: CloudVoiceErrorCode;
  message: string;
  recoverable: boolean;
}

export type CloudVoiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CloudVoiceError };

export function cloudVoiceFailure(
  code: CloudVoiceErrorCode,
  message: string,
  recoverable: boolean,
): CloudVoiceResult<never> {
  return { ok: false, error: { code, message, recoverable } };
}

export interface SynthesizeOptions {
  text: string;
  /**
   * Voice chosen by the persona/app settings. There is no fallback: a bad id
   * fails as `voice-not-found` instead of silently substituting a default.
   */
  voiceId: string;
  /** BCP-47 hint; "auto"/undefined lets the provider detect the language. */
  language?: string;
  /** Speech-rate multiplier; each provider validates its own accepted range. */
  speed?: number;
  signal: AbortSignal;
  /** Called for each audio chunk; without it the bytes are only counted. */
  onChunk?: (bytes: Uint8Array) => void;
}

export interface CloudVoiceProvider {
  readonly provider: CloudVoiceProviderId;
  listVoices(signal?: AbortSignal): Promise<CloudVoiceResult<CloudVoice[]>>;
  /** Streams synthesis to `onChunk`; resolves with the total byte count. */
  synthesize(options: SynthesizeOptions): Promise<CloudVoiceResult<number>>;
}

/** Preflight rejection of provider-specific speech settings. */
export class VoiceSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceSettingsError";
  }
}

export function requireText(text: string): void {
  if (!text.trim())
    throw new VoiceSettingsError("Enter text before synthesizing speech.");
  if (text.length > 50_000)
    throw new VoiceSettingsError(
      "This text is longer than the provider's per-request limit.",
    );
}

export function requireVoiceId(voiceId: string): void {
  if (!voiceId.trim())
    throw new VoiceSettingsError(
      "Choose a voice for this persona before synthesizing speech.",
    );
}

export function requireSpeed(
  speed: number | undefined,
  min: number,
  max: number,
  backend: string,
): void {
  if (speed === undefined) return;
  if (!Number.isFinite(speed) || speed < min || speed > max)
    throw new VoiceSettingsError(
      `${backend} speech speed must be between ${min} and ${max}.`,
    );
}

const backendNames: Record<CloudVoiceProviderId, string> = {
  elevenlabs: "ElevenLabs",
  xai: "xAI",
};

/**
 * Maps transport and secret failures to voice-specific codes. API responses
 * pass through verbatim so entitlement, region, and unknown-voice problems
 * are visible instead of masked by a retry with a default voice.
 */
export function cloudVoiceFailureFrom(
  error: unknown,
  backend: CloudVoiceProviderId,
): CloudVoiceError {
  const name = backendNames[backend];
  if (error instanceof VoiceSettingsError)
    return { code: "validation", message: error.message, recoverable: false };
  if (error instanceof SecretStoreError)
    return {
      code: "auth",
      message:
        error.code === "missing"
          ? `No stored API key was found for ${name}. Add the key in Settings.`
          : `The stored ${name} API key could not be read.`,
      recoverable: true,
    };
  if (error instanceof HttpTransportError) {
    const body = error.response?.body ?? "";
    if (error.code === "canceled")
      return {
        code: "canceled",
        message: `${name} request was canceled.`,
        recoverable: true,
      };
    if (error.code === "timeout")
      return {
        code: "timeout",
        message: `${name} request timed out.\n${errorDetails(error)}`,
        recoverable: true,
      };
    if (error.code === "unauthorized")
      return {
        code: "auth",
        message: `${name} rejected the API key.\n${body}`,
        recoverable: true,
      };
    if (error.code === "forbidden") {
      if (/region|cluster|country/i.test(body))
        return {
          code: "region",
          message: `${name} does not serve this region.\n${body}`,
          recoverable: false,
        };
      return {
        code: "entitlement",
        message: `${name} refused this account or plan.\n${body}`,
        recoverable: false,
      };
    }
    if (error.status === 404)
      return {
        code: "voice-not-found",
        message: `${name} does not have this voice or endpoint.\n${body}`,
        recoverable: false,
      };
    if (error.status === 429)
      return {
        code: "rate-limit",
        message: `${name} rate limit or quota was reached.\n${body}`,
        recoverable: true,
      };
    if (
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500
    )
      return {
        code: "validation",
        message: `${name} rejected the request.\n${body}`,
        recoverable: false,
      };
    if (error.code === "malformed_stream" || error.code === "stream_too_large")
      return {
        code: "malformed",
        message: `${name} sent a malformed audio stream.\n${errorDetails(error)}`,
        recoverable: true,
      };
    return {
      code: "offline",
      message: `${name} request failed.\n${errorDetails(error)}`,
      recoverable: true,
    };
  }
  return {
    code: "offline",
    message: `${name} request failed.\n${errorDetails(error)}`,
    recoverable: true,
  };
}

export function cloudVoiceResult<T>(
  action: () => Promise<T>,
  backend: CloudVoiceProviderId,
): Promise<CloudVoiceResult<T>> {
  return action().then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error: cloudVoiceFailureFrom(error, backend) }),
  );
}
