/**
 * T180 dev-only benchmark matrix (pure; runs on web tests and on device).
 * Builds the T179 row-3 scenario grid for the in-app runner: installed GGUFs
 * x {2,3,5}-persona rooms x {round-robin, dice, topic-interest}.
 */

export interface BenchPersonaSpec {
  key: string;
  name: string;
  prompt: string;
}

/** Fixed seats so personality-consistency and repetition notes stay comparable. */
export const BENCH_PERSONAS: readonly BenchPersonaSpec[] = [
  {
    key: "pirate",
    name: "Bench Pirate",
    prompt:
      "You are Captain Marrow, a pirate. Answer only with nautical metaphors and never break character.",
  },
  {
    key: "poet",
    name: "Bench Poet",
    prompt:
      "You are Mira, a poet. Answer in exactly two rhyming couplets and nothing else.",
  },
  {
    key: "engineer",
    name: "Bench Engineer",
    prompt:
      "You are Dana, a meticulous engineer. Answer with numbered steps and name one tradeoff.",
  },
  {
    key: "skeptic",
    name: "Bench Skeptic",
    prompt:
      "You are Vic, a skeptic. Challenge one assumption from the previous speaker, then add your own point.",
  },
  {
    key: "chef",
    name: "Bench Chef",
    prompt:
      "You are Sal, a chef. Relate every answer to cooking and keep replies under 60 words.",
  },
];

/** Identical kickoff text for every scenario's first Send round. */
export const BENCH_KICKOFF =
  "We are planning a one-night backyard campout for two kids. Give your single best idea for the trip and one thing you would worry about.";

export type BenchPolicy = "round-robin" | "dice" | "topic-interest";

export const BENCH_POLICIES: readonly BenchPolicy[] = [
  "round-robin",
  "dice",
  "topic-interest",
];

export const BENCH_SEAT_COUNTS: readonly number[] = [2, 3, 5];

export interface BenchPlan {
  index: number;
  modelId: string;
  seats: number;
  policy: BenchPolicy;
  /** Deterministic seed so dice scenarios replay; 0 when unused. */
  diceSeed: number;
  personaKeys: string[];
}

/** Stable grid order: model, then seat count, then policy. */
export function buildBenchMatrix(modelIds: readonly string[]): BenchPlan[] {
  const plans: BenchPlan[] = [];
  let index = 0;
  for (const modelId of modelIds) {
    for (const seats of BENCH_SEAT_COUNTS) {
      for (const policy of BENCH_POLICIES) {
        const diceSeed = policy === "dice" ? 1000 + index : 0;
        plans.push({
          index,
          modelId,
          seats,
          policy,
          diceSeed,
          personaKeys: BENCH_PERSONAS.slice(0, seats).map((p) => p.key),
        });
        index += 1;
      }
    }
  }
  return plans;
}

/* ---------------------------------- manifest --------------------------------- */

export interface BenchReplyRecord {
  seatIndex: number;
  personaKey: string | null;
  displayName: string;
  replyMessageId: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensPerSec: number | null;
  finishReason: string | null;
  text: string;
}

export interface BenchRoundRecord {
  trigger: "send" | "pass" | "ask";
  status: "completed" | "stopped" | "failed";
  frozenOrder: number[];
  durationMs: number;
  replies: BenchReplyRecord[];
}

export interface BenchRunRecord {
  /** Raw port-level observation; selector (json) runs are kept for audit. */
  runId: string;
  messageId: string;
  modelId: string;
  jsonSelector: boolean;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
  canceled: boolean;
}

export interface BenchScenarioRecord {
  modelId: string;
  seats: number;
  policy: BenchPolicy;
  diceSeed: number;
  roomId: string;
  conversationId: string;
  thermalBefore: string;
  thermalAfter: string;
  rounds: BenchRoundRecord[];
  selectorRuns: BenchRunRecord[];
}

export interface BenchManifest {
  version: 1;
  generatedAt: string;
  device: string;
  iosVersion: string;
  appVersion: string;
  buildNumber: string;
  roundsPerScenario: number;
  responseLimitTokens: number;
  deviceMemoryBytes: number | null;
  scenarios: BenchScenarioRecord[];
  notes: string[];
}

export function assembleManifest(input: {
  generatedAt: string;
  device: string;
  iosVersion: string;
  appVersion: string;
  buildNumber: string;
  roundsPerScenario: number;
  responseLimitTokens: number;
  deviceMemoryBytes: number | null;
  scenarios: BenchScenarioRecord[];
  notes?: string[];
}): BenchManifest {
  return {
    version: 1,
    ...input,
    notes: input.notes ?? [
      "Latencies are wall-clock per run at the provider port.",
      "Peak RSS is not observable from the app; thermal state and device memory are recorded instead.",
    ],
  };
}

export function tokensPerSec(
  outputTokens: number | null,
  durationMs: number,
): number | null {
  if (outputTokens === null || durationMs <= 0) return null;
  return Math.round((outputTokens / (durationMs / 1000)) * 100) / 100;
}
