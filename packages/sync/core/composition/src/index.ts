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
import { createUuidV7 } from "@locallab/remote-crypto";
import { MergeStore, assertChangeAllowed, isChatTierType, SyncMergeError, type MergeStateRow, type SyncRecord } from "@locallab/sync-merge";
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
  /** R008: passed through to the transport ack watchdog (SY-08). */
  ackTimeoutMs?: number;
  watchdogDelay?: (ms: number) => Promise<void>;
  delay?: (ms: number) => Promise<void>;
  onStatus?: (status: SyncTransportStatus) => void;
  /**
   * T099 persona tier: admission gate consulted for non-chat entity types
   * (persona/memory/attachment) on BOTH the enqueue and receive seams.
   * Absent = nothing persona-tier may cross.
   */
  personaGate?: (
    entityType: string,
    entityId: string,
    payload?: unknown,
    batchPersonas?: readonly { entityId: string; payload: unknown }[],
  ) => boolean;
}

type SyncBatchPayload = Extract<EncryptedPayload, { tag: "sync-batch" }>;

export class SyncEngine {
  private readonly opts: SyncEngineOptions;
  private readonly transport: SyncTransport;
  private rows: PairSyncPreference[] = [];
  private allowedGate = false;
  private initialSyncTask: Promise<void> | null = null;
  private deliveryWait: {
    resolve: () => void;
    reject: (err: SyncCompositionError) => void;
  } | null = null;
  // Copy membership is persisted in the preference vault before its ack.
  private copy: {
    snapshotId: string;
    chunks: number;
    applied: Map<number, Map<string, SyncRecord>>;
  } | null = null;

  constructor(options: SyncEngineOptions) {
    this.opts = options;
    this.transport = new SyncTransport({
      routeId: options.routeId,
      send: options.sendBatch,
      allowed: () => this.allowedGate,
      maxAttempts: options.maxAttempts,
      retryDelayMs: options.retryDelayMs,
      delay: options.delay,
      onStatus: (status) => this.observeDelivery(status),
      ...(options.ackTimeoutMs !== undefined ? { ackTimeoutMs: options.ackTimeoutMs } : {}),
      ...(options.watchdogDelay !== undefined ? { watchdogDelay: options.watchdogDelay } : {}),
    });
  }

  /** Re-read the vault; the transport gate flips with it. */
  async refresh(): Promise<void> {
    this.rows = parseSyncPreferenceRecords(await this.opts.vault.load());
    this.allowedGate = syncDataAllowed(this.rows, this.opts.routeId);
    const saved = findPairSyncPreference(this.rows, this.opts.routeId)?.initialCopy;
    this.copy = saved === undefined ? null : {
      snapshotId: saved.snapshotId,
      chunks: saved.chunks,
      applied: new Map(saved.parts.map((part) => [part.seq,
        new Map(part.records.map((record) => [`${record.entityType}/${record.entityId}`, record])),
      ])),
    };
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
   * pairing prompt records the SAME choice). Source = chosen side, and
   * ships its live set as a coordinated membership SNAPSHOT (R006); the
   * target replaces its own set atomically with the delivered members.
   * No-op once recorded complete.
   */
  runInitialSync(): Promise<void> {
    if (this.initialSyncTask === null)
      this.initialSyncTask = this.performInitialSync().finally(() => {
        this.initialSyncTask = null;
      });
    return this.initialSyncTask;
  }

  private async performInitialSync(): Promise<void> {
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
      // R006: for copy-*, the initial queue is a MEMBERSHIP SNAPSHOT, not
      // just rows: every chunk carries the descriptor, so the target can
      // apply its replacement with the full set in hand — either delivery
      // order. The merge choice sends an ordinary queue: nothing replaces.
      const snapshot = pref.choice === "merge" ? undefined : { snapshotId: createUuidV7() };
      this.transport.enqueue(this.liveSourceRecords(), snapshot);
      // R008: completion means DELIVERED, not "queued": a partial send
      // followed by an app kill must never leave `initialSyncDone`
      // recorded while the remaining batches are still undelivered.
      await this.deliverQueued();
    } else {
      // R006: the target tombstones NOTHING before the snapshot is in
      // hand; finalizeCopy throws a retryable state error until then.
      await this.finalizeCopy();
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
  private admit(change: unknown, batchPersonas?: readonly { entityId: string; payload: unknown }[]): void {
    const fields = change as Record<string, unknown>;
    const entityType = typeof fields?.entityType === "string" ? fields.entityType : "";
    if (entityType !== "" && !isChatTierType(entityType)) {
      const gate = this.opts.personaGate;
      const entityId = typeof fields?.entityId === "string" ? fields.entityId : "";
      if (gate === undefined || entityId === "" || !gate(entityType, entityId, fields.payload, batchPersonas))
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
   * R008: the initial copy counts as complete only when EVERY queued
   * batch has been acknowledged. Acks arrive asynchronously and pump the
   * chain via `onFrame`; this waits for the drain (resolved through the
   * status observer) and rejects on suspension, so `completeInitialSync`
   * can never record done-with-undelivered-rows — a retry after wake
   * re-runs the copy instead (merge/apply is idempotent).
   */
  private async deliverQueued(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    void promise.catch(() => undefined);
    this.deliveryWait = { resolve, reject };
    try {
      await this.transport.sendPending();
      if (this.transport.status().pendingBatches === 0) return;
      await promise;
    } finally {
      this.deliveryWait = null;
    }
  }

  /** Status observer: settles `deliverQueued` waiters, then notifies. */
  private observeDelivery(status: SyncTransportStatus): void {
    const wait = this.deliveryWait;
    if (wait !== null) {
      if (status.pendingBatches === 0) {
        this.deliveryWait = null;
        wait.resolve();
      } else if (status.state === "failed" || status.state === "disabled") {
        this.deliveryWait = null;
        wait.reject(
          new SyncCompositionError(
            "state",
            `initial copy delivery stopped: ${status.note === "" ? status.state : status.note}`,
          ),
        );
      }
    }
    this.opts.onStatus?.(status);
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
      // R008: the acknowledgement frees the one-batch window; pump the
      // rest of the queue NOW (the transport collapses concurrent pump
      // invocations into one) so later batches ride the wire without
      // waiting for a host flush, wake, or reconnect.
      await this.transport.sendPending();
      return;
    }
    if (parsed.data.tag !== "sync-batch") return;
    await this.refresh();
    if (!this.allowedGate) return; // SY-07: sync off means nothing crosses this seam
    const batch = parsed.data as SyncBatchPayload;
    if (batch.snapshot !== undefined &&
      (batch.snapshot.seq > batch.snapshot.chunks || batch.records.some((record) => !("payload" in record))))
      throw new SyncCompositionError("malformed", "invalid copy snapshot chunk");
    // R016: personas riding in THIS batch authorize their photos even
    // before their own rows apply — snapshot order sorts attachment
    // before persona, and admitting the photo needs the ownership answer
    // up front. Only selection + schema validation inside the gate grant
    // it; this seam bypasses nothing.
    const batchPersonas = batch.records.flatMap((record) =>
      record.entityType === "persona" && "payload" in record
        ? [{ entityId: record.entityId, payload: record.payload }]
        : [],
    );
    const accepted: string[] = [];
    for (const record of batch.records) {
      this.admit(record, batchPersonas); // SY-10: no persona-tier rows we never selected enter the store
      this.opts.store.apply(record); // throws unsupported/malformed fail-closed
      accepted.push(record.id);
    }
    // R006: a copy-snapshot chunk also joins the target's pending
    // membership (idempotent under replay/reorder); the replacement waits
    // for every chunk so shared entity ids are never tombstoned blind.
    if (batch.snapshot !== undefined &&
      !findPairSyncPreference(this.rows, this.opts.routeId)?.initialSyncDone)
      await this.recordCopyChunk(batch.snapshot, batch.records);
    await this.opts.sendAck(syncAckPayload(batch.batchId, accepted));
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
    // R016: dependency order — a selected persona must cross BEFORE the
    // photo it references. Snapshot keys sort `attachment/…` before
    // `persona/…`, so an initial copy delivered photo-first (or with the
    // photo in an earlier chunk) and the receiver's gate — which reads
    // local owner state for already-applied rows — failed the whole batch
    // closed, never acked, and stranded every chat behind it.
    const rank = (entityType: string) => (entityType === "persona" ? 0 : entityType === "attachment" ? 1 : 2);
    return this.opts.store
      .snapshot()
      .filter(
        (entry) =>
          entry.row.payload !== null &&
          (isChatTierType(entry.row.entityType) ||
            (gate !== undefined && gate(entry.row.entityType, entry.row.entityId, entry.row.payload))),
      )
      .sort((a, b) => rank(a.row.entityType) - rank(b.row.entityType))
      .map((entry) => this.envelope(entry.row, stamp));
  }

  /**
   * R006: record one chunk of the source's copy snapshot (idempotent under
   * ack-driven replay/reorder). A different snapshot id resets the pending
   * set: the source re-ran its copy after an interrupt, so its newer
   * membership is authoritative and newer partial older chunks must not merge in.
   */
  private async recordCopyChunk(
    snapshot: NonNullable<SyncBatchPayload["snapshot"]>,
    records: SyncBatchPayload["records"],
  ): Promise<void> {
    if (this.copy !== null && snapshot.snapshotId < this.copy.snapshotId) return;
    if (this.copy === null || this.copy.snapshotId !== snapshot.snapshotId)
      this.copy = { snapshotId: snapshot.snapshotId, chunks: snapshot.chunks, applied: new Map() };
    if (this.copy.chunks !== snapshot.chunks)
      throw new SyncCompositionError("malformed", "copy snapshot chunks disagree on their total");
    const members = new Map<string, SyncRecord>();
    for (const record of records)
      if ("payload" in record) members.set(`${record.entityType}/${record.entityId}`, record);
    this.copy.applied.set(snapshot.seq, members);
    const initialCopy = {
      snapshotId: this.copy.snapshotId,
      chunks: this.copy.chunks,
      parts: [...this.copy.applied].map(([seq, part]) => ({ seq, records: [...part.values()] })),
    };
    await this.mutate((rows) => rows.map((row) =>
      row.routeId === this.opts.routeId ? { ...row, initialCopy } : row,
    ));
  }

  /**
   * Target side of copy-* (R006): replace the local set ONLY with the
   * source's delivered membership, and only once every chunk has landed —
   * the old blind replacement tombstoned target rows the source also had
   * (shared entity ids) and source rows that had already arrived, in
   * either delivery order, propagating the loss back to the source. Until
   * the snapshot is complete this throws a retryable state error: an
   * interrupted copy converges on retry and never records completion
   * prematurely (the caller records `initialSyncDone` only after this).
   */
  private finalizeCopy(): void {
    const copy = this.copy;
    if (copy === null || copy.applied.size !== copy.chunks)
      throw new SyncCompositionError(
        "state",
        "initial copy has not been delivered yet; retry once the source has delivered its snapshot",
      );
    const members: SyncRecord[] = [];
    for (const chunk of copy.applied.values()) for (const member of chunk.values()) members.push(member);
    const stamp = this.opts.now();
    const owned = new Set(this.opts.store.snapshot().filter(({ row }) =>
      isChatTierType(row.entityType) ||
      this.opts.personaGate?.(row.entityType, row.entityId, row.payload) === true,
    ).map(({ key }) => key));
    this.opts.store.applyCover(members, this.replacementRevision(stamp), stamp,
      (row) => owned.has(`${row.entityType}/${row.entityId}`));
    this.copy = null;
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
