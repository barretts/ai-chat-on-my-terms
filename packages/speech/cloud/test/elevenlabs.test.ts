import { describe, expect, it } from "vitest";
import type { FetchLike } from "@locallab/network-http";
import {
  SecretStoreError,
  type SecretRef,
  type SecretStore,
} from "@locallab/security-secrets";
import {
  createElevenLabsVoices,
  ELEVENLABS_MODEL,
  type ElevenLabsVoiceSettings,
} from "../src/index.js";

const ref = "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as SecretRef;
const secrets: SecretStore = {
  async put() {
    throw new Error("unused");
  },
  async remove() {},
  async resolveHeaders(host, refs) {
    expect(host).toBe("https://api.elevenlabs.io");
    expect(refs).toEqual([ref]);
    return { "xi-api-key": "fixture-key" };
  },
};
const missingKeyStore: SecretStore = {
  async put() {
    throw new Error("unused");
  },
  async remove() {},
  async resolveHeaders() {
    throw new SecretStoreError("missing");
  },
};
function provider(
  fetch: FetchLike,
  extra: { settings?: ElevenLabsVoiceSettings } = {},
) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const recording: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return fetch(input, init);
  };
  return {
    calls,
    voices: createElevenLabsVoices({
      secrets,
      resolveConnection: async () => ({ apiKeyRef: ref }),
      fetch: recording,
      personaConnectionId: "persona-1",
      ...extra,
    }),
  };
}
function audioStream(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "audio/mpeg" } },
  );
}

describe("ElevenLabs voices", () => {
  it("lists voices through the credential-scoped catalog", async () => {
    const { calls, voices } = provider(async () =>
      Response.json({
        voices: [
          {
            voice_id: "aria",
            name: "Aria",
            category: "premade",
            labels: { language: "en", accent: "american", niche: null },
          },
          { voice_id: "nosports", name: "No Sports" },
        ],
      }),
    );
    const result = await voices.listVoices();
    expect(result.ok && result.value).toEqual([
      {
        id: "aria",
        name: "Aria",
        provider: "elevenlabs",
        category: "premade",
        labels: { language: "en", accent: "american" },
      },
      {
        id: "nosports",
        name: "No Sports",
        provider: "elevenlabs",
        category: "",
        labels: {},
      },
    ]);
    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/voices");
    expect(new Headers(calls[0]?.init?.headers).get("xi-api-key")).toBe(
      "fixture-key",
    );
  });
  it("streams synthesis chunks with persona settings", async () => {
    const { calls, voices } = provider(() => Promise.resolve(audioStream(["AB", "CDE"])), {
      settings: { stability: 0.4, similarityBoost: 0.8, speed: 1.1 },
    });
    const chunks: string[] = [];
    const result = await voices.synthesize({
      text: "Hello",
      voiceId: "aria",
      language: "de",
      signal: new AbortController().signal,
      onChunk: (bytes) => chunks.push(new TextDecoder().decode(bytes)),
    });
    expect(result).toEqual({ ok: true, value: 5 });
    expect(chunks).toEqual(["AB", "CDE"]);
    expect(calls[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/aria/stream",
    );
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      text: "Hello",
      model_id: ELEVENLABS_MODEL,
      voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.1 },
      language_code: "de",
    });
  });
  it("rejects invalid speech settings before any request", async () => {
    const { calls, voices } = provider(
      async () => Promise.reject(new Error("must not fetch")),
      { settings: { speed: 2 } },
    );
    const result = await voices.synthesize({
      text: "Hello",
      voiceId: "aria",
      signal: new AbortController().signal,
    });
    expect(!result.ok && result.error.code).toBe("validation");
    expect(!result.ok && result.error.message).toContain("speed");
    expect(calls).toEqual([]);
  });
  it("reports a missing stored key as an auth failure", async () => {
    const voices = createElevenLabsVoices({
      secrets: missingKeyStore,
      resolveConnection: async () => ({ apiKeyRef: ref }),
      fetch: async () => Promise.reject(new Error("must not fetch")),
      personaConnectionId: "persona-1",
    });
    const result = await voices.listVoices();
    expect(!result.ok && result.error.code).toBe("auth");
    expect(!result.ok && result.error.message).toContain("No stored API key");
  });
  it.each([
    [401, "auth", "Invalid API key"],
    [403, "entitlement", "quota_exceeded"],
    [403, "region", "not available in this region"],
  ] as const)(
    "passes through HTTP %i provider failures without substituting a voice",
    async (status, code, bodyText) => {
      const { voices } = provider(async () =>
        new Response(JSON.stringify({ detail: { status: bodyText } }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
      const result = await voices.synthesize({
        text: "Hello",
        voiceId: "missing-voice",
        signal: new AbortController().signal,
      });
      expect(!result.ok && result.error.code).toBe(code);
      expect(!result.ok && result.error.message).toContain(bodyText);
    },
  );
  it("fails unknown voices as voice-not-found", async () => {
    const { voices } = provider(async () =>
      new Response('{"detail":"Voice not found"}', { status: 404 }),
    );
    const result = await voices.synthesize({
      text: "Hello",
      voiceId: "ghost",
      signal: new AbortController().signal,
    });
    expect(!result.ok && result.error.code).toBe("voice-not-found");
    expect(!result.ok && result.error.message).toContain("Voice not found");
  });
});
