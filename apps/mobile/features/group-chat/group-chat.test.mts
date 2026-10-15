import { describe, expect, it } from "vitest";
import {
  audioFailure,
  type SpeakOptions,
  type SpeechOutputPort,
} from "@locallab/audio-session";
import type { GroupParticipantDraft } from "@locallab/groups-config";
import {
  groupSpeakQueue,
  playGroupSpeakQueue,
  seatWithTools,
  type GroupSpeakStatus,
  type GroupTranscriptEntry,
} from ".";

const seat = (
  displayName: string,
  voice: Record<string, unknown> | null,
  toolsEnabled: boolean,
): GroupParticipantDraft => ({
  personaId: null,
  providerConnectionId: "0195c000-0000-7000-8000-0000000000d2",
  modelId: "llama",
  displayName,
  accentColor: "#ff0000",
  systemPrompt: "",
  voice,
  toolsEnabled,
});

const participants = [
  seat("Ada", { speechVoiceId: "voice-ada", speechRate: 1.2 }, false),
  seat("Grace", { speechVoiceId: "voice-grace" }, true),
];

const entry = (
  id: string,
  speakerSeat: number,
  speakerName: string,
  text: string,
): GroupTranscriptEntry => ({
  id,
  speakerSeat,
  speakerName,
  accentColor: "#ff0000",
  text,
});

function fakeSpeech(failOnTexts: readonly string[]): {
  port: SpeechOutputPort;
  spoken: { text: string; options: SpeakOptions }[];
} {
  const spoken: { text: string; options: SpeakOptions }[] = [];
  return {
    spoken,
    port: {
      getAvailability: async () =>
        audioFailure("unavailable", "fake", true),
      isSpeaking: () => false,
      speak: async (text, options) => {
        spoken.push({ text, options });
        return failOnTexts.includes(text)
          ? audioFailure("failed", "voice engine offline", true)
          : { ok: true as const, value: undefined };
      },
      stop: async () => ({ ok: true as const, value: undefined }),
    },
  };
}

describe("group speech queue", () => {
  it("plays replies in transcript order with each seat's own voice", async () => {
    const queue = groupSpeakQueue(participants, [
      entry("e1", 0, "Ada", "first"),
      entry("e2", -1, "Me", "user reply skipped"),
      entry("e3", 1, "Grace", "second"),
      entry("e4", 0, "Ada", "third"),
    ]);
    const fake = fakeSpeech([]);
    const statuses: [number, GroupSpeakStatus][] = [];
    await playGroupSpeakQueue(fake.port, queue, (seatIndex, status) =>
      statuses.push([seatIndex, status]),
    );
    expect(fake.spoken.map((call) => call.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(fake.spoken[0]?.options).toEqual({
      voiceId: "voice-ada",
      rate: 1.2,
    });
    expect(fake.spoken[1]?.options).toEqual({ voiceId: "voice-grace" });
    expect(fake.spoken[2]?.options).toEqual({
      voiceId: "voice-ada",
      rate: 1.2,
    });
    expect(statuses.filter(([, s]) => s.kind === "failed")).toEqual([]);
    expect(statuses.at(-1)).toEqual([0, { kind: "idle" }]);
  });

  it("one seat's voice failure marks only that seat and later replies continue", async () => {
    const queue = groupSpeakQueue(participants, [
      entry("e1", 0, "Ada", "fine"),
      entry("e2", 1, "Grace", "broken"),
      entry("e3", 0, "Ada", "still fine"),
    ]);
    const fake = fakeSpeech(["broken"]);
    const statuses = new Map<number, GroupSpeakStatus>();
    await playGroupSpeakQueue(fake.port, queue, (seatIndex, status) =>
      statuses.set(seatIndex, status),
    );
    expect(fake.spoken.map((call) => call.text)).toEqual([
      "fine",
      "broken",
      "still fine",
    ]);
    expect(statuses.get(1)).toEqual({
      kind: "failed",
      message: "Grace: voice engine offline. Other replies continue.",
    });
    expect(statuses.get(0)).toEqual({ kind: "idle" });
  });

  it("toggling one participant's tools leaves every other seat untouched", () => {
    const next = seatWithTools(participants, 1, false);
    expect(next[1]?.toolsEnabled).toBe(false);
    expect(next[0]).toEqual(participants[0]);
    expect(participants[1]?.toolsEnabled).toBe(true);
  });
});
