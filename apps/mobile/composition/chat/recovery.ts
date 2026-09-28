import type { ChatGenerationOwner } from "@locallab/chat-engine-core";
import { RunEventSchema, type RunEvent } from "@locallab/contracts/run-events";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { GenerationSession } from "../../platform/generation-session-core";

type TerminalEvent = Extract<
  RunEvent,
  { type: "RunCompleted" | "RunCanceled" | "RunFailed" }
>;
export interface RecoveredChatRun {
  readonly runId: string;
  readonly conversationId: string;
  readonly event: TerminalEvent;
}
export interface ChatRecoveryResult {
  readonly recovered: RecoveredChatRun[];
  readonly skippedLive: string[];
  readonly skippedUnknown: string[];
  readonly skippedInvalid: string[];
}
type Row = {
  id: string;
  conversation_id: string;
  parameters_json: string;
  status: string;
};

/** Claim only dead, explicitly tagged app sessions. Never infer that another tab's running run is stale. */
export async function recoverInterruptedChatRuns(
  db: SQLiteDatabasePort,
  session: GenerationSession,
  options: { now?: () => string; maximumRuns?: number } = {},
): Promise<ChatRecoveryResult> {
  session.assertActive();
  const maximum = options.maximumRuns ?? 10_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000)
    throw new Error("Invalid interrupted run recovery limit");
  const rows = await db.getAllAsync<Row>(
    "SELECT id,conversation_id,parameters_json,status FROM runs WHERE status='running' ORDER BY created_at,id LIMIT ?",
    maximum + 1,
  );
  if (rows.length > maximum)
    throw new Error(
      "Too many interrupted responses to recover. Export the chat database before retrying.",
    );
  const hasLifecycle = Boolean(
    await db.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='generation_lifecycle'",
    ),
  );
  const result: ChatRecoveryResult = {
    recovered: [],
    skippedLive: [],
    skippedUnknown: [],
    skippedInvalid: [],
  };
  const now = options.now ?? (() => new Date().toISOString());
  for (const row of rows) {
    const owner = readOwner(JSON.parse(row.parameters_json));
    if (!owner) {
      result.skippedUnknown.push(row.id);
      continue;
    }
    const claimed = await session.withOrphanedOwner(owner, async () => {
      let recovered: RecoveredChatRun | undefined;
      await db.withTransactionAsync(async (transaction) => {
        const scoped = transaction ?? db;
        const current = await scoped.getFirstAsync<Row>(
          "SELECT id,conversation_id,parameters_json,status FROM runs WHERE id=?",
          row.id,
        );
        if (!current || current.status !== "running") return;
        const metadata = JSON.parse(current.parameters_json) as Record<
          string,
          unknown
        >;
        const currentOwner = readOwner(metadata);
        if (
          !currentOwner ||
          currentOwner.id !== owner.id ||
          currentOwner.platform !== owner.platform
        )
          return;
        const events = readEvents(metadata.events, row.id);
        if (!events) {
          result.skippedInvalid.push(row.id);
          return;
        }
        const assistant = await scoped.getFirstAsync<{ id: string }>(
          "SELECT id FROM messages WHERE run_id=? AND role='assistant' AND conversation_id=?",
          row.id,
          row.conversation_id,
        );
        if (!assistant || metadata.assistantMessageId !== assistant.id) {
          result.skippedInvalid.push(row.id);
          return;
        }
        const timestamp = now();
        const lifecycle = hasLifecycle
          ? await scoped.getFirstAsync<{
              state: string;
              last_sequence: number;
              partial_text: string;
              partial_reasoning: string;
              remote_job_id: string | null;
            }>(
              "SELECT state,last_sequence,partial_text,partial_reasoning,remote_job_id FROM generation_lifecycle WHERE run_id=?",
              row.id,
            )
          : null;
        // A durable remote job owns its own reconciliation after the UI session ends.
        if (lifecycle?.remote_job_id || lifecycle?.state === "remote_pending") {
          result.skippedUnknown.push(row.id);
          return;
        }
        const terminal = events.slice().reverse().find(isTerminal);
        const event: TerminalEvent =
          terminal ??
          (RunEventSchema.parse({
            type: "RunCanceled",
            runId: row.id,
            sequence: (events.at(-1)?.sequence ?? -1) + 1,
            timestamp,
            reason:
              "Generation interrupted when the app closed. Partial response saved; send a new message to continue.",
          }) as TerminalEvent);
        const savedEvents = terminal ? events : [...events, event];
        const status =
          event.type === "RunCompleted"
            ? "completed"
            : event.type === "RunFailed"
              ? "failed"
              : "canceled";
        // Keep the exact persisted assistant parts; recovery never regenerates or discards partial output.
        await scoped.runAsync(
          "UPDATE runs SET status=?,parameters_json=?,finished_at=? WHERE id=? AND status='running'",
          status,
          JSON.stringify({ ...metadata, events: savedEvents }),
          event.timestamp,
          row.id,
        );
        if (lifecycle) {
          const missing = events.filter(
            (saved) => saved.sequence > lifecycle.last_sequence,
          );
          await scoped.runAsync(
            "UPDATE generation_lifecycle SET state=?,last_sequence=MAX(last_sequence,?),partial_text=?,partial_reasoning=?,updated_at=? WHERE run_id=? AND state IN ('running','interrupted',?)",
            status,
            event.sequence,
            lifecycle.partial_text +
              missing
                .filter((saved) => saved.type === "TextDelta")
                .map((saved) => saved.text)
                .join(""),
            lifecycle.partial_reasoning +
              missing
                .filter((saved) => saved.type === "ReasoningDelta")
                .map((saved) => saved.text)
                .join(""),
            event.timestamp,
            row.id,
            status,
          );
        }
        await scoped.runAsync(
          "UPDATE conversations SET updated_at=? WHERE id=?",
          timestamp,
          row.conversation_id,
        );
        recovered = {
          runId: row.id,
          conversationId: row.conversation_id,
          event,
        };
      });
      return recovered;
    });
    if (!claimed.orphaned) result.skippedLive.push(row.id);
    else if (claimed.value) result.recovered.push(claimed.value);
  }
  return result;
}

function readOwner(metadata: unknown): ChatGenerationOwner | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const owner = (metadata as { generationOwner?: unknown }).generationOwner;
  if (!owner || typeof owner !== "object") return undefined;
  const value = owner as Partial<ChatGenerationOwner>;
  return typeof value.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.id,
    ) &&
    value.scope === "mobile-chat" &&
    (value.platform === "web" || value.platform === "native")
    ? (value as ChatGenerationOwner)
    : undefined;
}
function readEvents(value: unknown, runId: string): RunEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: RunEvent[] = [];
  let sequence = -1;
  let terminal = false;
  for (const item of value) {
    const parsed = RunEventSchema.safeParse(item);
    if (
      !parsed.success ||
      parsed.data.runId !== runId ||
      parsed.data.sequence <= sequence ||
      terminal
    )
      return undefined;
    sequence = parsed.data.sequence;
    terminal = isTerminal(parsed.data);
    events.push(parsed.data);
  }
  return events;
}
function isTerminal(event: RunEvent): event is TerminalEvent {
  return (
    event.type === "RunCompleted" ||
    event.type === "RunCanceled" ||
    event.type === "RunFailed"
  );
}
