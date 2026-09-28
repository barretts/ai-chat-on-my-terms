import { z } from "zod";
import {
  EntityIdSchema,
  IsoTimestampSchema,
} from "@locallab/contracts/identity";

export const SearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
export const SearchResultSchema = z
  .object({
    title: z.string().max(512),
    url: z.string().url(),
    snippet: z.string().max(4096),
    source: z.string().max(128),
  })
  .strict();
export const ThemeCatalogEntrySchema = z
  .object({
    id: EntityIdSchema,
    name: z.string().min(1).max(128),
    previewUrl: z.string().url().nullable(),
    downloadUrl: z.string().url(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  })
  .strict();
export const SandboxJobRequestSchema = z
  .object({
    jobId: EntityIdSchema,
    language: z.enum(["javascript", "python"]),
    source: z.string().min(1).max(128_000),
    limits: z
      .object({
        cpuMs: z.number().int().min(1).max(60_000),
        memoryMiB: z.number().int().min(16).max(1024),
      })
      .strict(),
  })
  .strict();
export const SupportTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    message: z.string().min(1).max(16_000),
    includeDiagnostics: z.boolean(),
    attachmentIds: z.array(EntityIdSchema).max(5),
  })
  .strict();
export const EncryptedBackupObjectSchema = z
  .object({
    objectId: EntityIdSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    ciphertextBase64Url: z.string().min(1).max(20_000_000),
  })
  .strict();
export const EntitlementSchema = z
  .object({
    productId: z.string().min(1).max(128),
    state: z.enum(["active", "inactive", "grace-period", "unknown"]),
    expiresAt: IsoTimestampSchema.nullable(),
  })
  .strict();
export const MetricsBatchSchema = z
  .object({
    consentId: EntityIdSchema,
    events: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            count: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const ReleaseVersionSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i),
    publishedAt: IsoTimestampSchema,
    minimumSupportedVersion: z.string().min(1),
    updateUrl: z.string().url().nullable(),
  })
  .strict();

export const OptionalServiceErrorSchema = z
  .object({
    code: z.enum([
      "unauthorized",
      "forbidden",
      "quota",
      "invalid-request",
      "unavailable",
    ]),
    message: z.string().max(512),
    requestId: EntityIdSchema,
  })
  .strict();
