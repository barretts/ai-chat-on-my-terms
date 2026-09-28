import { z } from "zod";
import {
  EntityBaseSchema,
  EntityIdSchema,
  IsoTimestampSchema,
} from "./identity";

export const CapabilitySchema = z.enum(["yes", "no", "unknown"]);
export const TypedErrorCodeSchema = z.enum([
  "offline",
  "unauthorized",
  "permission",
  "unsupported",
  "missing-model",
  "context-full",
  "quota",
  "timeout",
  "host-stopped",
  "malformed",
  "canceled",
]);
export const TypedErrorSchema = z
  .object({
    code: TypedErrorCodeSchema,
    message: z.string(),
    recoverable: z.boolean(),
    backend: z.string().optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ProviderConnectionSchema = EntityBaseSchema.extend({
  kind: z.string().min(1),
  host: z.string().url().optional(),
  credentialRef: EntityIdSchema.optional(),
  headerRefs: z.array(EntityIdSchema),
});
export const ModelRecordSchema = EntityBaseSchema.extend({
  providerConnectionId: EntityIdSchema,
  modelId: z.string().min(1),
  runtime: z.string().min(1),
  format: z.string().min(1),
  quantization: z.string().optional(),
  capabilities: z.record(z.string(), CapabilitySchema),
});
export const ConversationSchema = EntityBaseSchema.extend({
  kind: z.enum(["chat", "group", "arena"]),
  title: z.string(),
  folderId: EntityIdSchema.nullable(),
  bindingId: EntityIdSchema.nullable(),
  overrides: z.record(z.string(), z.unknown()),
});
const MessagePartIdentityFields = {
  messageId: EntityIdSchema.optional(),
  runId: EntityIdSchema.optional(),
  participantId: EntityIdSchema.optional(),
};
export const MessagePartSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...MessagePartIdentityFields,
      type: z.literal("text"),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      ...MessagePartIdentityFields,
      type: z.literal("reasoning"),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      ...MessagePartIdentityFields,
      type: z.literal("image"),
      attachmentId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      ...MessagePartIdentityFields,
      type: z.literal("file"),
      attachmentId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      ...MessagePartIdentityFields,
      type: z.literal("audio"),
      attachmentId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      ...MessagePartIdentityFields,
      type: z.literal("generated-media"),
      mediaId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      ...MessagePartIdentityFields,
      type: z.literal("tool-call"),
      invocationId: EntityIdSchema,
      name: z.string(),
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      ...MessagePartIdentityFields,
      type: z.literal("tool-result"),
      invocationId: EntityIdSchema,
      output: z.unknown(),
    })
    .strict(),
  z
    .object({
      ...MessagePartIdentityFields,
      type: z.literal("source"),
      url: z.string().url(),
      title: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...MessagePartIdentityFields,
      type: z.literal("error"),
      error: TypedErrorSchema,
    })
    .strict(),
]);
export const MessageSchema = EntityBaseSchema.extend({
  conversationId: EntityIdSchema,
  role: z.enum(["system", "user", "assistant", "tool"]),
  parts: z.array(MessagePartSchema),
  selectedVariantId: EntityIdSchema.nullable(),
  runStatus: z.enum([
    "idle",
    "queued",
    "running",
    "completed",
    "canceled",
    "failed",
  ]),
});
export const JobSchema = EntityBaseSchema.extend({
  kind: z.string().min(1),
  state: z.enum(["queued", "running", "completed", "canceled", "failed"]),
  progress: z.number().min(0).max(1).nullable(),
  startedAt: IsoTimestampSchema.nullable(),
  finishedAt: IsoTimestampSchema.nullable(),
});

export const ModelFileSchema = EntityBaseSchema.extend({
  modelId: EntityIdSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  managedPath: z.string().min(1),
  jobId: EntityIdSchema.nullable(),
  state: z.enum([
    "queued",
    "downloading",
    "verifying",
    "ready",
    "failed",
    "deleted",
  ]),
});
export const ParameterPresetSchema = EntityBaseSchema.extend({
  name: z.string().min(1),
  scope: z.enum(["global", "model", "persona", "chat"]),
  explicitlySet: z.record(z.string(), z.unknown()),
});
export const ResponseVariantSchema = EntityBaseSchema.extend({
  messageId: EntityIdSchema,
  generation: z.number().int().nonnegative(),
  parts: z.array(MessagePartSchema),
  selected: z.boolean(),
});
export const AttachmentSchema = EntityBaseSchema.extend({
  mimeType: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  blobRef: EntityIdSchema,
  extractedText: z.string().nullable(),
  byteLength: z.number().int().nonnegative(),
});
export const FolderSchema = EntityBaseSchema.extend({
  name: z.string().min(1),
  parentId: EntityIdSchema.nullable(),
});
export const PersonaSchema = EntityBaseSchema.extend({
  name: z.string().min(1),
  profile: z.record(z.string(), z.unknown()),
  photoAttachmentId: EntityIdSchema.nullable(),
  modelId: EntityIdSchema.nullable(),
  parameterPresetId: EntityIdSchema.nullable(),
});
export const MemoryEntrySchema = EntityBaseSchema.extend({
  content: z.string(),
  provenance: z
    .object({ sourceMessageId: EntityIdSchema.nullable(), method: z.string() })
    .strict(),
  scope: z.enum(["global", "persona", "conversation"]),
  scopeId: EntityIdSchema.nullable(),
});
export const GroupRoomSchema = EntityBaseSchema.extend({
  name: z.string().min(1),
  conversationId: EntityIdSchema,
});
export const GroupParticipantSchema = EntityBaseSchema.extend({
  groupRoomId: EntityIdSchema,
  personaId: EntityIdSchema.nullable(),
  providerConnectionId: EntityIdSchema.nullable(),
  modelId: z.string().nullable(),
  turnOrder: z.number().int().nonnegative(),
});
export const ToolServerSchema = EntityBaseSchema.extend({
  kind: z.enum(["builtin", "mcp", "hosted", "sandbox"]),
  name: z.string().min(1),
  endpoint: z.string().url().nullable(),
  credentialRef: EntityIdSchema.nullable(),
  enabled: z.boolean(),
});
export const ToolInvocationSchema = EntityBaseSchema.extend({
  conversationId: EntityIdSchema,
  runId: EntityIdSchema,
  serverId: EntityIdSchema,
  toolName: z.string().min(1),
  input: z.unknown(),
  output: z.unknown().nullable(),
  state: z.enum(["pending", "running", "completed", "canceled", "failed"]),
});
export const VoiceProfileSchema = EntityBaseSchema.extend({
  name: z.string().min(1),
  provider: z.string().min(1),
  voiceId: z.string().min(1),
  packRef: EntityIdSchema.nullable(),
});
export const MediaWorkflowSchema = EntityBaseSchema.extend({
  name: z.string().min(1),
  definition: z.record(z.string(), z.unknown()),
});
export const MediaJobSchema = JobSchema.extend({
  workflowId: EntityIdSchema,
  inputRefs: z.array(EntityIdSchema),
  outputRefs: z.array(EntityIdSchema),
});
export const ArenaRunSchema = EntityBaseSchema.extend({
  conversationId: EntityIdSchema,
  contestantIds: z.array(EntityIdSchema).min(2),
  state: z.enum(["pending", "running", "completed", "canceled", "failed"]),
});
export const ArenaContestantSchema = EntityBaseSchema.extend({
  arenaRunId: EntityIdSchema,
  providerConnectionId: EntityIdSchema,
  modelId: z.string().min(1),
  responseVariantId: EntityIdSchema.nullable(),
});
export const PairedDeviceSchema = EntityBaseSchema.extend({
  displayName: z.string().min(1),
  platform: z.enum(["ios", "ipados", "android", "macos", "windows", "linux"]),
  publicKey: z.string().min(1),
  revokedAt: IsoTimestampSchema.nullable(),
});
export const SyncRecordSchema = EntityBaseSchema.extend({
  entityType: z.string().min(1),
  entityId: EntityIdSchema,
  payload: z.unknown(),
  acknowledgedAt: IsoTimestampSchema.nullable(),
});
export const TombstoneSchema = EntityBaseSchema.extend({
  entityType: z.string().min(1),
  entityId: EntityIdSchema,
});
export const PreferenceSchema = EntityBaseSchema.extend({
  key: z.string().min(1),
  value: z.unknown(),
});
export const ConsentSchema = EntityBaseSchema.extend({
  purpose: z.string().min(1),
  granted: z.boolean(),
  decidedAt: IsoTimestampSchema,
});
