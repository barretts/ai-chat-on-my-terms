import { describe, expect, it } from "vitest";
import type { FetchLike } from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { createXaiVoices } from "../src/index.js";

const ref = "sec_018f0b1a-7b3c-7abc-8def-123456789abd" as SecretRef;
const secrets: SecretStore = {
  async put() {
    throw new Error("unused");
  },
  async remove() {},
  async resolveHeaders(host, refs) {
    expect(host).toBe("https://api.x.ai");
    expect(refs).toEqual([ref]);
    return { authorization: "Bearer fixture-key" };
  },
};
function provider(fetch: FetchLike, speed?: number) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const recording: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return fetch(input, init);
  };
  return {
    calls,
    voices: createXaiVoices({
      secrets,
      resolveConnection: async () => ({ apiKeyRef: ref }),
      fetch: recording,
      personaConnectionId: "persona-2",
      ...(speed === undefined ? {} : { speed }),
    }),
  };
}

describe("xAI Grok voices", () => {
  it("lists voices from the TTS catalog", async () => {
    const { calls, voices } = provider(async () =>
      Response.json({
        voices: [
          { voice_id: "eve", name: "Eve" },
          { voice_id: "ara", name: "Ara" },
          { voice_id: "", name: "Broken" },
        ],
      }),
    );
    const result = await voices.listVoices();
    expect(result.ok && result.value).toEqual([
      { id: "eve", name: "Eve", provider: "xai", category: "", labels: {} },
      { id: "ara", name: "Ara", provider: "xai", category: "", labels: {} },
    ]);
    expect(calls[0]?.url).toBe("https://api.x.ai/v1/tts/voices");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer fixture-key",
    );
  });
  it("synthesizes with auto language and configured speed", async () => {
    const { calls, voices } = provider(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "audio/mpeg" },
        }),
      1.3,
    );
    const chunks: number[] = [];
    const result = await voices.synthesize({
      text: "Hello",
      voiceId: "eve",
      signal: new AbortController().signal,
      onChunk: (bytes) => chunks.push(bytes.byteLength),
    });
    expect(result).toEqual({ ok: true, value: 4 });
    expect(chunks).toEqual([4]);
    expect(calls[0]?.url).toBe("https://api.x.ai/v1/tts");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      text: "Hello",
      voice_id: "eve",
      language: "auto",
      speed: 1.3,
    });
  });
  it("rejects speed outside the provider range before fetching", async () => {
    const { calls, voices } = provider(
      async () => Promise.reject(new Error("must not fetch")),
      0.5,
    );
    const result = await voices.synthesize({
      text: "Hello",
      voiceId: "eve",
      signal: new AbortController().signal,
    });
    expect(!result.ok && result.error.code).toBe("validation");
    expect(calls).toEqual([]);
  });
  it("surfaces unknown-voice rejections verbatim", async () => {
    const { voices } = provider(async () =>
      Response.json(
        { error: { message: "invalid voice_id: ghost" } },
        { status: 400 },
      ),
    );
    const result = await voices.synthesize({
      text: "Hello",
      voiceId: "ghost",
      signal: new AbortController().signal,
    });
    expect(!result.ok && result.error.code).toBe("validation");
    expect(!result.ok && result.error.message).toContain(
      "invalid voice_id: ghost",
    );
  });
  it("maps entitlement refusals without substituting a voice", async () => {
    const { voices } = provider(async () =>
      new Response('{"error":{"message":"voice access not enabled"}}', {
        status: 403,
      }),
    );
    const result = await voices.synthesize({
      text: "Hello",
      voiceId: "ara",
      signal: new AbortController().signal,
    });
    expect(!result.ok && result.error.code).toBe("entitlement");
    expect(!result.ok && result.error.message).toContain(
      "voice access not enabled",
    );
  });
  it("reports a pre-canceled request as canceled without fetching", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, voices } = provider(async () => {
      throw new Error("must not fetch");
    });
    const result = await voices.synthesize({
      text: "Hello",
      voiceId: "eve",
      signal: controller.signal,
    });
    expect(!result.ok && result.error.code).toBe("canceled");
    expect(calls).toEqual([]);
  });
});
