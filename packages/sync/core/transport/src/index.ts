/**
 * T098C (SY-01, SY-08) — live paired sync transport over the sealed
 * pairing channel.
 *
 * - The queue holds ONLY the frozen wire payloads from the relay contract:
 *   `sync-batch {records}` (≤ MAX_SYNC_RECORDS_PER_BATCH per batch) and
 *   `sync-ack {recordIds}`; the composition layer seals them with the
 *   pair's session keys before they touch the relay, so nothing here ever
 *   sees plaintext crossing a network and nothing here can leak a batch
 *   for a pair that has not opted in (`allowed()` is consulted on every
 *   enqueue AND every pump step — a disabled pair never queues or sends).
 * - At-least-once delivery with a resume cursor: a batch leaves the queue
 *   only once every record in the batch has been acked FOR THAT BATCH
 *   (`sync-ack {batchId}` names the batch it answers), so an entity id
 *   re-enqueued under a newer revision is never suppressed by an old
 *   acknowledgement and stale acks of drained batches are rejected here;
 *   the cursor advances monotonically, so dropped, reordered or duplicated
 *   frames (sends or acks) resume idempotently — replays collapse in the
 *   receiver's revision merge (T098B).
 * - Retries are BOUNDED per batch (SY-08): after `maxAttempts` the
 *   transport suspends with a user-visible failure note ("toggle Sync
 *   chats off and on to retry" copy lives in the mobile feature) and
 *   stays suspended until `wake()` — host wake / sleep resume.
 */
import { SyncRecordSchema, TombstoneSchema } from "@locallab/contracts/entities";
import { createUuidV7 } from "@locallab/remote-crypto";
import {
  EncryptedPayloadSchema,
  MAX_SYNC_RECORDS_PER_BATCH,
  type EncryptedPayload,
} from "@locallab/service-contracts/relay";
import { z } from "zod";

type SyncRecord = z.infer<typeof SyncRecordSchema>;
type Tombstone = z.infer<typeof TombstoneSchema>;
export type SyncChange = SyncRecord | Tombstone;
type SyncBatchPayload = Extract<EncryptedPayload, { tag: "sync-batch" }>;
type SyncAckPayload = Extract<EncryptedPayload, { tag: "sync-ack" }>;

export class SyncTransportError extends Error {
  readonly kind: "malformed";
  constructor(kind: "malformed", message: string) {
    super(message);
    this.kind = kind;
    this.name = "SyncTransportError";
  }
}

/** Composition injects the sealed send (seal → relay socket). */
export type SyncSendPort = (
  payload: SyncBatchPayload,
  requestId: string,
) => Promise<void>;

export type SyncTransportState = "idle" | "retrying" | "failed" | "disabled";

export interface SyncTransportStatus {
  state: SyncTransportState;
  /** User-facing note; empty when healthy. Feed into syncFailureNote (SY-08). */
  note: string;
  pendingRecords: number;
  resumeCursor: number;
  attempts: number;
}

export interface SyncTransportOptions {
  routeId: string;
  send: SyncSendPort;
  /** The single preferences gate (T098A `syncDataAllowed`). */
  allowed: () => boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  onStatus?: (status: SyncTransportStatus) => void;
  /** Injectable delay so callers own timers (RN-safe; no node imports). */
  delay?: (ms: number) => Promise<void>;
  /**
   * R008: how long a sent-but-unacknowledged batch may sit in the window
   * before it counts as a lost attempt and is re-pumped (the shared
   * SY-08 maxAttempts budget applies). Undefined (default) disables the
   * watchdog; hosts that rely on at-least-once delivery without an
   * external pump re-invocation MUST set it.
   */
  ackTimeoutMs?: number;
  /** Injectable ack-watchdog timer (defaults to a real timeout). */
  watchdogDelay?: (ms: number) => Promise<void>;
}

const CHANGE_SCHEMA = z.union([SyncRecordSchema, TombstoneSchema]);

function defaultDelay(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export class SyncTransport {
  private readonly opts: Required<
    Omit<SyncTransportOptions, "onStatus" | "ackTimeoutMs" | "watchdogDelay">
  > & {
    onStatus?: (status: SyncTransportStatus) => void;
    ackTimeoutMs?: number;
    watchdogDelay?: (ms: number) => Promise<void>;
  };
  private queue: SyncBatchPayload[] = [];
  private ackedWindow: { batchId: string; ids: Set<string> } | null = null;
  private cursor = 0;
  private attempts = 0;
  private suspended = false;
  private noteText = "";
  private state: SyncTransportState = "idle";
  private pumping = false;

  constructor(options: SyncTransportOptions) {
    this.opts = {
      routeId: options.routeId,
      send: options.send,
      allowed: options.allowed,
      maxAttempts: options.maxAttempts ?? 5,
      retryDelayMs: options.retryDelayMs ?? 50,
      delay: options.delay ?? defaultDelay,
      ...(options.onStatus !== undefined ? { onStatus: options.onStatus } : {}),
      ...(options.ackTimeoutMs !== undefined ? { ackTimeoutMs: options.ackTimeoutMs } : {}),
      ...(options.watchdogDelay !== undefined ? { watchdogDelay: options.watchdogDelay } : {}),
    };
  }

  /** Queue validated records as ≤500-record encrypted-batch payloads. */
  enqueue(records: readonly unknown[]): number {
    if (!this.opts.allowed()) {
      this.mark("disabled", "Sync is off for this pair.");
      return 0;
    }
    const changes: SyncChange[] = [];
    for (const raw of records) {
      const parsed = CHANGE_SCHEMA.safeParse(raw);
      if (!parsed.success)
        throw new SyncTransportError("malformed", "record does not match the sync batch contract");
      changes.push(parsed.data);
    }
    for (let i = 0; i < changes.length; i += MAX_SYNC_RECORDS_PER_BATCH) {
      this.queue.push({
        tag: "sync-batch",
        batchId: createUuidV7(),
        records: changes.slice(i, i + MAX_SYNC_RECORDS_PER_BATCH),
      });
    }
    this.publish();
    return changes.length;
  }

  /** Apply a `sync-ack {batchId, recordIds}` frame. Acknowledgements are
   * scoped to the batch they answer: with the window one batch wide, an
   * ack naming any other batch (stale, duplicated from an already-drained
   * one) is dropped, while repeated acks of the live batch drain its head
   * exactly once and stay idempotent under replay/reorder. */
  handleAck(frame: unknown): void {
    const parsed = EncryptedPayloadSchema.safeParse(frame);
    if (!parsed.success || parsed.data.tag !== "sync-ack")
      throw new SyncTransportError("malformed", "not a sync-ack payload");
    const ack = parsed.data as SyncAckPayload;
    const head = this.queue[0];
    if (head === undefined || head.batchId !== ack.batchId) return;
    if (this.ackedWindow === null)
      this.ackedWindow = { batchId: ack.batchId, ids: new Set() };
    for (const id of ack.recordIds) this.ackedWindow.ids.add(id);
    if (this.isFullyAcked(head)) this.drainAckedHead();
    this.publish();
  }

  /** Pump the queue with bounded per-batch retries. */
  async sendPending(): Promise<void> {
    if (!this.opts.allowed()) {
      this.mark("disabled", "Sync is off for this pair.");
      return;
    }
    // R008: one active send pump — concurrent re-invocations (ack
    // arrivals, host flush, the ack watchdog) collapse into the running
    // pump instead of double-sending or spinning overlapping loops.
    if (this.pumping) return;
    this.pumping = true;
    try {
    if (this.suspended) return;
    while (this.queue.length > 0) {
      if (!this.opts.allowed() || this.suspended) return;
      const head = this.queue[0]!;
      if (this.isFullyAcked(head)) {
        this.drainAckedHead();
        continue;
      }
      try {
        // requestId must be UUIDv7 (the pairing wire contract rejects v4).
        await this.opts.send(head, createUuidV7());
        // Acks arrive asynchronously on the receive socket; stop this pass
        // (window of one in flight) so we never spin — the composition
        // re-invokes sendPending on ack timeout / reconnect / host wake.
        // The head also counts as settled when its ack arrived DURING its
        // own send: handleAck already retired it, so it is no longer the
        // head and there is nothing left to wait for.
        if (this.queue[0] === head && !this.isFullyAcked(head)) {
          this.armAckWatchdog(head);
          return;
        }
        this.attempts = 0;
      } catch {
        this.attempts += 1;
        if (this.attempts >= this.opts.maxAttempts) {
          this.suspended = true;
          this.mark("failed", `Sync failed: the paired device is unreachable (pair ${this.opts.routeId}).`);
          return;
        }
        this.mark("retrying", `Sync retrying (attempt ${this.attempts + 1}).`);
        await this.opts.delay(this.opts.retryDelayMs);
      }
    }
    this.publish();
    } finally {
      this.pumping = false;
    }
  }

  /**
   * R008 (SY-08): a batch whose acknowledgement is lost would otherwise
   * hold the window forever. The watchdog consumes the shared bounded
   * attempt budget: within bounds it re-pumps the same batch; beyond it
   * the transport suspends with a user-visible failure, exactly like a
   * dropped send. Arming stops at wake/disable/ack transitions because
   * the handler re-checks the window identity before acting.
   */
  private armAckWatchdog(head: SyncBatchPayload): void {
    const timeoutMs = this.opts.ackTimeoutMs;
    if (timeoutMs === undefined) return;
    const wait = this.opts.watchdogDelay ?? defaultDelay;
    void wait(timeoutMs)
      .then(() => {
        if (this.suspended || !this.opts.allowed()) return;
        if (this.queue[0] !== head || this.isFullyAcked(head)) return;
        this.attempts += 1;
        if (this.attempts >= this.opts.maxAttempts) {
          this.suspended = true;
          this.mark(
            "failed",
            `Sync failed: no acknowledgement from the paired device (pair ${this.opts.routeId}).`,
          );
          return;
        }
        this.mark("retrying", `Sync retrying (no acknowledgement yet, attempt ${this.attempts + 1}).`);
        void this.sendPending();
      })
      .catch(() => {
        // A failing injected timer must never crash the transport; the
        // batch simply stays in the window for the next external pump.
      });
  }

  /** Host wake / off-on toggle: clear the suspension and resume pumping. */
  wake(): void {
    this.suspended = false;
    this.noteText = "";
    this.attempts = 0;
    this.state = "idle";
    this.publish();
  }

  status(): SyncTransportStatus {
    return {
      state: this.opts.allowed() ? this.state : "disabled",
      note: this.opts.allowed() ? this.noteText : "Sync is off for this pair.",
      pendingRecords: this.queue.reduce((sum, batch) => sum + batch.records.length, 0),
      resumeCursor: this.cursor,
      attempts: this.attempts,
    };
  }

  private mark(state: SyncTransportState, note: string) {
    this.state = state;
    this.noteText = note;
    this.publish();
  }

  private publish() {
    this.opts.onStatus?.(this.status());
  }

  private isFullyAcked(batch: SyncBatchPayload): boolean {
    return (
      this.ackedWindow !== null &&
      this.ackedWindow.batchId === batch.batchId &&
      batch.records.every((record) => this.ackedWindow!.ids.has(record.id))
    );
  }

  /** Retire the fully acknowledged head batch together with its
   * acknowledgement bookkeeping, so completed-window state never
   * accumulates (bounded by one batch by construction). */
  private drainAckedHead(): void {
    this.queue.shift();
    this.ackedWindow = null;
    this.cursor += 1;
    this.attempts = 0;
    if (this.queue.length === 0 && !this.suspended) {
      this.noteText = "";
      this.state = "idle";
    }
  }
}

/**
 * Receiver helper the composition runs on the peer side: ack ONLY the
 * record ids the local store accepted, under the batchId of the batch
 * being answered (malformed records in a batch are dropped, never acked,
 * and a replayed batch re-acks the live batch harmlessly).
 */
export function syncAckPayload(
  batchId: string,
  recordIds: readonly string[],
): SyncAckPayload {
  const parsed = z
    .object({ tag: z.literal("sync-ack"), batchId: z.string().regex(/^[0-9a-f-]{36}$/i), recordIds: z.array(z.string().regex(/^[0-9a-f-]{36}$/i)).max(MAX_SYNC_RECORDS_PER_BATCH) })
    .strict()
    .safeParse({ tag: "sync-ack", batchId, recordIds: [...recordIds] });
  if (!parsed.success)
    throw new SyncTransportError("malformed", "ack does not match the batch contract");
  return parsed.data as SyncAckPayload;
}
