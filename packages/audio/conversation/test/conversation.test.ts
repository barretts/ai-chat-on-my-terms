import assert from "node:assert/strict";
import test from "node:test";
import {
  audioFailure,
  type AudioResult,
  type ListenOptions,
  type SpeechInputPort,
  type SpeechOutputPort,
} from "@locallab/audio-session";
import {
  ConversationVoiceSession,
  type ConversationVoiceEvent,
} from "../src/index.js";

function fakePorts(options: {
  capture?: AudioResult<string>;
  playbackFails?: string;
} = {}) {
  const spoken: { text: string; voiceId?: string }[] = [];
  let stopped = 0;
  let listened = 0;
  let resolveSpeak: (() => void) | null = null;
  const output: SpeechOutputPort = {
    getAvailability: async () => audioFailure("unavailable", "fake", true),
    isSpeaking: () => false,
    speak: (text, speakOptions) => {
      const { promise, resolve } =
        Promise.withResolvers<AudioResult<void>>();
      resolveSpeak = () => {
        if (options.playbackFails)
          resolve(audioFailure("failed", options.playbackFails, true));
        else resolve({ ok: true, value: undefined });
      };
      spoken.push({
        text,
        ...(speakOptions.voiceId ? { voiceId: speakOptions.voiceId } : {}),
      });
      speakOptions.signal?.addEventListener("abort", resolveSpeak);
      setTimeout(resolveSpeak, 5);
      return promise;
    },
    stop: async () => {
      stopped += 1;
      resolveSpeak?.();
      return { ok: true, value: undefined };
    },
  };
  const input: SpeechInputPort = {
    getAvailability: async () => audioFailure("unavailable", "fake", true),
    getLocales: async () => ({ ok: true, value: [] }),
    listen: async (_listenOptions: ListenOptions) => {
      listened += 1;
      return options.capture ?? { ok: true, value: "next question" };
    },
  };
  return {
    input,
    output,
    counts: () => ({ spokenCount: spoken.length, stopped, listened }),
    spoken: () => spoken,
  };
}

test("cycle speaks ordered replies with each voice then listens once", async () => {
  const ports = fakePorts();
  const events: ConversationVoiceEvent[] = [];
  const sent: string[] = [];
  const session = new ConversationVoiceSession({
    input: ports.input,
    output: ports.output,
    onUserText: (text) => sent.push(text),
    onEvent: (event) => events.push(event),
  });
  const transcript = await session.runCycle([
    { speakerName: "Ada", text: "hello", voiceId: "voice-ada" },
    { speakerName: "Grace", text: "hi there", voiceId: "voice-grace" },
  ]);
  assert.equal(transcript, "next question");
  assert.deepEqual(ports.spoken(), [
    { text: "hello", voiceId: "voice-ada" },
    { text: "hi there", voiceId: "voice-grace" },
  ]);
  assert.equal(ports.counts().listened, 1);
  assert.deepEqual(sent, ["next question"]);
  assert.deepEqual(
    events.map((event) => event.phase),
    ["speaking", "speaking", "listening", "sending", "idle"],
  );
  assert.equal(session.currentPhase(), "idle");
  assert.equal(session.isRunning(), false);
});

test("cancel stops playback and never starts capture", async () => {
  const ports = fakePorts();
  const session = new ConversationVoiceSession({
    input: ports.input,
    output: ports.output,
    onUserText: () => assert.fail("must not send after cancel"),
  });
  const cycle = session.runCycle([
    { speakerName: "Ada", text: "long reply", voiceId: "v" },
    { speakerName: "Grace", text: "never played" },
  ]);
  const { promise: settle, resolve: settleNow } =
    Promise.withResolvers<void>();
  setTimeout(settleNow, 10);
  await settle;
  assert.equal(session.currentPhase(), "speaking");
  await session.cancel();
  const transcript = await cycle;
  assert.equal(transcript, null);
  assert.equal(ports.counts().listened, 0, "no capture after cancel");
  assert.equal(session.currentPhase(), "idle");
});

test("capture failure is honest and does not send or crash the session", async () => {
  const ports = fakePorts({
    capture: audioFailure("permission", "microphone denied", true),
  });
  const events: ConversationVoiceEvent[] = [];
  const session = new ConversationVoiceSession({
    input: ports.input,
    output: ports.output,
    onUserText: () => assert.fail("must not send after failed capture"),
    onEvent: (event) => events.push(event),
  });
  const transcript = await session.runCycle([
    { speakerName: "Ada", text: "question" },
  ]);
  assert.equal(transcript, null);
  assert.equal(
    events.at(-1)?.detail,
    "capture failed: microphone denied",
  );
  assert.equal(session.currentPhase(), "idle");
  // The session stays usable after an honest failure.
  assert.equal(session.isRunning(), false);
});

test("two cycles cannot overlap", async () => {
  const ports = fakePorts();
  const session = new ConversationVoiceSession({
    input: ports.input,
    output: ports.output,
    onUserText: () => {},
  });
  const first = session.runCycle([{ speakerName: "Ada", text: "hello" }]);
  assert.equal(session.isRunning(), true);
  await assert.rejects(
    session.runCycle([{ speakerName: "Grace", text: "clash" }]),
    /already running/,
  );
  await session.cancel();
  await first;
});
