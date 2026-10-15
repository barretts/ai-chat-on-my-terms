import type {
  AudioResult,
  SpeakOptions,
  SpeechOutputPort,
} from "@locallab/audio-session";
import type { GroupParticipantDraft } from "@locallab/groups-config";

/** One attributed utterance in a group transcript (GR-01, GR-13). */
export interface GroupTranscriptEntry {
  id: string;
  /** Seat index into the room's participants; the user speaks index -1. */
  speakerSeat: number;
  speakerName: string;
  accentColor: string;
  text: string;
}

/** Independent per-participant playback status (parallel failures). */
export type GroupSpeakStatus =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "speaking" }
  | { kind: "failed"; message: string };

export interface GroupSpeakIntent {
  entryId: string;
  seatIndex: number;
  speakerName: string;
  text: string;
  options: SpeakOptions;
}

/**
 * Ordered playback intents for every reply in the transcript (GR-13).
 * Seat voice bindings stay per-participant: each intent carries its own
 * voice identity (VO-13), never one global voice.
 */
export function groupSpeakQueue(
  participants: readonly GroupParticipantDraft[],
  entries: readonly GroupTranscriptEntry[],
): GroupSpeakIntent[] {
  return entries
    .filter((entry) => entry.speakerSeat >= 0)
    .map((entry) => ({
      entryId: entry.id,
      seatIndex: entry.speakerSeat,
      speakerName: entry.speakerName,
      text: entry.text,
      options: speakOptionsForSeat(
        participants[entry.speakerSeat]?.voice ?? null,
      ),
    }));
}

export function speakOptionsForSeat(
  voice: Readonly<Record<string, unknown>> | null,
): SpeakOptions {
  if (!voice) return {};
  const voiceId = voice.speechVoiceId ?? voice.voiceId;
  const rate = voice.speechRate ?? voice.rate;
  return {
    ...(typeof voiceId === "string" && voiceId.trim() !== ""
      ? { voiceId }
      : {}),
    ...(typeof rate === "number" && Number.isFinite(rate) ? { rate } : {}),
  };
}

/**
 * Play every queued reply in textual order, each seat's status independent:
 * one failing voice never cancels later replies and never marks other seats
 * (parallel status/failures displayed independently).
 */
export async function playGroupSpeakQueue(
  speech: SpeechOutputPort,
  queue: readonly GroupSpeakIntent[],
  onStatus: (seatIndex: number, status: GroupSpeakStatus) => void,
): Promise<void> {
  for (const intent of queue) {
    onStatus(intent.seatIndex, { kind: "speaking" });
    let result: AudioResult<void>;
    try {
      result = await speech.speak(intent.text, intent.options);
    } catch (cause) {
      onStatus(
        intent.seatIndex,
        {
          kind: "failed",
          message: `${intent.speakerName}: ${
            cause instanceof Error ? cause.message : String(cause)
          }. Other replies continue.`,
        },
      );
      continue;
    }
    if (result.ok) onStatus(intent.seatIndex, { kind: "idle" });
    else
      onStatus(
        intent.seatIndex,
        {
          kind: "failed",
          message: `${intent.speakerName}: ${result.error.message}. Other replies continue.`,
        },
      );
  }
}

/** Toggle a seat's tools without touching any global tool settings. */
export function seatWithTools(
  participants: readonly GroupParticipantDraft[],
  seatIndex: number,
  enabled: boolean,
): GroupParticipantDraft[] {
  return participants.map((seat, index) =>
    index === seatIndex ? { ...seat, toolsEnabled: enabled } : seat,
  );
}
