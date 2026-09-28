import { z } from "zod";
import { EntityIdSchema, IsoTimestampSchema } from "./identity";

const EventBaseSchema = z
  .object({
    runId: EntityIdSchema,
    sequence: z.number().int().nonnegative(),
    timestamp: IsoTimestampSchema,
    participantId: EntityIdSchema.optional(),
  })
  .strict();

export const RunEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({ type: z.literal("RunStarted") }),
  EventBaseSchema.extend({
    type: z.literal("LoadProgress"),
    fraction: z.number().min(0).max(1),
    detail: z.string().optional(),
  }),
  EventBaseSchema.extend({
    type: z.literal("PromptProgress"),
    fraction: z.number().min(0).max(1),
    detail: z.string().optional(),
  }),
  EventBaseSchema.extend({
    type: z.literal("ReasoningDelta"),
    text: z.string(),
  }),
  EventBaseSchema.extend({ type: z.literal("TextDelta"), text: z.string() }),
  EventBaseSchema.extend({
    type: z.literal("ToolCall"),
    invocationId: EntityIdSchema,
    name: z.string().min(1),
    input: z.unknown(),
  }),
  EventBaseSchema.extend({
    type: z.literal("ToolResult"),
    invocationId: EntityIdSchema,
    output: z.unknown(),
  }),
  EventBaseSchema.extend({
    type: z.literal("Source"),
    url: z.string().url(),
    title: z.string().optional(),
  }),
  EventBaseSchema.extend({
    type: z.literal("Usage"),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }),
  EventBaseSchema.extend({
    type: z.literal("MediaReference"),
    mediaId: EntityIdSchema,
    mediaType: z.string().min(1),
  }),
  EventBaseSchema.extend({
    type: z.literal("RunCompleted"),
    finishReason: z.string().optional(),
  }),
  EventBaseSchema.extend({
    type: z.literal("RunCanceled"),
    reason: z.string().optional(),
  }),
  EventBaseSchema.extend({
    type: z.literal("RunFailed"),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        recoverable: z.boolean(),
      })
      .strict(),
  }),
]);

export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent["type"];

const terminalTypes = new Set<RunEventType>([
  "RunCompleted",
  "RunCanceled",
  "RunFailed",
]);
export const RunEventBatchSchema = z
  .array(RunEventSchema)
  .superRefine((events, context) => {
    if (events.length === 0) return;
    const runId = events[0]!.runId;
    let previousSequence = -1;
    let terminalIndex = -1;
    for (const [index, event] of events.entries()) {
      if (event.runId !== runId) {
        context.addIssue({
          code: "custom",
          path: [index, "runId"],
          message: "A run event batch must contain one runId",
        });
      }
      if (event.sequence <= previousSequence) {
        context.addIssue({
          code: "custom",
          path: [index, "sequence"],
          message: "Run event sequences must strictly increase",
        });
      }
      previousSequence = event.sequence;
      if (terminalTypes.has(event.type)) {
        if (terminalIndex !== -1) {
          context.addIssue({
            code: "custom",
            path: [index, "type"],
            message: "A run may have only one terminal event",
          });
        }
        terminalIndex = index;
      }
    }
    if (terminalIndex !== -1 && terminalIndex !== events.length - 1) {
      context.addIssue({
        code: "custom",
        path: [terminalIndex, "type"],
        message: "A terminal event must be last",
      });
    }
  });

export const RunRequestSchema = z
  .object({
    runId: EntityIdSchema,
    conversationId: EntityIdSchema,
    messageId: EntityIdSchema,
    providerConnectionId: EntityIdSchema,
    modelId: z.string().min(1),
    context: z.array(
      z.object({ kind: z.string(), value: z.unknown() }).strict(),
    ),
    parameters: z.record(z.string(), z.unknown()),
    permittedTools: z.array(z.string()),
    attachmentRefs: z.array(EntityIdSchema),
    reasoning: z.boolean(),
    json: z.boolean(),
  })
  .strict();
export type RunRequest = z.infer<typeof RunRequestSchema>;
