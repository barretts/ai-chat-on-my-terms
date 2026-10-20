import type { ChatBinding } from "@locallab/chat-engine-core";
import type { GroupRoomDraft } from "@locallab/groups-config";
import type {
  GroupTurnOptions,
  GroupTurnResult,
} from "../../composition/chat/group-driver";
import type { GroupTranscriptEntry } from "../group-chat";
import {
  BENCH_KICKOFF,
  type BenchManifest,
  type BenchPlan,
  type BenchPolicy,
  type BenchReplyRecord,
  type BenchRoundRecord,
  type BenchRunRecord,
  type BenchScenarioRecord,
  tokensPerSec,
} from "./matrix";

/**
 * T180 dev-only benchmark core: pure orchestration over injected ports so the
 * matrix logic runs in web tests, while the mobile runner supplies the REAL
 * group runtime (driver, engine, leases, GGUF port). Web results here are
 * never device proof; the manifest is handed to T179 row 3.
 */

/** One live scenario: a saved room plus the real (or faked) round entry. */
export interface BenchScenarioHandle {
  room: GroupRoomDraft;
  binding: ChatBinding;
  /** Port-level observations; the recording port appends as runs finish. */
  readonly records: BenchRunRecord[];
  startTurn(options: GroupTurnOptions): Promise<GroupTurnResult>;
  stop(reason?: string): Promise<void>;
  /** Release the model runtime AND delete this bench room's rows. */
  dispose(): Promise<void>;
}

export interface BenchPorts {
  personaKeyFor(personaId: string | null): string | null;
  openScenario(
    plan: BenchPlan,
    options: { responseLimitTokens: number },
  ): Promise<BenchScenarioHandle>;
  probe(): Promise<{ thermal: string; memoryBytes: number | null }>;
  now(): number;
}

export interface BenchRunOptions {
  plans: readonly BenchPlan[];
  roundsPerScenario: number;
  responseLimitTokens: number;
  signal: AbortSignal;
  onProgress(done: number, total: number, label: string): void;
  onScenarioDone(scenario: BenchScenarioRecord): void;
}

export interface BenchRunOutcome {
  scenarios: BenchScenarioRecord[];
  stopped: boolean;
}

export function scenarioLabel(plan: BenchPlan): string {
  return `${plan.modelId.replace(/^blob:/, "").slice(0, 8)} x ${plan.seats} seats ${plan.policy}`;
}

/** Round's reply rows paired with their port records (keyed by message id). */
export function collectReplies(
  result: Pick<GroupTurnResult, "entries">,
  records: readonly BenchRunRecord[],
  personaKeyFor: (personaId: string | null) => string | null,
  room: GroupRoomDraft,
): BenchReplyRecord[] {
  const byMessage = new Map(
    records.map((record) => [record.messageId, record]),
  );
  const replies: BenchReplyRecord[] = [];
  for (const entry of result.entries) {
    if (entry.speakerSeat < 0) continue; // user rows are not seat replies
    const record = byMessage.get(entry.id);
    const seat = room.participants[entry.speakerSeat];
    const durationMs = record?.durationMs ?? 0;
    replies.push({
      seatIndex: entry.speakerSeat,
      personaKey: personaKeyFor(seat?.personaId ?? null),
      displayName: entry.speakerName,
      replyMessageId: entry.id,
      durationMs,
      inputTokens: record?.inputTokens ?? null,
      outputTokens: record?.outputTokens ?? null,
      tokensPerSec: tokensPerSec(record?.outputTokens ?? null, durationMs),
      finishReason: record?.finishReason ?? null,
      text: entry.text,
    });
  }
  return replies;
}

export async function runBenchMatrix(
  ports: BenchPorts,
  options: BenchRunOptions,
): Promise<BenchRunOutcome> {
  const scenarios: BenchScenarioRecord[] = [];
  let stopped = false;
  for (const plan of options.plans) {
    if (options.signal.aborted) {
      stopped = true;
      break;
    }
    options.onProgress(
      scenarios.length,
      options.plans.length,
      scenarioLabel(plan),
    );
    const handle = await ports.openScenario(plan, {
      responseLimitTokens: options.responseLimitTokens,
    });
    const before = await ports.probe();
    const rounds: BenchRoundRecord[] = [];
    const selectorRuns: BenchRunRecord[] = [];
    const history: GroupTranscriptEntry[] = [];
    try {
      for (let round = 0; round < options.roundsPerScenario; round += 1) {
        if (options.signal.aborted) {
          stopped = true;
          break;
        }
        const trigger: "send" | "pass" = round === 0 ? "send" : "pass";
        const recordsBase = handle.records.length;
        const roundStart = ports.now();
        const result = await handle.startTurn({
          room: handle.room,
          trigger,
          ...(trigger === "send" ? { userText: BENCH_KICKOFF } : {}),
          history,
          signal: options.signal,
          binding: handle.binding,
          // Dev bench seats carry their prompt in systemPrompt; no Drunk.
          seatInstruction: (seat) => seat.systemPrompt.trim(),
          presenter: {
            onStatus: () => {},
            onEntry: (entry) => {
              history.push(entry);
            },
          },
          ...(plan.policy === "dice" ? { seed: plan.diceSeed } : {}),
        });
        const roundDurationMs = ports.now() - roundStart;
        const roundRecords = handle.records.slice(recordsBase);
        selectorRuns.push(...roundRecords.filter((r) => r.jsonSelector));
        rounds.push({
          trigger,
          status: result.status,
          frozenOrder: [...result.round.frozenOrder],
          durationMs: roundDurationMs,
          replies: collectReplies(
            result,
            roundRecords,
            (personaId) => ports.personaKeyFor(personaId),
            handle.room,
          ),
        });
        if (result.status !== "completed") {
          stopped = true;
          break;
        }
      }
    } catch (error) {
      // A scenario failure is recorded, never silent: empty rounds stay.
      rounds.push({
        trigger: "send",
        status: "failed",
        frozenOrder: [],
        durationMs: 0,
        replies: [
          {
            seatIndex: -1,
            personaKey: null,
            displayName: "runner",
            replyMessageId: "",
            durationMs: 0,
            inputTokens: null,
            outputTokens: null,
            tokensPerSec: null,
            finishReason:
              error instanceof Error ? error.message : "scenario error",
            text: "",
          },
        ],
      });
      stopped = true;
    } finally {
      const after = await ports.probe();
      await handle.dispose();
      const scenarioRecord: BenchScenarioRecord = {
        modelId: plan.modelId,
        seats: plan.seats,
        policy: plan.policy,
        diceSeed: plan.diceSeed,
        roomId: handle.room.id ?? "",
        conversationId: handle.room.conversationId,
        thermalBefore: before.thermal,
        thermalAfter: after.thermal,
        rounds,
        selectorRuns,
      };
      scenarios.push(scenarioRecord);
      options.onScenarioDone(scenarioRecord);
    }
    if (stopped) break;
  }
  return { scenarios, stopped };
}

/** Serialize for the file/clipboard manifest consumed by T179 row 3. */
export function manifestJson(manifest: BenchManifest): string {
  return JSON.stringify(manifest, null, 2);
}
