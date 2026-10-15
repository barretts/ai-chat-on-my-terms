/**
 * T100 (SY-09) — iCloud sync adapter for the sync store.
 *
 * Same entity/tombstone rules as the project relay (SY-04..SY-08: full
 * rows, HLC revisions, tombstones stay deletions), but a DIFFERENT
 * transport: CloudKit's private container (per Apple ID), pull/push with
 * a server cursor instead of a point-to-point batch/ack exchange. The
 * two transports may run at the same time, so every applied revision is
 * tracked by its cross-transport identity (`wall:counter:deviceId`): a
 * revision this device already saved or already pulled from iCloud is
 * NEVER saved again — no cloud→device→cloud echo, and replays are
 * idempotent against MergeStore's HLC no-ops.
 */
import type { EntityId, Revision } from "@locallab/contracts/identity";
import { compareRevision } from "@locallab/contracts/identity";
import type {
  ICloudAccountStatus,
  ICloudBridge,
  ICloudRecord,
} from "@locallab/icloud";
import { ICloudError, parseICloudPage, parseICloudRecords } from "@locallab/icloud";
import type { MergeStateRow, MergeStore } from "@locallab/sync-merge";

/** Cross-transport identity of one change (SY-09 echo prevention). */
export function revisionKey(revision: Revision): string {
  return `${revision.wallMs}:${revision.counter}:${revision.deviceId}`;
}

interface QueuedRow {
  entityType: string;
  entityId: string;
  revision: Revision;
  payload: unknown | null;
}

export function toIcloudRecord(row: QueuedRow, assetSha256: string | null, updatedAt: string): ICloudRecord {
  return {
    recordName: `${row.entityType}:${row.entityId}`,
    entityType: row.entityType,
    entityId: row.entityId,
    revision: row.revision,
    payload: row.payload,
    assetSha256,
    updatedAt,
  };
}

/** Map a cloud record back onto the sync wire (payload null = tombstone). */
export function toSyncChange(record: ICloudRecord): Record<string, unknown> {
  const envelope = {
    entityType: record.entityType,
    entityId: record.entityId,
    // Stable per-entity sync-record identity shared across transports.
    id: record.entityId,
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
  };
  return record.payload === null ? envelope : { ...envelope, payload: record.payload, acknowledgedAt: null };
}

export interface IcloudSyncAdapterConfig {
  selfDeviceId: EntityId;
  store: MergeStore;
  bridge: ICloudBridge;
  now: () => string;
  maxBatch?: number;
  /** Host blob store: bytes for a photo row this device uploaded/pulled. */
  assetSource?: (sha256: string) => Promise<Uint8Array | null>;
  assetSink?: (entityId: string, sha256: string, bytes: Uint8Array) => Promise<void>;
}

export type IcloudSyncStatus =
  | { state: "off" }
  | { state: "unavailable"; account: ICloudAccountStatus }
  | { state: "ready"; pendingUploads: number };

export class IcloudSyncAdapter {
  private readonly cfg: IcloudSyncAdapterConfig;
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, QueuedRow>();
  private cursor = "";
  private enabled = false;
  private lastError: string | null = null;

  constructor(cfg: IcloudSyncAdapterConfig) {
    this.cfg = cfg;
  }

  /** Explicit opt-in only (privacy row: iCloud sync is never automatic). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.lastError = null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  failureNote(): string | null {
    return this.lastError;
  }

  async status(): Promise<IcloudSyncStatus> {
    if (!this.enabled) return { state: "off" };
    const account = await this.cfg.bridge.accountStatus();
    if (account !== "available") return { state: "unavailable", account };
    return { state: "ready", pendingUploads: this.pending.size };
  }

  /**
   * Host calls this for every locally-applied store change (user edits
   * AND relay-delivered rows). Revisions this device already pushed or
   * already pulled from iCloud are skipped — that is the echo guard
   * against the relay transport running simultaneously.
   */
  noteLocalChange(changes: readonly unknown[]): number {
    let queued = 0;
    for (const change of changes) {
      const row = this.asRow(change);
      if (row === null) continue;
      const key = revisionKey(row.revision);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.pending.set(`${row.entityType}:${row.entityId}`, row);
      queued += 1;
    }
    return queued;
  }

  /** Publish everything locally-originated since the last pass. */
  async publish(): Promise<number> {
    if (!this.enabled) return 0;
    await this.requireAccount();
    const batch = this.cfg.maxBatch ?? 200;
    let saved = 0;
    while (this.pending.size > 0) {
      const chunk = [...this.pending.values()].slice(0, batch);
      const records: ICloudRecord[] = [];
      for (const row of chunk) {
        const sha256 = this.assetSha256Of(row);
        if (sha256 !== null && this.cfg.assetSource !== undefined) {
          const bytes = await this.cfg.assetSource(sha256);
          if (bytes === null) throw new ICloudError("transport", `missing asset bytes for ${sha256}`);
          await this.cfg.bridge.saveAsset(sha256, bytes);
        }
        records.push(toIcloudRecord(row, sha256, this.cfg.now()));
      }
      await this.cfg.bridge.saveRecords(records);
      for (const row of chunk) {
        // R022: `saveRecords` awaited the cloud while a newer local edit
        // may have replaced this queue entry. Only settle an entry that
        // still IS the uploaded revision; never drop newer pending work.
        // (This same revision check makes an overlapping second publish
        // pass inert, and after a restart the host's stageAllLocalRows
        // re-stages every live row, so nothing is lost either way.)
        const key = `${row.entityType}:${row.entityId}`;
        const current = this.pending.get(key);
        if (current !== undefined && revisionKey(current.revision) === revisionKey(row.revision))
          this.pending.delete(key);
      }
      saved += chunk.length;
      if (chunk.length < batch) break;
    }
    return saved;
  }

  /** Pull every cloud change since the cursor, converge, drain assets. */
  async fetch(): Promise<number> {
    if (!this.enabled) return 0;
    await this.requireAccount();
    const batch = this.cfg.maxBatch ?? 200;
    let applied = 0;
    let more = true;
    while (more) {
      const page = parseICloudPage(await this.cfg.bridge.fetchChanges(this.cursor, batch));
      const effects = this.cfg.store.applyBatch(page.records.map(toSyncChange));
      page.records.forEach((record, i) => {
        const effect = effects[i];
        const crossed = effect === "applied" || effect === "conflict" || effect === "superseded";
        const current = this.pending.get(record.recordName);
        // R022: a crossed cloud record settles a pending entry ONLY when
        // it subsumes it (same or newer revision). A newer unsent local
        // edit that merely superseded this stale cloud copy must stay
        // queued, or the newest edit would never reach the cloud.
        if (crossed && current !== undefined && compareRevision(current.revision, record.revision) <= 0)
          this.pending.delete(record.recordName);
        this.seen.add(revisionKey(record.revision));
        applied += crossed ? 1 : 0;
      });
      for (const record of page.records) {
        if (record.assetSha256 !== null && this.cfg.assetSink !== undefined) {
          const bytes = await this.cfg.bridge.fetchAsset(record.assetSha256);
          if (bytes !== null) await this.cfg.assetSink(record.entityId, record.assetSha256, bytes);
        }
      }
      this.cursor = page.cursor;
      more = page.more;
    }
    return applied;
  }

  /** One publish+pull pass; returns { pushed, pulled }. */
  async syncOnce(): Promise<{ pushed: number; pulled: number }> {
    try {
      const pushed = await this.publish();
      const pulled = await this.fetch();
      this.lastError = null;
      return { pushed, pulled };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "iCloud sync failed";
      throw error;
    }
  }

  /** Initial-copy semantics: stage all live rows (gated by opt-in only). */
  stageAllLocalRows(): number {
    return this.noteLocalChange(this.cfg.store.snapshot().map((entry) => entry.row));
  }

  private async requireAccount(): Promise<void> {
    const account = await this.cfg.bridge.accountStatus();
    if (account !== "available") {
      throw new ICloudError("account", `iCloud account status: ${account}`);
    }
  }

  private assetSha256Of(row: QueuedRow): string | null {
    if (row.entityType !== "attachment" || row.payload === null) return null;
    const payload = row.payload as { sha256?: unknown };
    return typeof payload.sha256 === "string" ? payload.sha256 : null;
  }

  private asRow(change: unknown): QueuedRow | null {
    if (typeof change !== "object" || change === null) return null;
    const fields = change as Record<string, unknown>;
    if (
      typeof fields.entityType !== "string" ||
      typeof fields.entityId !== "string" ||
      typeof fields.revision !== "object" ||
      fields.revision === null
    ) {
      return null;
    }
    const revision = fields.revision as Record<string, unknown>;
    if (
      typeof revision.wallMs !== "number" ||
      typeof revision.counter !== "number" ||
      typeof revision.deviceId !== "string"
    ) {
      return null;
    }
    const typed: Revision = {
      wallMs: revision.wallMs,
      counter: revision.counter,
      deviceId: revision.deviceId as EntityId,
    };
    // Same row edited twice before a publish: only the HLC winner rides.
    const pending = this.pending.get(`${fields.entityType}:${fields.entityId}`);
    if (pending !== undefined && compareRevision(pending.revision, typed) >= 0) {
      return null;
    }
    return {
      entityType: fields.entityType,
      entityId: fields.entityId,
      revision: typed,
      payload: "payload" in fields ? fields.payload ?? null : null,
    };
  }
}

export { ICloudError, parseICloudRecords };
export type { ICloudAccountStatus, ICloudBridge, ICloudRecord, MergeStateRow };
