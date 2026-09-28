import { z } from "zod";
import { EntityBaseSchema, EntityIdSchema } from "@locallab/contracts/identity";
import {
  CapabilitySchema,
  TypedErrorSchema,
} from "@locallab/contracts/entities";
import type { CapabilityMap, ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";

export const ArenaSnapshotSchema = z
  .object({
    prompt: z.string().min(1),
    conversationId: EntityIdSchema,
    messageId: EntityIdSchema,
    context: z.array(
      z.object({ kind: z.string(), value: z.unknown() }).strict(),
    ),
    parameters: z.record(z.string(), z.unknown()),
    permittedTools: z.array(z.string()),
    attachmentRefs: z.array(EntityIdSchema),
    reasoning: z.boolean(),
    json: z.boolean(),
    requiredCapabilities: z.array(z.string()),
  })
  .strict();
export type ArenaSnapshot = z.infer<typeof ArenaSnapshotSchema>;

export const ArenaTimingSchema = z
  .object({
    preparationMs: z.number().nonnegative(),
    ttftMs: z.number().nonnegative().nullable(),
    elapsedMs: z.number().nonnegative(),
    decodeMs: z.number().nonnegative().nullable(),
    decodeTimingSource: z
      .enum(["provider-reported", "observed-output-interval"])
      .nullable(),
    providerOutputTokens: z.number().int().nonnegative().nullable(),
    providerInputTokens: z.number().int().nonnegative().nullable(),
    providerReportedTokensPerSecond: z.number().nonnegative().nullable(),
    reportedTokenCountPerSecond: z.number().nonnegative().nullable(),
    estimatedOutputTokens: z.number().int().nonnegative(),
    estimatedTokensPerSecond: z.number().nonnegative().nullable(),
  })
  .strict();
export type ArenaTiming = z.infer<typeof ArenaTimingSchema>;

export const ArenaContestantSchema = EntityBaseSchema.extend({
  arenaRunId: EntityIdSchema,
  position: z.number().int().min(0).max(3),
  providerConnectionId: EntityIdSchema,
  modelId: z.string().min(1),
  label: z.string().min(1),
  state: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ]),
  text: z.string(),
  reasoningText: z.string(),
  outputTruncated: z.boolean(),
  capabilities: z.record(z.string(), CapabilitySchema),
  timing: ArenaTimingSchema,
  lastSequence: z.number().int().min(-1),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  finishReason: z.string().nullable(),
  error: TypedErrorSchema.nullable(),
}).strict();
export type ArenaContestant = z.infer<typeof ArenaContestantSchema>;

export const ArenaRunSchema = EntityBaseSchema.extend({
  state: z.enum(["running", "completed", "canceled", "interrupted"]),
  snapshot: ArenaSnapshotSchema,
  contestantIds: z.array(EntityIdSchema).min(1).max(4),
  finishedAt: z.string().nullable(),
}).strict();
export type ArenaRun = z.infer<typeof ArenaRunSchema>;
export interface ArenaResult {
  readonly run: ArenaRun;
  readonly contestants: readonly ArenaContestant[];
}

/** These values must come from the backend's decode telemetry, never wall time,
 * download progress, character counts, or a guessed tokenizer. */
export interface ArenaProviderMetrics {
  readonly outputTokensPerSecond?: number;
  readonly decodeDurationMs?: number;
}

export interface ArenaModelLease {
  /** Runtime preparation may resolve a leased provider for exactly this binding. */
  readonly port?: ProviderPort;
  release(): Promise<void> | void;
}

export interface ArenaBinding {
  readonly providerConnectionId: string;
  readonly modelId: string;
  readonly label: string;
  readonly port: ProviderPort;
  /** Resolved in memory only. Credentials and connection objects are not stored. */
  readonly connection?: unknown;
  /** Download/load and scheduler admission happen before request timing begins.
   * The lease is held until the provider stream actually closes, including stop. */
  readonly prepare?: (signal: AbortSignal) => Promise<ArenaModelLease>;
  readonly readReportedMetrics?: (
    runId: string,
  ) => ArenaProviderMetrics | undefined;
}

export interface ArenaRaceInput {
  readonly prompt: string;
  /** Previous canonical provider messages; the shared user prompt is appended once. */
  readonly context?: readonly {
    readonly kind: string;
    readonly value: unknown;
  }[];
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly permittedTools?: readonly string[];
  readonly attachmentRefs?: readonly string[];
  readonly reasoning?: boolean;
  readonly json?: boolean;
  readonly requiredCapabilities?: readonly string[];
  readonly contestants: readonly ArenaBinding[];
}

export interface ArenaLiveUpdate {
  readonly arenaRunId: string;
  readonly contestant: ArenaContestant;
  readonly eventType?: RunEvent["type"];
}

export interface ArenaRaceHandle {
  readonly id: string;
  /** Settles after durable terminal results, even when a provider ignores stop. */
  readonly done: Promise<ArenaResult>;
  /** Settles only when all provider resources and model leases have drained. */
  readonly resourcesDrained: Promise<void>;
  cancel(contestantId?: string): Promise<void>;
  read(): Promise<ArenaResult>;
}

export function requestedCapabilities(
  snapshot: ArenaSnapshot,
): readonly string[] {
  return [
    ...new Set([
      ...snapshot.requiredCapabilities,
      ...(snapshot.permittedTools.length || hasToolDefinitions(snapshot)
        ? ["tools"]
        : []),
      ...(snapshot.reasoning ? ["reasoning"] : []),
      ...(snapshot.json ? ["json"] : []),
      ...(snapshot.attachmentRefs.length || hasImagePayload(snapshot.context)
        ? ["vision"]
        : []),
    ]),
  ];
}

export function hasToolDefinitions(snapshot: ArenaSnapshot): boolean {
  return (
    (Array.isArray(snapshot.parameters.tools) &&
      snapshot.parameters.tools.length > 0) ||
    snapshot.context.some((item) => item.kind === "tool-definitions")
  );
}

function hasImagePayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasImagePayload);
  const record = value as Record<string, unknown>;
  if (
    ["image", "input_image", "image_url"].includes(String(record.type)) ||
    record.inlineData !== undefined ||
    record.inline_data !== undefined
  )
    return true;
  return Object.values(record).some(hasImagePayload);
}

export function capabilityFailure(
  snapshot: ArenaSnapshot,
  capabilities: CapabilityMap,
): string | undefined {
  return requestedCapabilities(snapshot).find(
    (name) => capabilities[name] !== "yes",
  );
}

export function requestFor(
  snapshot: ArenaSnapshot,
  contestant: ArenaContestant,
): RunRequest {
  return {
    runId: contestant.id,
    conversationId: snapshot.conversationId,
    messageId: snapshot.messageId,
    providerConnectionId: contestant.providerConnectionId,
    modelId: contestant.modelId,
    context: snapshot.context,
    parameters: snapshot.parameters,
    permittedTools: snapshot.permittedTools,
    attachmentRefs: snapshot.attachmentRefs,
    reasoning: snapshot.reasoning,
    json: snapshot.json,
  };
}
