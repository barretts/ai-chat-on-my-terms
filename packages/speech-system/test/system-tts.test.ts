import { describe, expect, it } from "vitest";
import {
  createSystemSpeechOutput,
  type NativeResult,
  type NativeSpeakOptions,
  type NativeSystemSpeechOutput,
  type SystemVoice,
} from "../src/index.js";
import type { AudioAvailability } from "@locallab/audio-session";

class FakeOutput implements NativeSystemSpeechOutput {
  requests: NativeSpeakOptions[] = [];
  speakCalls = 0;
  stopCalls = 0;
  voicesCalls = 0;
  availability: AudioAvailability = "ready";
  voices: SystemVoice[] = [
    {
      identifier: "com.apple.voice.compact.en-US.Samantha",
      language: "en-US",
      name: "Samantha",
    },
  ];
  speaking = false;
  stopResult: NativeResult<null> = { ok: true, value: null };
  rejectSpeak: Error | undefined;
  private finish:
    | ((result: NativeResult<null>) => void)
    | undefined;

  async getSpeakAvailability(): Promise<
    NativeResult<{ availability: AudioAvailability }>
  > {
    return { ok: true, value: { availability: this.availability } };
  }

  async getSpeechVoices(): Promise<NativeResult<SystemVoice[]>> {
    this.voicesCalls += 1;
    return { ok: true, value: this.voices };
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  speak(options: NativeSpeakOptions): Promise<NativeResult<null>> {
    this.speakCalls += 1;
    this.requests.push(options);
    if (this.rejectSpeak) return Promise.reject(this.rejectSpeak);
    if (this.speaking)
      return Promise.resolve({
        ok: false,
        error: { code: "BUSY", message: "The system voice is already speaking." },
      });
    this.speaking = true;
    const { promise, resolve } = Promise.withResolvers<NativeResult<null>>();
    this.finish = resolve;
    return promise;
  }

  async stopSpeaking(): Promise<NativeResult<null>> {
    this.stopCalls += 1;
    this.settle({ ok: true, value: null });
    return this.stopResult;
  }

  settle(result: NativeResult<null>): void {
    const finish = this.finish;
    this.finish = undefined;
    this.speaking = false;
    finish?.(result);
  }
}

describe("system speech output availability", () => {
  it("mirrors the native availability state", async () => {
    const native = new FakeOutput();
    const port = createSystemSpeechOutput(native);
    await expect(port.getAvailability()).resolves.toEqual({
      ok: true,
      value: "ready",
    });
    native.availability = "unavailable";
    await expect(port.getAvailability()).resolves.toEqual({
      ok: true,
      value: "unavailable",
    });
  });

  it("lists the installed system voices", async () => {
    const port = createSystemSpeechOutput(new FakeOutput());
    const result = await port.getVoices();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.name).toBe("Samantha");
  });
});

describe("system speech output playback", () => {
  it("passes voice, language and multipliers to the native module", async () => {
    const native = new FakeOutput();
    const port = createSystemSpeechOutput(native);
    const speaking = port.speak("Hello", {
      voiceId: "com.apple.voice.compact.en-US.Samantha",
      language: "en-US",
      rate: 1.25,
      pitch: 0.9,
    });
    native.settle({ ok: true, value: null });
    await expect(speaking).resolves.toEqual({ ok: true, value: undefined });
    expect(native.requests).toEqual([
      {
        text: "Hello",
        rate: 1.25,
        pitch: 0.9,
        language: "en-US",
        voiceIdentifier: "com.apple.voice.compact.en-US.Samantha",
      },
    ]);
  });

  it("keeps unset voice and language out of the native request", async () => {
    const native = new FakeOutput();
    const port = createSystemSpeechOutput(native);
    const speaking = port.speak("Hello", { rate: 1 });
    native.settle({ ok: true, value: null });
    await speaking;
    expect("language" in (native.requests[0] ?? {})).toBe(false);
    expect("voiceIdentifier" in (native.requests[0] ?? {})).toBe(false);
    expect(native.requests[0]?.pitch).toBe(1);
  });

  it("treats blank text as a silent success without a native call", async () => {
    const native = new FakeOutput();
    const port = createSystemSpeechOutput(native);
    await expect(port.speak("   ", { rate: 1 })).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(native.speakCalls).toBe(0);
  });

  it("reports a busy synthesizer as a recoverable busy failure", async () => {
    const native = new FakeOutput();
    const port = createSystemSpeechOutput(native);
    const first = port.speak("One", { rate: 1 });
    const second = await port.speak("Two", { rate: 1 });
    expect(second).toMatchObject({
      ok: false,
      error: { code: "busy", recoverable: true },
    });
    native.settle({ ok: true, value: null });
    await expect(first).resolves.toEqual({ ok: true, value: undefined });
    // The facade forwards both entries; the native busy guard rejects the
    // second before it ever reaches the synthesizer.
    expect(native.speakCalls).toBe(2);
  });

  it("maps an interrupted utterance to a canceled failure", async () => {
    const native = new FakeOutput();
    const port = createSystemSpeechOutput(native);
    const speaking = port.speak("Hello", { rate: 1 });
    native.settle({
      ok: false,
      error: { code: "CANCELED", message: "System playback was interrupted." },
    });
    await expect(speaking).resolves.toMatchObject({
      ok: false,
      error: { code: "canceled" },
    });
  });

  it("stops on abort and resolves the caller as canceled", async () => {
    const native = new FakeOutput();
    const port = createSystemSpeechOutput(native);
    const controller = new AbortController();
    const speaking = port.speak("Long answer", {
      rate: 1,
      signal: controller.signal,
    });
    expect(port.isSpeaking()).toBe(true);
    controller.abort();
    await expect(speaking).resolves.toMatchObject({
      ok: false,
      error: { code: "canceled" },
    });
    expect(native.stopCalls).toBe(1);
    expect(port.isSpeaking()).toBe(false);
  });

  it("refuses playback on an already aborted signal", async () => {
    const native = new FakeOutput();
    const port = createSystemSpeechOutput(native);
    const controller = new AbortController();
    controller.abort();
    await expect(
      port.speak("Hello", { rate: 1, signal: controller.signal }),
    ).resolves.toMatchObject({ ok: false, error: { code: "canceled" } });
    expect(native.speakCalls).toBe(0);
  });

  it("turns a native rejection into a recoverable failure", async () => {
    const native = new FakeOutput();
    native.rejectSpeak = new Error("synthesizer exploded");
    const port = createSystemSpeechOutput(native);
    await expect(port.speak("Hello", { rate: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "failed", message: "synthesizer exploded" },
    });
  });

  it("stops idempotently while nothing plays", async () => {
    const native = new FakeOutput();
    const port = createSystemSpeechOutput(native);
    await expect(port.stop()).resolves.toEqual({ ok: true, value: undefined });
    await expect(port.stop()).resolves.toEqual({ ok: true, value: undefined });
    expect(native.stopCalls).toBe(2);
  });

  it("disposes once, stopping playback and refusing later speech", async () => {
    const native = new FakeOutput();
    const port = createSystemSpeechOutput(native);
    const speaking = port.speak("Hello", { rate: 1 });
    await port.dispose?.();
    await expect(speaking).resolves.toEqual({ ok: true, value: undefined });
    await expect(port.speak("Again", { rate: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(native.speakCalls).toBe(1);
  });
});
