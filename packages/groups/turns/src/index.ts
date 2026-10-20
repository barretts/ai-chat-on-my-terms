import type {
  GroupParticipantDraft,
  GroupRoomDraft,
} from "@locallab/groups-config";

/** How the frozen seat order for one round is chosen (GR-13). */
export type GroupSpeakerOrder = "round-robin" | "dice" | "topic-interest";

export const GROUP_AUTONOMOUS_ROUND_CAP = 5;

export type GroupTurnMode = "round-robin" | "autonomous" | "manual";

/** How much of the round a later speaker sees (GR-12). */
export type GroupContextMode = "discussion" | "independent";

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
  contextMode: GroupContextMode;
  speakers: readonly GroupTurnSpeaker[];
  rounds: number;
  replyToUserOnly: boolean;
}

export interface GroupTurnRequest {
  /** Absent for a Pass: no user message is inserted and seats continue. */
  userText?: string;
  contextMode?: GroupContextMode;
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
      const mentions = mentionedSeatIndices(request.userText ?? "", seats);
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
    contextMode: request.contextMode ?? "discussion",
    scenario: room.scenario,
    speakers: frozen,
    rounds,
    replyToUserOnly,
  };
}

/**
 * Frozen seat permutation for one round; indices are seating turn_order
 * slots. Round-robin rotates the start after each completed round.
 */
export function roundRobinOrder(count: number, cursor: number): number[] {
  if (count < 1) {
    throw new GroupTurnError("Seat order needs at least one seat.");
  }
  const start = ((cursor % count) + count) % count;
  return Array.from({ length: count }, (_, index) => (index + start) % count);
}

/** Deterministic PRNG so a saved seed replays a dice round exactly. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded Fisher-Yates over seat indices; store the seed with the round. */
export function diceOrder(count: number, seed: number): number[] {
  if (count < 1) {
    throw new GroupTurnError("Seat order needs at least one seat.");
  }
  const order = Array.from({ length: count }, (_, index) => index);
  const random = mulberry32(seed);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap]!, order[index]!];
  }
  return order;
}

/** Seat descriptor handed to the topic-interest selector model. */
export interface GroupSelectorSeat {
  id: string;
  displayName: string;
  scenario: string;
}

export interface GroupSelectorPort {
  /** One json_object request; the raw reply text is validated by the caller. */
  generateSelector(input: {
    prompt: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

/** Exact prompt for the single topic-interest call (replayable in T179). */
export function topicInterestPrompt(
  seats: readonly GroupSelectorSeat[],
  userText: string,
): string {
  const lines = seats.map(
    (seat) =>
      `- seat id ${seat.id}: ${seat.displayName}${
        seat.scenario.trim() === ""
          ? ""
          : ` — scenario: ${seat.scenario.trim()}`
      }`,
  );
  return [
    "You are the speaker selector for a group chat.",
    "Score which participant should answer the user's latest message.",
    "Participants:",
    ...lines,
    `User's latest message: ${userText}`,
    'Reply with ONLY this JSON object: {"scores":[{"seat":"<seat id>","score":<number>},...]}',
    "Every seat id must appear exactly once and score must be a finite number.",
  ].join("\n");
}

/**
 * Strict validation: every seat exactly once, numeric finite scores. Any
 * invalidity — invented seat, duplicate, omission, unparseable — returns
 * null so the caller uses the seating order. One call per round, never
 * retried.
 * Future: let participants abstain via a score floor instead of always speaking.
 */
export function parseTopicInterestOrder(
  reply: string,
  seatIds: readonly string[],
): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("scores" in parsed))
    return null;
  const rawScores = parsed.scores;
  if (!Array.isArray(rawScores)) return null;
  const scores: readonly unknown[] = rawScores;
  const indexById = new Map(seatIds.map((id, index) => [id, index]));
  const scored: { seatIndex: number; score: number }[] = [];
  const seen = new Set<number>();
  for (const entry of scores) {
    if (typeof entry !== "object" || entry === null) return null;
    if (!("seat" in entry) || !("score" in entry)) return null;
    const seat = entry.seat;
    const score = entry.score;
    if (typeof seat !== "string") return null;
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    const seatIndex = indexById.get(seat);
    if (seatIndex === undefined || seen.has(seatIndex)) return null;
    seen.add(seatIndex);
    scored.push({ seatIndex, score });
  }
  if (scored.length !== seatIds.length) return null;
  return scored
    .sort((a, b) => b.score - a.score || a.seatIndex - b.seatIndex)
    .map((item) => item.seatIndex);
}

/**
 * One topic-interest selector call; any invalidity falls back to seating
 * order with no retry — a misbehaving model must not multiply tokens.
 */
export async function planTopicInterestOrder(
  seats: readonly GroupSelectorSeat[],
  userText: string,
  port: GroupSelectorPort,
  signal?: AbortSignal,
): Promise<number[]> {
  const seating = seats.map((_, index) => index);
  try {
    const reply = await port.generateSelector({
      prompt: topicInterestPrompt(seats, userText),
      ...(signal ? { signal } : {}),
    });
    return (
      parseTopicInterestOrder(
        reply,
        seats.map((seat) => seat.id),
      ) ?? seating
    );
  } catch {
    return seating;
  }
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
 * transcript. A missing userText is a Pass: seats continue without a user
 * message. Discussion mode lets later speakers see earlier completed
 * replies; independent mode hands every speaker the same frozen starting
 * transcript (`priorTranscript`), never this round's fresh replies.
 */
export async function runGroupUserTurn(
  plan: GroupTurnPlan,
  port: GroupTurnPort,
  userText?: string,
  signal?: AbortSignal,
  priorTranscript: readonly GroupTurnEntry[] = [],
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
          ? (userText ??
            "The user passed without adding a message; continue the conversation as your participant.")
          : "Continue the group conversation as your participant.";
      const text = await port.generate({
        speaker,
        instruction:
          scenarioNote === ""
            ? base
            : `Room scenario: ${scenarioNote}\n\n${base}`,
        transcript:
          plan.contextMode === "independent"
            ? priorTranscript
            : [...priorTranscript, ...entries],
        ...(signal ? { signal } : {}),
      });
      entries.push({ round, speaker, text });
    }
  }
  return entries;
}
