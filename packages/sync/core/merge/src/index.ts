/**
 * T098B (SY-04, SY-05, SY-06) — deterministic revision merge for the sync
 * chat set: conversations, messages and folders plus their tombstones.
 *
 * Invariants this module guarantees:
 *
 * - Stable IDs are never rewritten: a record's `id` (assigned before
 *   enqueue) and `entityId` survive every merge path verbatim.
 * - Ordering is the frozen revision tuple (wallMs, counter, deviceId)
 *   via `compareRevision`; applying any permutation or duplication of the
 *   same batch converges every store to the same state.
 * - At an EQUAL revision a tombstone always beats an update: an entity
 *   deleted with the same revision as a competing edit stays deleted.
 * - Equal revision with equal identity but different payloads is a real
 *   conflict: winner is the smaller canonical-payload digest (order
 *   independent), and the conflict is reported for the UI, never fixed by
 *   inventing a new revision or ID.
 * - Only allowlisted entity types sync; everything else is rejected
 *   (`kind: "unsupported"`), which is how settings/credentials/model
 *   records stay out of envelopes.
 * - Folder covers (copy/replace semantics) are content-addressed by a
 *   canonical digest of their member set, so a replayed cover is exact
 *   and idempotent, and entities removed by a cover stay removed
 *   (tombstoned at the cover revision) across reconnects.
 */
import {
  ConversationSchema,
  FolderSchema,
  MessageSchema,
  SyncRecordSchema,
  TombstoneSchema,
} from "@locallab/contracts/entities";
import { compareRevision } from "@locallab/contracts/identity";
import type { EntityId, Revision } from "@locallab/contracts/identity";
import { z } from "zod";

export class SyncMergeError extends Error {
  readonly kind: "unsupported" | "malformed";
  constructor(kind: "unsupported" | "malformed", message: string) {
    super(message);
    this.kind = kind;
    this.name = "SyncMergeError";
  }
}

export type SyncRecord = z.infer<typeof SyncRecordSchema>;
type Tombstone = z.infer<typeof TombstoneSchema>;
export type SyncChange = SyncRecord | Tombstone;

/** Allowlist for syncable chat entities (SY-01 scope; T098 composition relies on it). */
const PAYLOAD_SCHEMAS: Record<string, z.ZodType> = {
  conversation: ConversationSchema,
  message: MessageSchema,
  folder: FolderSchema,
};

/** True when an entity type belongs to the always-syncable chat tier. */
export function isChatTierType(entityType: string): boolean {
  return PAYLOAD_SCHEMAS[entityType] !== undefined;
}

export function isTombstone(change: SyncChange): boolean {
  return !("payload" in change);
}

export function mergeKey(change: { entityType: string; entityId: string }): string {
  return `${change.entityType}/${change.entityId}`;
}

/** Deterministic JSON with sorted object keys (arrays keep order). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

/**
 * FNV-1a 64-bit content digest. Not a trust boundary (envelope integrity
 * lives in the sealed transport); it content-addresses covers and decides
 * equal-revision conflicts deterministically without clocks or IDs.
 */
export function contentDigest(value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  for (const ch of canonicalJson(value))
    hash = ((hash ^ BigInt(ch.codePointAt(0)!)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
}

function parseChange(change: unknown): SyncChange {
  const tombstone = TombstoneSchema.safeParse(change);
  if (tombstone.success) return tombstone.data;
  const record = SyncRecordSchema.safeParse(change);
  if (record.success) return record.data;
  throw new SyncMergeError("malformed", "sync change does not match the record or tombstone shape");
}

function validatePayload(entityType: string, payload: unknown): void {
  const schema = PAYLOAD_SCHEMAS[entityType];
  if (schema === undefined)
    throw new SyncMergeError("unsupported", `entity type ${entityType} never syncs`);
  if (!schema.safeParse(payload).success)
    throw new SyncMergeError("malformed", `payload for ${entityType} is invalid`);
}

/**
 * Fail-closed admission gate for senders: runs the same parse + entity
 * allowlist as apply() WITHOUT touching any state, so excluded records are
 * rejected before they ever reach a transport queue or an envelope.
 */
export function assertChangeAllowed(change: unknown): void {
  const parsed = parseChange(change);
  if (!("payload" in parsed)) {
    if (PAYLOAD_SCHEMAS[parsed.entityType] === undefined)
      throw new SyncMergeError("unsupported", `entity type ${parsed.entityType} never syncs`);
    return;
  }
  validatePayload(parsed.entityType, parsed.payload);
}
export interface MergeStateRow {
  entityType: string;
  entityId: EntityId;
  /** Stable sync-record id kept verbatim from the winning change. */
  recordId: EntityId;
  revision: Revision;
  /** null marks a tombstone (entity deleted, identity retained). */
  payload: unknown | null;
}

export interface MergeConflict {
  entityType: string;
  entityId: EntityId;
  revision: Revision;
  winnerRecordId: EntityId;
  loserRecordId: EntityId;
}

export type MergeEffect = "applied" | "superseded" | "duplicate" | "conflict";

export class MergeStore {
  private rows = new Map<string, MergeStateRow>();
  private conflictList: MergeConflict[] = [];

  /**
   * `extraTypes` opts an ADDITIONAL tier into validation (T099 persona
   * tier). Chat-tier admission rules (assertChangeAllowed) never consult
   * it; the caller enforces per-pair selection BEFORE enqueue/receive.
   */
  constructor(private extraTypes: Record<string, z.ZodType> = {}) {}

  private allowedType(entityType: string): boolean {
    return PAYLOAD_SCHEMAS[entityType] !== undefined || this.extraTypes[entityType] !== undefined;
  }

  private validatePayload(entityType: string, payload: unknown): void {
    const schema = PAYLOAD_SCHEMAS[entityType] ?? this.extraTypes[entityType];
    if (schema === undefined)
      throw new SyncMergeError("unsupported", `entity type ${entityType} never syncs`);
    if (!schema.safeParse(payload).success)
      throw new SyncMergeError("malformed", `payload for ${entityType} is invalid`);
  }

  apply(change: unknown): MergeEffect {
    const parsed = parseChange(change);
    if (!("payload" in parsed)) {
      if (!this.allowedType(parsed.entityType))
        throw new SyncMergeError("unsupported", `entity type ${parsed.entityType} never syncs`);
      return this.applyTombstone(parsed);
    }
    this.validatePayload(parsed.entityType, parsed.payload);
    return this.applyRecord(parsed);
  }

  applyBatch(changes: readonly unknown[]): MergeEffect[] {
    return changes.map((change) => this.apply(change));
  }

  /**
   * R006 (T098B/T098): initial-copy replacement boundary. `members` is the
   * source's delivered membership: members win OUTRIGHT — they are written
   * at cover revision `at`, superseding target rows with newer revisions
   * for the same keys (copy semantics: the target's data was replaced by
   * the user's choice). Live rows absent from membership are tombstoned
   * at `at` — only rows the source does not have are deleted, so a shared
   * entity id can never be lost, and replays of pre-cover updates (always
   * revision-older than `at`) can never resurrect deleted entities.
   * Out-of-tier rows are left untouched (SY-03): they never entered the
   * store through sync and the copy does not own them. Validation is
   * fail-closed BEFORE any mutation; re-applying the same cover is
   * idempotent (rows are re-set, no tombstone touches a member).
   */
  applyCover(members: readonly SyncRecord[], at: Revision, stamp: string): string[] {
    for (const member of members) this.validatePayload(member.entityType, member.payload);
    const covered = new Set<string>();
    for (const member of members) {
      const key = mergeKey(member);
      this.rows.set(key, rowOf({ ...member, revision: at }, member.payload));
      covered.add(key);
    }
    const removed: string[] = [];
    for (const { key, row } of this.snapshot()) {
      if (row.payload === null || covered.has(key) || !this.allowedType(row.entityType)) continue;
      const [entityType, entityId] = key.split("/") as [string, EntityId];
      this.rows.set(key, rowOf({ id: entityId, entityType, entityId, revision: at }, null));
      removed.push(key);
    }
    return removed;
  }

  private applyRecord(record: SyncRecord): MergeEffect {
    const key = mergeKey(record);
    const existing = this.rows.get(key);
    if (existing === undefined) {
      this.rows.set(key, rowOf(record, record.payload));
      return "applied";
    }
    const cmp = compareRevision(record.revision, existing.revision);
    if (cmp < 0) return "superseded";
    if (cmp > 0) {
      this.rows.set(key, rowOf(record, record.payload));
      return "applied";
    }
    // Equal revision.
    if (existing.payload === null)
      return "superseded"; // equal revision: the stored tombstone beats an update (SY-06)
    if (contentDigest(existing.payload) === contentDigest(record.payload)) {
      if (existing.recordId === record.id) return "duplicate";
      this.rows.set(key, rowOf(record, record.payload));
      return "duplicate";
    }
    // Divergent payloads at the same revision: deterministic winner.
    const incomingWins = contentDigest(record.payload) < contentDigest(existing.payload);
    const conflict: MergeConflict = {
      entityType: record.entityType,
      entityId: record.entityId,
      revision: record.revision,
      winnerRecordId: incomingWins ? record.id : existing.recordId,
      loserRecordId: incomingWins ? existing.recordId : record.id,
    };
    this.conflictList.push(conflict);
    if (incomingWins) this.rows.set(key, rowOf(record, record.payload));
    return "conflict";
  }

  private applyTombstone(tombstone: Tombstone): MergeEffect {
    const key = mergeKey(tombstone);
    const existing = this.rows.get(key);
    if (existing === undefined) {
      this.rows.set(key, rowOf(tombstone, null));
      return "applied";
    }
    const cmp = compareRevision(tombstone.revision, existing.revision);
    if (cmp < 0) return "superseded";
    if (cmp > 0) {
      this.rows.set(key, rowOf(tombstone, null));
      return "applied";
    }
    // Equal revision: tombstone ALWAYS beats an update (SY-06 delete precedence),
    // and a matching tombstone is a duplicate.
    if (existing.payload === null) return "duplicate";
    this.rows.set(key, rowOf(tombstone, null));
    return "applied";
  }

  /** Live (non-tombstoned) rows keyed, sorted — order independent. */
  snapshot(): { key: string; row: MergeStateRow }[] {
    return [...this.rows.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, row]) => ({ key, row }));
  }

  liveCount(): number {
    return [...this.rows.values()].filter((row) => row.payload !== null).length;
  }

  rowFor(entityType: string, entityId: string): MergeStateRow | null {
    return this.rows.get(`${entityType}/${entityId}`) ?? null;
  }

  conflicts(): readonly MergeConflict[] {
    return this.conflictList;
  }
}

function rowOf(
  change: { id: EntityId; entityType: string; entityId: string; revision: Revision },
  payload: unknown | null,
): MergeStateRow {
  return {
    entityType: change.entityType,
    entityId: change.entityId,
    recordId: change.id,
    revision: change.revision,
    payload,
  };
}

/**
 * Content-addressed folder covers (SY-05). `stage` dedups by content:
 * identical member sets always produce the same digest, and applying a
 * cover replaces the live set — members win outright (copy semantics),
 * live rows they do not contain are tombstoned at the cover revision, so
 * replays of pre-cover batches can never resurrect deleted entities.
 */
export class CoverStager {
  private covers = new Map<string, SyncRecord[]>();

  stage(records: readonly unknown[]): string {
    const members: SyncRecord[] = [];
    for (const raw of records) {
      const parsed = parseChange(raw);
      if (!("payload" in parsed))
        throw new SyncMergeError("malformed", "covers stage live records only; deletions are represented by their absence");
      validatePayload(parsed.entityType, parsed.payload);
      members.push(parsed);
    }
    if (members.length === 0)
      throw new SyncMergeError("malformed", "cannot stage an empty cover");
    const sorted = [...members].sort((a, b) =>
      mergeKey(a) === mergeKey(b)
        ? compareRevision(a.revision, b.revision)
        : mergeKey(a).localeCompare(mergeKey(b)),
    );
    // One row per entity key, newest revision wins; duplicates collapse.
    const deduped: SyncRecord[] = [];
    for (const member of sorted) {
      const last = deduped[deduped.length - 1];
      if (last !== undefined && mergeKey(last) === mergeKey(member))
        deduped[deduped.length - 1] = member;
      else deduped.push(member);
    }
    const digest = contentDigest(
      deduped.map((m) => ({
        entityType: m.entityType,
        entityId: m.entityId,
        revision: m.revision,
        payload: m.payload,
      })),
    );
    if (!this.covers.has(digest)) this.covers.set(digest, deduped);
    return digest;
  }

  members(digest: string): readonly SyncRecord[] {
    return this.covers.get(digest) ?? [];
  }

  coverDigests(): readonly string[] {
    return [...this.covers.keys()];
  }

  /**
   * Apply cover to `store`; returns keys tombstoned to enforce the replace.
   * `at` is the cover revision (must be newer than every local revision —
   * composition stamps it at choice wall time) and `stamp` the ISO used
   * for synthesized tombstones.
   */
  applyCover(store: MergeStore, digest: string, at: Revision, stamp: string): string[] {
    const members = this.covers.get(digest);
    if (members === undefined)
      throw new SyncMergeError("malformed", `cover ${digest} is not staged`);
    for (const member of members) store.apply(member);
    const covered = new Set(members.map(mergeKey));
    const removed: string[] = [];
    for (const entry of store.snapshot()) {
      if (entry.row.payload !== null && !covered.has(entry.key)) {
        const [entityType, entityId] = entry.key.split("/");
        store.apply({
          // Deterministic tombstone id: the removed entity's stable
          // entityId, so replays of the same cover collapse to one row.
          id: entityId as EntityId,
          createdAt: stamp,
          updatedAt: stamp,
          revision: at,
          entityType: entityType!,
          entityId: entityId as EntityId,
        });
        removed.push(entry.key);
      }
    }
    return removed;
  }
}

