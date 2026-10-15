/**
 * T100 (SY-09) — Apple iCloud data synchronization bridge.
 *
 * The native CloudKit private-container call is Apple-only and lands with
 * the real-device milestone (T159D); this module fixes the EXACT contract
 * that the Apple build implements, so sync logic, tests and the Windows
 * workstation all agree on the shape. Nothing here talks to CloudKit on
 * non-Apple platforms — `accountStatus()` is the single source of truth
 * for availability, and sync stays OFF until it answers "available" AND
 * the user opted in (explicit, per the privacy policy row).
 */
import { z } from "zod";
import { EntityIdSchema } from "@locallab/contracts/identity";

/** CloudKit account states mirrored from CKContainer.accountStatus(). */
export const ICloudAccountStatusSchema = z.enum([
  "available",
  "noAccount",
  "restricted",
  "temporarilyUnavailable",
  "couldNotComplete",
]);
export type ICloudAccountStatus = z.infer<typeof ICloudAccountStatusSchema>;

/** Human copy for the Settings row, keyed by account state. */
export const ICloudAccountNotes: Record<ICloudAccountStatus, string> = {
  available: "iCloud is available. Sync stays off until you turn it on below.",
  noAccount: "No iCloud account on this device. Sign in in system Settings to use iCloud sync.",
  restricted: "iCloud is restricted for this account (family/MDM policy).",
  temporarilyUnavailable: "iCloud is temporarily unreachable. Try again later.",
  couldNotComplete: "iCloud could not be reached. Check the network and try again.",
};

/** HLC triple exactly as sync-merge defines it (cross-transport identity). */
export const ICloudRevisionSchema = z.object({
  wallMs: z.number().int().nonnegative(),
  counter: z.number().int().nonnegative(),
  deviceId: EntityIdSchema,
});
export type ICloudRevision = z.infer<typeof ICloudRevisionSchema>;

/**
 * One entity row in the private container. `payload === null` is the
 * tombstone (SY-06 deletes propagate as deletions). recordName is the
 * stable `entityType:entityId` key CloudKit uses for per-field merge.
 */
export const ICloudRecordSchema = z.object({
  recordName: z.string().min(3),
  entityType: z.string().min(1),
  entityId: EntityIdSchema,
  revision: ICloudRevisionSchema,
  payload: z.unknown().nullable(),
  assetSha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable().default(null),
  updatedAt: z.string().datetime(),
});
export type ICloudRecord = z.infer<typeof ICloudRecordSchema>;

export const ICloudChangePageSchema = z.object({
  records: z.array(ICloudRecordSchema),
  cursor: z.string().min(1),
  /** True when more pages are pending behind `cursor`. */
  more: z.boolean(),
});
export type ICloudChangePage = z.infer<typeof ICloudChangePageSchema>;

export class ICloudError extends Error {
  constructor(
    readonly kind: "account" | "transport" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "ICloudError";
  }
}

/**
 * The native side implemented by Apple builds (CloudKit private database
 * in an app container — Apple never sees plaintext, per the privacy row).
 * Assets are content-addressed by sha256 so two transports can never
 * disagree about which bytes a photo row means.
 */
export interface ICloudBridge {
  accountStatus(): Promise<ICloudAccountStatus>;
  fetchChanges(cursor: string, limit: number): Promise<ICloudChangePage>;
  saveRecords(records: readonly ICloudRecord[]): Promise<void>;
  saveAsset(sha256: string, bytes: Uint8Array): Promise<void>;
  fetchAsset(sha256: string): Promise<Uint8Array | null>;
}

export function parseICloudPage(raw: unknown): ICloudChangePage {
  const parsed = ICloudChangePageSchema.safeParse(raw);
  if (!parsed.success) throw new ICloudError("malformed", "iCloud change page failed validation");
  return parsed.data;
}

export function parseICloudRecords(raw: readonly unknown[]): ICloudRecord[] {
  const records: ICloudRecord[] = [];
  for (const entry of raw) {
    const parsed = ICloudRecordSchema.safeParse(entry);
    if (!parsed.success) throw new ICloudError("malformed", "iCloud record failed validation");
    records.push(parsed.data);
  }
  return records;
}

export const recordKey = (recordName: string): { entityType: string; entityId: string } | null => {
  const split = recordName.indexOf(":");
  if (split <= 0 || split === recordName.length - 1) return null;
  return { entityType: recordName.slice(0, split), entityId: recordName.slice(split + 1) };
};
