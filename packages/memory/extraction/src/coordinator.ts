import { EntityIdSchema } from "@locallab/contracts/identity";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { checkedScope } from "./identity";
import { validateMemoryCandidates } from "./extractor";
import { SQLiteMemoryStore } from "./store";
import { waitForResources, waitWithAbort } from "./resources";
import {
  MEMORY_LIMITS,
  type EligibleTurn,
  type MemoryExtractionPort,
  type MemoryExtractionResult,
  type MemoryPolicy,
} from "./types";

export interface CompletedMemoryTurn {
  runId: string;
  userMessageId: string;
  conversationId: string;
  policy: MemoryPolicy;
  extractor: MemoryExtractionPort;
  signal?: AbortSignal;
  /** Re-resolve consent after generation, so a toggle change prevents commit. */
  isStillAllowed?: (transaction?: SQLiteDatabasePort) => Promise<boolean>;
}

/** Background, single-provider orchestration with a bounded queue and durable run claims. */
export class MemoryExtractionCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private disposed = false;
  private readonly active = new Set<AbortController>();
  private readonly drains = new Set<Promise<void>>();
  private cancelling = 0;
  constructor(readonly store: SQLiteMemoryStore) {}

  /** Snapshot completion includes actual provider cleanup after durable results. */
  get resourcesDrained(): Promise<void> {
    return this.queue.catch(() => {}).then(() => this.drainSnapshot());
  }

  enqueueCompleted(
    input: CompletedMemoryTurn,
  ): Promise<MemoryExtractionResult> {
    if (!input.policy.extract)
      return Promise.resolve({ status: "skipped", reason: "disabled" });
    if (this.disposed || this.cancelling || input.signal?.aborted)
      return Promise.resolve({ status: "canceled" });
    if (this.pending >= MEMORY_LIMITS.pendingExtractions)
      return Promise.resolve({ status: "skipped", reason: "queue-full" });
    EntityIdSchema.parse(input.runId);
    EntityIdSchema.parse(input.userMessageId);
    EntityIdSchema.parse(input.conversationId);
    checkedScope(input.policy.scope);
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    this.active.add(controller);
    this.pending++;
    // Snapshot the explicit scope/selection. A later Persona switch applies to the next turn.
    const snapshot: CompletedMemoryTurn = {
      ...input,
      policy: {
        ...input.policy,
        scope: { ...input.policy.scope },
        ...(input.policy.selectedMemoryIds
          ? { selectedMemoryIds: [...input.policy.selectedMemoryIds] }
          : {}),
      },
    };
    const result = this.queue
      .catch(() => {})
      .then(() => this.extract(snapshot, controller.signal))
      .finally(() => {
        this.pending--;
        this.active.delete(controller);
        input.signal?.removeEventListener("abort", abort);
      });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancelPending({ waitForResources: false });
    await this.resourcesDrained;
  }

  /** Foreground sends can take priority over background use of a local model. */
  async cancelPending(
    options: { waitForResources?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    this.cancelling++;
    try {
      for (const controller of this.active)
        controller.abort(new Error("Memory extraction canceled"));
      await this.queue;
      if (options.waitForResources !== false)
        await waitForResources(
          this.drainSnapshot(),
          options.timeoutMs ?? MEMORY_LIMITS.resourceAdmissionMs,
        );
    } finally {
      this.cancelling--;
    }
  }

  private async extract(
    input: CompletedMemoryTurn,
    signal: AbortSignal,
  ): Promise<MemoryExtractionResult> {
    let token: string | null = null;
    try {
      signal.throwIfAborted();
      await waitWithAbort(this.drainSnapshot(), signal);
      if (input.isStillAllowed && !(await input.isStillAllowed()))
        return { status: "skipped", reason: "disabled" };
      const turn = await readEligibleMemoryTurn(this.store.db, input);
      if (!turn) return { status: "skipped", reason: "ineligible" };
      token = await this.store.claimExtraction(input.runId, input.policy.scope);
      if (!token) return { status: "skipped", reason: "already-processed" };
      const existing = await this.store.list({
        scope: input.policy.scope,
        limit: MEMORY_LIMITS.existingEntries,
      });
      const extraction = Promise.resolve(
        input.extractor.extract({
          turn,
          existing: existing.map(({ entry }) => entry),
          maximumCandidates: MEMORY_LIMITS.candidates,
          signal,
        }),
      );
      // The raw operation is retained even when our abortable durable wait ends.
      const drainage = extraction
        .then(
          () => input.extractor.resourcesDrained,
          () => input.extractor.resourcesDrained,
        )
        .then(() => {});
      this.drains.add(drainage);
      void drainage.then(
        () => {
          this.drains.delete(drainage);
        },
        () => {},
      );
      const candidates = validateMemoryCandidates(
        {
          candidates: await waitWithAbort(extraction, signal),
        },
        turn,
      );
      signal.throwIfAborted();
      const saved = await this.store.commitCandidates({
        turn,
        scope: input.policy.scope,
        token,
        candidates,
        extractor: input.extractor.identity,
        stillEligible: async (transaction) => {
          if (
            signal.aborted ||
            (input.isStillAllowed && !(await input.isStillAllowed(transaction)))
          )
            return false;
          const current = await readEligibleMemoryTurn(transaction, input);
          return !!current && JSON.stringify(current) === JSON.stringify(turn);
        },
      });
      if (saved === null) {
        await this.store.failExtraction(input.runId, input.policy.scope, token);
        return signal.aborted
          ? { status: "canceled" }
          : { status: "skipped", reason: "ineligible" };
      }
      return { status: "completed", saved };
    } catch {
      if (token)
        await this.store
          .failExtraction(input.runId, input.policy.scope, token)
          .catch(() => {});
      return signal.aborted
        ? { status: "canceled" }
        : {
            status: "failed",
            message:
              "Could not extract memory. Your conversation is saved; no candidate facts were added.",
          };
    }
  }

  private drainSnapshot(): Promise<void> {
    return Promise.all([...this.drains]).then(() => {});
  }
}

/** Reads only final visible text from the exact completed run and its original user message. */
export async function readEligibleMemoryTurn(
  db: SQLiteDatabasePort,
  input: Pick<
    CompletedMemoryTurn,
    "runId" | "userMessageId" | "conversationId"
  >,
): Promise<EligibleTurn | null> {
  const run = await db.getFirstAsync<{
    status: string;
    conversation_id: string;
    parameters_json: string;
  }>(
    "SELECT status,conversation_id,parameters_json FROM runs WHERE id=?",
    input.runId,
  );
  if (
    run?.status !== "completed" ||
    run.conversation_id !== input.conversationId
  )
    return null;
  const metadata = JSON.parse(run.parameters_json) as {
    userMessageId?: unknown;
    assistantMessageId?: unknown;
  };
  if (
    metadata.userMessageId !== undefined &&
    metadata.userMessageId !== input.userMessageId
  )
    return null;
  const rows = await db.getAllAsync<{
    id: string;
    conversation_id: string;
    role: string;
    parts_json: string;
    sequence: number;
    run_id: string | null;
  }>(
    "SELECT id,conversation_id,role,parts_json,sequence,run_id FROM messages WHERE conversation_id=? AND (id=? OR (run_id=? AND role='assistant')) ORDER BY sequence",
    input.conversationId,
    input.userMessageId,
    input.runId,
  );
  const user = rows.find(
    (row) => row.id === input.userMessageId && row.role === "user",
  );
  const assistants = rows.filter((row) => row.role === "assistant");
  if (
    !user ||
    assistants.length !== 1 ||
    assistants[0]!.sequence <= user.sequence
  )
    return null;
  const assistant = assistants[0]!;
  if (
    metadata.assistantMessageId !== undefined &&
    metadata.assistantMessageId !== assistant.id
  )
    return null;
  if (metadata.userMessageId === undefined && user.run_id !== input.runId)
    return null;
  const userText = textOnly(user.parts_json);
  const assistantText = textOnly(assistant.parts_json);
  if (
    !userText.trim() ||
    !assistantText.trim() ||
    userText.length + assistantText.length > MEMORY_LIMITS.turnCharacters
  )
    return null;
  return {
    runId: input.runId,
    conversationId: input.conversationId,
    user: { messageId: user.id, text: userText },
    assistant: { messageId: assistant.id, text: assistantText },
  };
}

function textOnly(partsJson: string): string {
  const parts: unknown = JSON.parse(partsJson);
  if (!Array.isArray(parts)) throw new Error("Invalid stored message parts");
  return parts
    .flatMap((part: unknown) => {
      if (!part || typeof part !== "object") return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join("\n");
}
