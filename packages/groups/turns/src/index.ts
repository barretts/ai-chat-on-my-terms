import type {
  GroupParticipantDraft,
  GroupRoomDraft,
} from "@locallab/groups-config";

export const GROUP_AUTONOMOUS_ROUND_CAP = 5;

export type GroupTurnMode = "round-robin" | "autonomous" | "manual";

export class GroupTurnError extends Error {}

/** A frozen speaker slot: seat identity is captured at planning time. */
export interface GroupTurnSpeaker {
  seatIndex: number;
  displayName: string;
  accentColor: string;
  systemPrompt: string;
  personaId: string | null;
  providerConnectionId: string | null;
  modelId: string | null;
}

/** Immutable plan for one user turn; execution never re-decides speakers. */
export interface GroupTurnPlan {
  scenario: string;
  mode: GroupTurnMode;
  speakers: readonly GroupTurnSpeaker[];
  rounds: number;
  replyToUserOnly: boolean;
}

export interface GroupTurnRequest {
  userText: string;
  mode: GroupTurnMode;
  /** Ask-chip seat for manual mode (GR-07). */
  askSeatIndex?: number | null;
  replyToUserOnly?: boolean;
  /** Requested autonomous rounds; capped to GROUP_AUTONOMOUS_ROUND_CAP. */
  autonomousRounds?: number;
}

/** "@Name" mentions resolved against seat display names, case-insensitive. */
export function mentionedSeatIndices(
  userText: string,
  seats: readonly GroupParticipantDraft[],
): number[] {
  const hits: number[] = [];
  seats.forEach((seat, seatIndex) => {
    const name = seat.displayName.trim();
    if (name === "") return;
    const handle = `@${name.toLocaleLowerCase()}`;
    if (userText.toLocaleLowerCase().includes(handle)) hits.push(seatIndex);
  });
  return hits;
}

/**
 * Freeze the eligible speaker set for one user turn (GR-05, GR-06, GR-07,
 * GR-08). Round-robin keeps seating order; autonomous mode follows
 * @mentions when present, otherwise every seat, capped at five rounds;
 * manual mode runs only the seat chosen by an Ask chip.
 */
export function planGroupUserTurn(
  room: GroupRoomDraft,
  request: GroupTurnRequest,
): GroupTurnPlan {
  const seats = room.participants;
  if (seats.length === 0) {
    throw new GroupTurnError(
      "This group has no participants; add a participant first.",
    );
  }
  const replyToUserOnly = request.replyToUserOnly ?? false;
  let speakers: readonly GroupParticipantDraft[];
  let rounds: number;
  switch (request.mode) {
    case "round-robin":
      speakers = seats;
      rounds = 1;
      break;
    case "autonomous": {
      const mentions = mentionedSeatIndices(request.userText, seats);
      speakers = mentions.length
        ? mentions.map((seatIndex) => seats[seatIndex]!)
        : seats;
      rounds = replyToUserOnly
        ? 1
        : Math.min(
            request.autonomousRounds ?? GROUP_AUTONOMOUS_ROUND_CAP,
            GROUP_AUTONOMOUS_ROUND_CAP,
          );
      if (rounds < 1) {
        throw new GroupTurnError("Autonomous rounds must be at least one.");
      }
      break;
    }
    case "manual": {
      const askSeatIndex = request.askSeatIndex ?? null;
      if (askSeatIndex === null || !seats[askSeatIndex]) {
        throw new GroupTurnError(
          "Manual mode needs one participant selected through an Ask chip; nobody else speaks.",
        );
      }
      speakers = [seats[askSeatIndex]];
      rounds = 1;
      break;
    }
  }
  const frozen: GroupTurnSpeaker[] = speakers.map((seat) => ({
    seatIndex: seats.indexOf(seat),
    displayName: seat.displayName,
    accentColor: seat.accentColor,
    systemPrompt: seat.systemPrompt,
    personaId: seat.personaId,
    providerConnectionId: seat.providerConnectionId,
    modelId: seat.modelId,
  }));
  return {
    mode: request.mode,
    scenario: room.scenario,
    speakers: frozen,
    rounds,
    replyToUserOnly,
  };
}

/** One generated participant reply attributed to its frozen speaker. */
export interface GroupTurnEntry {
  round: number;
  speaker: GroupTurnSpeaker;
  text: string;
}

export interface GroupTurnPort {
  generate(input: {
    speaker: GroupTurnSpeaker;
    instruction: string;
    transcript: readonly GroupTurnEntry[];
    signal?: AbortSignal;
  }): Promise<string>;
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * Run one planned user turn: speakers stay in plan order, identity comes
 * only from the frozen plan, and aborting the signal terminates the whole
 * user turn — later seats never start. Entries already produced stay in the
 * transcript.
 */
export async function runGroupUserTurn(
  plan: GroupTurnPlan,
  port: GroupTurnPort,
  userText: string,
  signal?: AbortSignal,
): Promise<GroupTurnEntry[]> {
  const entries: GroupTurnEntry[] = [];
  for (let round = 1; round <= plan.rounds; round += 1) {
    for (const speaker of plan.speakers) {
      if (aborted(signal)) return entries;
      // Round > 1 is participant-to-participant follow-on; the user-only
      // option (GR-08) forbids it, so the turn ends after replying to the
      // user once.
      if (round > 1 && plan.replyToUserOnly) return entries;
      const scenarioNote = plan.scenario.trim();
      const base =
        round === 1
          ? userText
          : "Continue the group conversation as your participant.";
      const text = await port.generate({
        speaker,
        instruction:
          scenarioNote === ""
            ? base
            : `Room scenario: ${scenarioNote}\n\n${base}`,
        transcript: entries,
        ...(signal ? { signal } : {}),
      });
      entries.push({ round, speaker, text });
    }
  }
  return entries;
}
