import { z } from "zod";

export const EntityIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Expected a UUIDv7 identifier",
  );
export type EntityId = z.infer<typeof EntityIdSchema>;

export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export const RevisionSchema = z
  .object({
    wallMs: z.number().int().nonnegative(),
    counter: z.number().int().nonnegative(),
    deviceId: EntityIdSchema,
  })
  .strict();
export type Revision = z.infer<typeof RevisionSchema>;

export const EntityBaseSchema = z
  .object({
    id: EntityIdSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    revision: RevisionSchema,
  })
  .strict();

export function compareRevision(left: Revision, right: Revision): number {
  if (left.wallMs !== right.wallMs) return left.wallMs < right.wallMs ? -1 : 1;
  if (left.counter !== right.counter)
    return left.counter < right.counter ? -1 : 1;
  return left.deviceId.localeCompare(right.deviceId);
}
