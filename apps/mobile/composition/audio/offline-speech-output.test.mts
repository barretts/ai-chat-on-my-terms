import { expect, it } from "vitest";
import type { OfflineSpeech, SpeechState } from "../../platform/speech/types";
import { createOfflineSpeechOutput } from "./offline-speech-output";

function fakeSpeech(overrides: Partial<OfflineSpeech> = {}) {
  const state: SpeechState = {
    phase: "idle",
    selectedVoiceId: "af_heart",
    installedModelIds: ["kokoro-v1"],
    message: "",
    progress: null,
    audioUri: null,
    rate: 0.9,
  };
  const speakCalls: [string, string | undefined, number | undefined][] = [];
  let stops = 0;
  const speech: OfflineSpeech = {
    snapshot: () => state,
    subscribe: () => () => {},
    refresh: async () => {},
    selectVoice: async () => {},
    setRate: async () => {},
    install: async () => {},
    remove: async () => {},
    speak: async (text, voiceId, rate) => {
      speakCalls.push([text, voiceId, rate]);
      state.phase = "playing";
    },
    stop: async () => {
      stops += 1;
      state.phase = "idle";
    },
    ...overrides,
  };
  return { speech, state, speakCalls, stopCount: () => stops };
}

it("preserves voice, rate and Persona state through the adapter", async () => {
  const { speech, state, speakCalls, stopCount } = fakeSpeech();
  const output = createOfflineSpeechOutput(speech);
  expect((await output.getAvailability()).ok).toBe(true);
  const availability = await output.getAvailability();
  expect(
    availability.ok && availability.value === "ready" ? "ready" : "other",
  ).toBe("ready");
  expect(await output.speak("hello", {})).toEqual({ ok: true, value: undefined });
  expect(speakCalls).toEqual([["hello", undefined, undefined]]);
  // The service keeps its separately stored selections untouched.
  expect(state.selectedVoiceId).toBe("af_heart");
  expect(state.rate).toBe(0.9);
  expect(output.isSpeaking()).toBe(true);
  expect(await output.stop()).toEqual({ ok: true, value: undefined });
  expect(stopCount()).toBe(1);
  expect(output.isSpeaking()).toBe(false);
});

it("passes explicit voice and rate overrides to the service", async () => {
  const { speech, speakCalls } = fakeSpeech();
  const output = createOfflineSpeechOutput(speech);
  await output.speak("persona line", { voiceId: "af_bella", rate: 1.2 });
  expect(speakCalls).toEqual([["persona line", "af_bella", 1.2]]);
});

it("reports unavailable without installed voices and maps failures", async () => {
  const { speech, state } = fakeSpeech({
    speak: async () => {
      throw new Error("No voice packs are installed.");
    },
  });
  state.installedModelIds = [];
  const output = createOfflineSpeechOutput(speech);
  const availability = await output.getAvailability();
  expect(availability.ok && availability.value === "unavailable").toBe(true);
  const result = await output.speak("hello", {});
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("failure must surface");
  expect(result.error).toMatchObject({
    code: "failed",
    message: "No voice packs are installed.",
    recoverable: true,
  });
});
