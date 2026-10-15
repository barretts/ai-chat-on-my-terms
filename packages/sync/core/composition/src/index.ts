/**
 * T098 (SY-01..SY-08) — sync composition: opt-in state (T098A),
 * deterministic revision merge (T098B) and the live paired transport
 * (T098C) fused into ONE port the hosts call.
 *
 * - Every outbound frame is gated by the single preferences rule
 *   (`syncDataAllowed` = enabled AND initial choice made), so disabled
 *   pairs and un-chosen pairs never encrypt or send anything (SY-02/03/07).
 * - The entity allowlist lives in the merge layer (conversation, message,
 *   folder + tombstones only): preference, model, persona, provider and
 *   secret-bearing records throw `unsupported` at enqueue AND at receive,
 *   fail-closed, so excluded data can never enter a sync envelope (SY-03).
 * - Initial copy semantics: the CHOSEN SOURCE sends its whole live set;
 *   the target replaces its local set by tombstoning its own rows at the
 *   choice wall time (newer than every pre-existing revision, so the
 *   tombstones beat the source's stragglers regardless of arrival order).
 *   "merge" simply sends both sides' sets. Disabling never deletes
 *   anything anywhere (SY-07); re-enable retains choice + initialSyncDone
 *   so the initial copy never repeats (T098A).
 * - Failure handling (SY-08): the transport's bounded retry + resume
 *   cursor drives a user-visible status; `retryAfterWake()` is the seam
 *   host wake and the Sync off/on toggle call.
 */
import type { Revision } from "@locallab/contracts/identity";
import { EncryptedPayloadSchema, type EncryptedPayload } from "@locallab/service-contracts/relay";
import { MergeStore, assertChangeAllowed, isChatTierType, SyncMergeError, type MergeStateRow } from "@locallab/sync-merge";
import {
  SyncPreferenceError,
  completeInitialSync,
  findPairSyncPreference,
  optInPairSync,
  optOutPairSync,
  parseSyncPreferenceRecords,
  setInitialSyncChoice,
  syncDataAllowed,
  type PairSyncPreference,
  type SyncChoice,
  type SyncPreferenceVault,
} from "@locallab/sync-preferences";
import {
  SyncTransport,
  syncAckPayload,
  type SyncSendPort,
  type SyncTransportStatus,
} from "@locallab/sync-transport";

export class SyncCompositionError extends Error {
  readonly kind: "state" | "malformed";
  constructor(kind: "state" | "malformed", message: string) {
    super(message);
    this.kind = kind;
    this.name = "SyncCompositionError";
  }
}

/** Which physical side this engine runs on; decides copy-phone/copy-Mac roles. */
export type SyncSide = "phone" | "mac";

export interface SyncEngineOptions {
  routeId: string;
  deviceId: string;
  side: SyncSide;
  store: MergeStore;
  vault: SyncPreferenceVault;
  /** ISO wall clock; choice stamps use it so replacement beats stale data. */
  now: () => string;
  sendBatch: SyncSendPort;
  sendAck: (ack: Extract<EncryptedPayload, { tag: "sync-ack" }>) => Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: number;
  delay?: (ms: number) => Promise<void>;
  onStatus?: (status: SyncTransportStatus) => void;
  /**
   * T099 persona tier: admission gate consulted for non-chat entity types
   * (persona/memory/attachment) on BOTH the enqueue and receive seams.
   * Absent = nothing persona-tier may cross.
   */
  personaGate?: (entityType: string, entityId: string, payload?: unknown) => boolean;
}

type SyncBatchPayload = Extract<EncryptedPayload, { tag: "sync-batch" }>;

export class SyncEngine {
  private readonly opts: SyncEngineOptions;
  private readonly transport: SyncTransport;
  private rows: PairSyncPreference[] = [];
  private allowedGate = false;

  constructor(options: SyncEngineOptions) {
    this.opts = options;
    this.transport = new SyncTransport({
      routeId: options.routeId,
      send: options.sendBatch,
      allowed: () => this.allowedGate,
      maxAttempts: options.maxAttempts,
      retryDelayMs: options.retryDelayMs,
      delay: options.delay,
      onStatus: options.onStatus,
    });
  }

  /** Re-read the vault; the transport gate flips with it. */
  async refresh(): Promise<void> {
    this.rows = parseSyncPreferenceRecords(await this.opts.vault.load());
    this.allowedGate = syncDataAllowed(this.rows, this.opts.routeId);
  }

  async enableSync(): Promise<void> {
    await this.mutate((rows) => optInPairSync(rows, this.opts.routeId, this.opts.now()));
  }

  async disableSync(): Promise<void> {
    await this.mutate((rows) => optOutPairSync(rows, this.opts.routeId, this.opts.now()));
  }

  async chooseInitial(choice: SyncChoice): Promise<void> {
    await this.mutate((rows) =>
      setInitialSyncChoice(rows, this.opts.routeId, choice, this.opts.now()),
    );
  }

  /**
   * Initial copy/merge for this pair (both devices call it after the
   * pairing prompt records the SAME choice). Source = chosen side; the
   * target tombstones its own set first. No-op once recorded complete.
   */
  async runInitialSync(): Promise<void> {
    await this.refresh();
    const pref = findPairSyncPreference(this.rows, this.opts.routeId);
    if (pref === null || !pref.enabled)
      throw new SyncCompositionError("state", "sync is not enabled for this pair");
    if (pref.choice === null)
      throw new SyncCompositionError("state", "the initial copy/merge choice is still pending");
    if (pref.initialSyncDone) return;
    const isSource =
      pref.choice === "merge" ||
      (pref.choice === "copy-phone" && this.opts.side === "phone") ||
      (pref.choice === "copy-mac" && this.opts.side === "mac");
    if (isSource) {
      this.transport.enqueue(this.liveSourceRecords());
      await this.transport.sendPending();
    } else {
      this.replaceLocalSet();
    }
    await this.mutate((rows) => completeInitialSync(rows, this.opts.routeId, this.opts.now()));
  }

  /**
   * Host seam for local edits/deletions/new rows: queue them for the peer
   * (0 when the pair is disabled — SY-07 never leaks outbound).
   */
  noteLocalChange(records: readonly unknown[]): number {
    for (const record of records) this.admit(record); // SY-03 chat tier, SY-10 persona tier
    return this.transport.enqueue(records);
  }

  /**
   * Fail-closed admission for one change: chat types run the SY-03
   * allowlist; anything else is persona-tier and needs BOTH an injected
   * gate and its per-pair selection to pass — outbound and inbound.
   */
  private admit(change: unknown): void {
    const fields = change as Record<string, unknown>;
    const entityType = typeof fields?.entityType === "string" ? fields.entityType : "";
    if (entityType !== "" && !isChatTierType(entityType)) {
      const gate = this.opts.personaGate;
      const entityId = typeof fields?.entityId === "string" ? fields.entityId : "";
      if (gate === undefined || entityId === "" || !gate(entityType, entityId, fields.payload))
        throw new SyncMergeError("unsupported", `entity type ${entityType} never syncs`);
      return;
    }
    assertChangeAllowed(change);
  }

  /** Push the queue at the peer (window-one pump; bounded retries). */
  async flush(): Promise<void> {
    await this.transport.sendPending();
  }

  /**
   * Incoming sealed-and-opened frame. `sync-ack` drains our cursor;
   * `sync-batch` merges (allowlist enforced fail-closed) then acks the
   * applied ids. Disabled pairs ignore inbound frames entirely.
   */
  async onFrame(frame: unknown): Promise<void> {
    const parsed = EncryptedPayloadSchema.safeParse(frame);
    if (!parsed.success)
      throw new SyncCompositionError("malformed", "frame does not match the relay contract");
    if (parsed.data.tag === "sync-ack") {
      this.transport.handleAck(parsed.data);
      return;
    }
    if (parsed.data.tag !== "sync-batch") return;
    if (!this.allowedGate) return; // SY-07: sync off means nothing crosses this seam
    const batch = parsed.data as SyncBatchPayload;
    const accepted: string[] = [];
    for (const record of batch.records) {
      this.admit(record); // SY-10: no persona-tier rows we never selected enter the store
      this.opts.store.apply(record); // throws unsupported/malformed fail-closed
      accepted.push(record.id);
    }
    await this.opts.sendAck(syncAckPayload(accepted));
  }

  /** SY-08 seam: host wake or Sync off/on toggle reschedules the queue. */
  async retryAfterWake(): Promise<void> {
    await this.refresh();
    this.transport.wake();
    await this.transport.sendPending();
  }

  status(): SyncTransportStatus {
    return this.transport.status();
  }

  conflicts() {
    return this.opts.store.conflicts();
  }

  private async mutate(next: (rows: PairSyncPreference[]) => PairSyncPreference[]): Promise<void> {
    const fresh = parseSyncPreferenceRecords(await this.opts.vault.load());
    const updated = next(fresh);
    await this.opts.vault.save(updated);
    this.rows = updated;
    this.allowedGate = syncDataAllowed(updated, this.opts.routeId);
  }

  /**
   * Rebuild source records from live store rows: the stable recordId +
   * stored revision are reused VERBATIM (IDs/revisions are never
   * rewritten), envelopes re-stamped from the local clock.
   */
  private liveSourceRecords(): unknown[] {
    const stamp = this.opts.now();
    const gate = this.opts.personaGate;
    return this.opts.store
      .snapshot()
      .filter(
        (entry) =>
          entry.row.payload !== null &&
          (isChatTierType(entry.row.entityType) ||
            (gate !== undefined && gate(entry.row.entityType, entry.row.entityId, entry.row.payload))),
      )
      .map((entry) => this.envelope(entry.row, stamp));
  }

  /** Target side of copy-*: tombstone every live local row. */
  private replaceLocalSet(): void {
    const stamp = this.opts.now();
    for (const entry of this.opts.store.snapshot()) {
      if (entry.row.payload === null) continue;
      this.opts.store.apply({
        id: entry.row.entityId,
        createdAt: stamp,
        updatedAt: stamp,
        revision: this.replacementRevision(stamp),
        entityType: entry.row.entityType,
        entityId: entry.row.entityId,
      });
    }
  }

  private envelope(row: MergeStateRow, stamp: string) {
    return {
      id: row.recordId,
      createdAt: stamp,
      updatedAt: stamp,
      revision: row.revision,
      entityType: row.entityType,
      entityId: row.entityId,
      payload: row.payload,
      acknowledgedAt: null,
    };
  }

  private replacementRevision(stamp: string): Revision {
    // Wall time of the choice: strictly newer than any pre-existing row,
    // so replacement tombstones win regardless of arrival order (SY-06).
    return { wallMs: Date.parse(stamp), counter: 0, deviceId: this.opts.deviceId };
  }
}

export { SyncPreferenceError };
