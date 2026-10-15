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

export const XAI_ORIGIN = "https://api.x.ai";

export interface XaiConnection {
  readonly origin?: string;
  readonly apiKeyRef: SecretRef;
}

export interface XaiOptions {
  readonly secrets: SecretStore;
  readonly resolveConnection: (
    personaConnectionId: string,
  ) => Promise<XaiConnection>;
  readonly fetch: FetchLike;
  readonly personaConnectionId: string;
  /** 0.7..1.5 speech-rate multiplier applied to every request. */
  readonly speed?: number;
}

/**
 * Grok/xAI voice catalog and streaming synthesis (VO-04) against
 * `POST /v1/tts` and `GET /v1/tts/voices`. The bearer key lives in the
 * host-scoped SecretStore; unknown voice ids fail without substitution.
 */
export function createXaiVoices(options: XaiOptions): CloudVoiceProvider {
  const backend = "xai" as const;
  async function target(): Promise<{
    origin: string;
    headers: Record<string, string>;
  }> {
    const connection = await options.resolveConnection(
      options.personaConnectionId,
    );
    const origin = connection.origin ?? XAI_ORIGIN;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new VoiceSettingsError("xAI origin is not a valid URL.");
    }
    if (url.protocol !== "https:")
      throw new VoiceSettingsError("xAI requires an HTTPS origin.");
    const headers = await options.secrets.resolveHeaders(origin, [
      connection.apiKeyRef,
    ]);
    if (!("authorization" in headers))
      throw new VoiceSettingsError(
        "The stored xAI credential is not an Authorization header.",
      );
    return { origin, headers: { ...headers } };
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
          new URL("/v1/tts/voices", origin),
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
          throw new VoiceSettingsError("xAI voice list was malformed.");
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
          throw new VoiceSettingsError("xAI returned no voices for this key.");
        return list;
      }, backend);
    },
    synthesize(request: SynthesizeOptions) {
      return cloudVoiceResult(async () => {
        requireText(request.text);
        requireVoiceId(request.voiceId);
        requireSpeed(options.speed, 0.7, 1.5, "xAI");
        const { origin, headers } = await target();
        const http = transport(origin);
        const response = await http.request(
          new URL("/v1/tts", origin),
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              text: request.text,
              voice_id: request.voiceId,
              // The endpoint requires a language; "auto" keeps detection.
              language: request.language ?? "auto",
              ...(options.speed === undefined
                ? {}
                : { speed: options.speed }),
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
