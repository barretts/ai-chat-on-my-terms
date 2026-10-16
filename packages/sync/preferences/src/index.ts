/**
 * T098A (SY-02, SY-03, SY-07) — per-pair sync opt-in and initial choices.
 *
 * Pure state model for the "Sync chats with Home" switch and the one-time
 * initial choice (copy from iPhone / copy from Home / merge both sides).
 * Rules this module enforces:
 *
 * - No sync data may flow before opt-in AND an explicit initial choice
 *   (`syncDataAllowed` gates every T098C transport queue).
 * - Disabling sync RETAINS both local copies: disabling only stamps the
 *   preference record; it never deletes or rewrites chat data (that data
 *   lives outside this module and is untouched by design).
 * - Re-enabling after a disable keeps the previous choice and history, so
 *   the initial copy/merge is not repeated and state survives restarts
 *   (preferences persist through the vault port).
 */
import { EntityIdSchema, IsoTimestampSchema } from "@locallab/contracts/identity";
import { SyncRecordSchema } from "@locallab/contracts/entities";
import { z } from "zod";

export const SYNC_CHOICES = ["copy-phone", "copy-mac", "merge"] as const;
export type SyncChoice = (typeof SYNC_CHOICES)[number];

export const SyncPreferenceRecordSchema = z
  .object({
    routeId: EntityIdSchema,
    enabled: z.boolean(),
    choice: z.enum(SYNC_CHOICES).nullable(),
    initialSyncDone: z.boolean(),
    initialCopy: z.object({
      snapshotId: EntityIdSchema,
      chunks: z.number().int().min(1).max(500),
      parts: z.array(z.object({
        seq: z.number().int().min(1).max(500),
        records: z.array(SyncRecordSchema).max(500),
      }).strict()).max(500),
    }).strict().refine((copy) =>
      copy.parts.every((part) => part.seq <= copy.chunks) &&
      new Set(copy.parts.map((part) => part.seq)).size === copy.parts.length,
    "invalid copy snapshot chunk sequence").optional(),
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type PairSyncPreference = z.infer<typeof SyncPreferenceRecordSchema>;

export interface SyncPreferenceVault {
  load(): Promise<readonly PairSyncPreference[]>;
  save(records: readonly PairSyncPreference[]): Promise<void>;
}

export class SyncPreferenceError extends Error {
  readonly kind: "malformed" | "state";
  constructor(kind: "malformed" | "state", message: string) {
    super(message);
    this.kind = kind;
    this.name = "SyncPreferenceError";
  }
}

/** Validated re-hydration of persisted rows; corrupt vaults fail closed. */
export function parseSyncPreferenceRecords(rows: unknown): PairSyncPreference[] {
  const parsed = z.array(SyncPreferenceRecordSchema).safeParse(rows);
  if (!parsed.success)
    throw new SyncPreferenceError("malformed", "stored sync preferences are corrupt");
  return parsed.data;
}

export function findPairSyncPreference(
  records: readonly PairSyncPreference[],
  routeId: string,
): PairSyncPreference | null {
  return records.find((record) => record.routeId === routeId) ?? null;
}

export function optInPairSync(
  records: readonly PairSyncPreference[],
  routeId: string,
  now: string,
): PairSyncPreference[] {
  const existing = findPairSyncPreference(records, routeId);
  const next: PairSyncPreference = existing
    ? { ...existing, enabled: true, updatedAt: now }
    : { routeId, enabled: true, choice: null, initialSyncDone: false, updatedAt: now };
  return [...records.filter((record) => record.routeId !== routeId), next];
}

/**
 * SY-07: flipping sync off changes only this preference row. Local chats on
 * either side are owned by the conversation store and are never deleted by
 * any operation in this module.
 */
export function optOutPairSync(
  records: readonly PairSyncPreference[],
  routeId: string,
  now: string,
): PairSyncPreference[] {
  const existing = findPairSyncPreference(records, routeId);
  if (existing === null)
    throw new SyncPreferenceError("state", "cannot disable sync for a pair that was never enabled");
  const next: PairSyncPreference = {
    ...existing,
    enabled: false,
    // choice + initialSyncDone intentionally retained for re-enable.
    updatedAt: now,
  };
  return [...records.filter((record) => record.routeId !== routeId), next];
}

/** The pairing-time / first-open choice: copy one side or merge both. */
export function setInitialSyncChoice(
  records: readonly PairSyncPreference[],
  routeId: string,
  choice: SyncChoice,
  now: string,
): PairSyncPreference[] {
  const existing = findPairSyncPreference(records, routeId);
  if (existing === null)
    throw new SyncPreferenceError("state", "opt in to sync before choosing an initial mode");
  if (existing.initialSyncDone)
    throw new SyncPreferenceError("state", "the initial sync choice is already recorded");
  const next: PairSyncPreference = { ...existing, choice, updatedAt: now };
  if (existing.choice !== choice) delete next.initialCopy;
  return [...records.filter((record) => record.routeId !== routeId), next];
}

export function completeInitialSync(
  records: readonly PairSyncPreference[],
  routeId: string,
  now: string,
): PairSyncPreference[] {
  const existing = findPairSyncPreference(records, routeId);
  if (existing === null || existing.choice === null)
    throw new SyncPreferenceError("state", "choose an initial sync mode before completing it");
  const { initialCopy: _initialCopy, ...retained } = existing;
  const next: PairSyncPreference = { ...retained, initialSyncDone: true, updatedAt: now };
  return [...records.filter((record) => record.routeId !== routeId), next];
}

/**
 * The single gate every sync transport consults (SY-02): nothing may be
 * queued, encrypted or sent for a pair that has not opted in and made its
 * initial choice.
 */
export function syncDataAllowed(
  records: readonly PairSyncPreference[],
  routeId: string,
): boolean {
  const existing = findPairSyncPreference(records, routeId);
  return existing !== null && existing.enabled && existing.choice !== null;
}

export function needsInitialSyncChoice(
  records: readonly PairSyncPreference[],
  routeId: string,
): boolean {
  const existing = findPairSyncPreference(records, routeId);
  return existing !== null && existing.enabled && existing.choice === null;
}

export function syncChoiceLabel(choice: SyncChoice | null): string {
  switch (choice) {
    case "copy-phone":
      return "Chats copied from this iPhone";
    case "copy-mac":
      return "Chats copied from the Home Mac";
    case "merge":
      return "Both chat sets merged";
    case null:
      return "No initial choice yet";
  }
}

export interface SyncPreferenceRow {
  routeId: string;
  label: string;
  enabled: boolean;
  choiceLabel: string;
  initialSyncDone: boolean;
  needsChoice: boolean;
}

export function syncPreferenceViews(
  records: readonly PairSyncPreference[],
  pairings: readonly { routeId: string; label: string }[],
): SyncPreferenceRow[] {
  return pairings.map((pairing) => {
    const preference = findPairSyncPreference(records, pairing.routeId);
    return {
      routeId: pairing.routeId,
      label: pairing.label,
      enabled: preference?.enabled ?? false,
      choiceLabel: syncChoiceLabel(preference?.choice ?? null),
      initialSyncDone: preference?.initialSyncDone ?? false,
      needsChoice: needsInitialSyncChoice(records, pairing.routeId),
    };
  });
}
