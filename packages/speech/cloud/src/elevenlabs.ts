import {
  createHttpTransport,
  httpResponseError,
  type FetchLike,
} from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import {
  cloudVoiceResult,
  requireSpeed,
  requireText,
  requireVoiceId,
  VoiceSettingsError,
  type CloudVoice,
  type CloudVoiceProvider,
  type SynthesizeOptions,
} from "./shared";

export const ELEVENLABS_ORIGIN = "https://api.elevenlabs.io";
export const ELEVENLABS_MODEL = "eleven_multilingual_v2";

export interface ElevenLabsConnection {
  readonly origin?: string;
  readonly apiKeyRef: SecretRef;
  /** Synthesis model; defaults to the multilingual v2 model. */
  readonly modelId?: string;
}

export interface ElevenLabsVoiceSettings {
  /** 0..1 — higher is more consistent, less expressive. */
  stability?: number;
  /** 0..1 — higher follows the reference clip more closely. */
  similarityBoost?: number;
  /** 0.7..1.2 — accepted by the turbo and later models. */
  speed?: number;
}

export interface ElevenLabsOptions {
  readonly secrets: SecretStore;
  readonly resolveConnection: (
    personaConnectionId: string,
  ) => Promise<ElevenLabsConnection>;
  readonly fetch: FetchLike;
  readonly personaConnectionId: string;
  readonly settings?: ElevenLabsVoiceSettings;
}

/**
 * ElevenLabs voice catalog and streaming synthesis (VO-04). The API key is a
 * host-scoped SecretStore reference (`xi-api-key` header) and is resolved per
 * request; a selected-but-unknown voice fails instead of substituting one.
 */
export function createElevenLabsVoices(
  options: ElevenLabsOptions,
): CloudVoiceProvider {
  const backend = "elevenlabs" as const;
  async function target(): Promise<{
    origin: string;
    headers: Record<string, string>;
    modelId?: string;
  }> {
    const connection = await options.resolveConnection(
      options.personaConnectionId,
    );
    const origin = connection.origin ?? ELEVENLABS_ORIGIN;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new VoiceSettingsError("ElevenLabs origin is not a valid URL.");
    }
    if (url.protocol !== "https:")
      throw new VoiceSettingsError("ElevenLabs requires an HTTPS origin.");
    const headers = await options.secrets.resolveHeaders(origin, [
      connection.apiKeyRef,
    ]);
    if (!("xi-api-key" in headers))
      throw new VoiceSettingsError(
        "The stored ElevenLabs credential is not an xi-api-key header.",
      );
    return {
      origin,
      headers: { ...headers },
      ...(connection.modelId === undefined
        ? {}
        : { modelId: connection.modelId }),
    };
  }
  function transport(origin: string) {
    return createHttpTransport({
      fetch: options.fetch,
      policy: { authorizedOrigins: [origin] },
    });
  }
  return {
    provider: backend,
    listVoices(signal) {
      return cloudVoiceResult(async () => {
        const { origin, headers } = await target();
        const http = transport(origin);
        const response = await http.request(
          new URL("/v1/voices", origin),
          { headers, method: "GET" },
          { returnHttpErrors: true, ...(signal ? { signal } : {}) },
        );
        if (!response.ok)
          throw await httpResponseError(response, {
            ...(signal ? { signal } : {}),
          });
        const body: unknown = await response.json();
        const voices =
          isObj(body) && Array.isArray(body.voices) ? body.voices : undefined;
        if (!voices)
          throw new VoiceSettingsError("ElevenLabs voice list was malformed.");
        const list: CloudVoice[] = [];
        for (const voice of voices) {
          if (!isObj(voice)) continue;
          const voiceId = str(voice.voice_id);
          const name = str(voice.name);
          if (!voiceId || !name) continue;
          list.push({
            id: voiceId,
            name,
            provider: backend,
            category: str(voice.category) ?? "",
            labels: labelMap(voice.labels),
          });
        }
        if (list.length === 0)
          throw new VoiceSettingsError(
            "ElevenLabs returned no voices for this account.",
          );
        return list;
      }, backend);
    },
    synthesize(request: SynthesizeOptions) {
      return cloudVoiceResult(async () => {
        requireText(request.text);
        requireVoiceId(request.voiceId);
        const settings = options.settings ?? {};
        requireRange(settings.stability, 0, 1, "ElevenLabs stability");
        requireRange(
          settings.similarityBoost,
          0,
          1,
          "ElevenLabs similarity boost",
        );
        requireSpeed(settings.speed, 0.7, 1.2, "ElevenLabs");
        const { origin, headers, modelId } = await target();
        const http = transport(origin);
        const voiceSettings: Record<string, number> = {};
        if (settings.stability !== undefined)
          voiceSettings.stability = settings.stability;
        if (settings.similarityBoost !== undefined)
          voiceSettings.similarity_boost = settings.similarityBoost;
        if (settings.speed !== undefined) voiceSettings.speed = settings.speed;
        const response = await http.request(
          new URL(
            `/v1/text-to-speech/${encodeURIComponent(request.voiceId)}/stream`,
            origin,
          ),
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              text: request.text,
              model_id: modelId ?? ELEVENLABS_MODEL,
              ...(Object.keys(voiceSettings).length > 0
                ? { voice_settings: voiceSettings }
                : {}),
              ...(request.language && request.language !== "auto"
                ? { language_code: request.language }
                : {}),
            }),
          },
          {
            returnHttpErrors: true,
            timeoutMs: 120_000,
            signal: request.signal,
          },
        );
        if (!response.ok)
          throw await httpResponseError(response, { signal: request.signal });
        return await consumeAudio(response, request.onChunk);
      }, backend);
    },
  };
}

async function consumeAudio(
  response: Response,
  onChunk: ((bytes: Uint8Array) => void) | undefined,
): Promise<number> {
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        onChunk?.(value);
      }
    }
    return total;
  }
  // React Native fetch may not expose a body stream; the whole buffer still
  // arrives, just without incremental playback.
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > 0) onChunk?.(buffer);
  return buffer.byteLength;
}

function requireRange(
  value: number | undefined,
  min: number,
  max: number,
  label: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < min || value > max)
    throw new VoiceSettingsError(
      `${label} must be between ${min} and ${max}.`,
    );
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function labelMap(value: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!isObj(value)) return labels;
  for (const [key, item] of Object.entries(value))
    if (typeof item === "string" && item !== "") labels[key] = item;
  return labels;
}
