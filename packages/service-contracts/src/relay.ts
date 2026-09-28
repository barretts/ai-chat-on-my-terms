import { z } from "zod";
import { EntityIdSchema } from "@locallab/contracts/identity";
import { RunEventSchema } from "@locallab/contracts/run-events";
import {
  SyncRecordSchema,
  TombstoneSchema,
} from "@locallab/contracts/entities";

export const MAX_RELAY_FRAME_BYTES = 1_048_576;
export const MAX_MEDIA_CHUNK_BYTES = 262_144;
export const MAX_SYNC_RECORDS_PER_BATCH = 500;
export const RelayContentTagSchema = z.enum([
  "request",
  "event",
  "cancel",
  "binary-start",
  "binary-chunk",
  "binary-end",
  "sync-batch",
  "sync-ack",
  "health",
  "close",
]);

export const EncryptedPayloadSchema = z.discriminatedUnion("tag", [
  z.object({ tag: z.literal("request"), body: z.unknown() }).strict(),
  z.object({ tag: z.literal("event"), event: RunEventSchema }).strict(),
  z
    .object({
      tag: z.literal("cancel"),
      reason: z.string().max(256).optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal("binary-start"),
      transferId: EntityIdSchema,
      mimeType: z.string().min(1).max(128),
      length: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    })
    .strict(),
  z
    .object({
      tag: z.literal("binary-chunk"),
      transferId: EntityIdSchema,
      index: z.number().int().nonnegative(),
      bytesBase64Url: z
        .string()
        .min(1)
        .max(Math.ceil((MAX_MEDIA_CHUNK_BYTES * 4) / 3)),
    })
    .strict(),
  z
    .object({ tag: z.literal("binary-end"), transferId: EntityIdSchema })
    .strict(),
  z
    .object({
      tag: z.literal("sync-batch"),
      records: z
        .array(z.union([SyncRecordSchema, TombstoneSchema]))
        .max(MAX_SYNC_RECORDS_PER_BATCH),
    })
    .strict(),
  z
    .object({
      tag: z.literal("sync-ack"),
      recordIds: z.array(EntityIdSchema).max(MAX_SYNC_RECORDS_PER_BATCH),
    })
    .strict(),
  z
    .object({ tag: z.literal("health"), nonce: z.string().min(16).max(128) })
    .strict(),
  z
    .object({ tag: z.literal("close"), reason: z.string().max(256).optional() })
    .strict(),
]);
export type EncryptedPayload = z.infer<typeof EncryptedPayloadSchema>;

export const EncryptedRelayFrameV1Schema = z
  .object({
    protocol: z
      .object({ major: z.literal(1), minor: z.number().int().nonnegative() })
      .strict(),
    routeId: EntityIdSchema,
    requestId: EntityIdSchema,
    sequence: z.number().int().nonnegative(),
    nonceBase64Url: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    contentTag: RelayContentTagSchema,
    declaredSize: z.number().int().nonnegative().max(MAX_RELAY_FRAME_BYTES),
    ciphertextBase64Url: z
      .string()
      .min(22)
      .max(Math.ceil((MAX_RELAY_FRAME_BYTES * 4) / 3)),
  })
  .strict();
export type EncryptedRelayFrameV1 = z.infer<typeof EncryptedRelayFrameV1Schema>;

export function validateRelayFrameSize(frame: EncryptedRelayFrameV1): void {
  const ciphertextBytes = Math.floor(
    (frame.ciphertextBase64Url.length * 3) / 4,
  );
  if (ciphertextBytes > MAX_RELAY_FRAME_BYTES)
    throw new Error("Relay ciphertext exceeds the frame byte limit");
  if (frame.declaredSize !== ciphertextBytes)
    throw new Error("Relay declared size does not match ciphertext length");
}
