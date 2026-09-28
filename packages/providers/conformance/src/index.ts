import {
  RunEventBatchSchema,
  RunRequestSchema,
} from "@locallab/contracts/run-events";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";

export interface ProviderFixtureConformanceOptions<Connection> {
  readonly provider: ProviderPort<Connection>;
  readonly connection: Connection;
  readonly request: RunRequest;
  /** Stable ID selected by the composition layer for this connection. */
  readonly selectedProviderConnectionId: string;
  /** IDs supplied by the selector fixture as embedding-only models. */
  readonly embeddingModelIds: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ProviderFixtureConformanceResult {
  readonly modelIds: readonly string[];
  readonly capabilities: Readonly<Record<string, "yes" | "no" | "unknown">>;
  readonly events: readonly RunEvent[];
}

/**
 * Runs the adapter-agnostic part of the T025 fixture gate. Provider identity
 * beyond the selected connection ID is adapter/composition metadata: RunEvent
 * intentionally contains run identity only.
 */
export async function conformProviderFixture<Connection>(
  options: ProviderFixtureConformanceOptions<Connection>,
): Promise<ProviderFixtureConformanceResult> {
  const { provider, connection, request } = options;
  const parsedRequest = RunRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error(
      `Invalid provider fixture RunRequest: ${parsedRequest.error.message}`,
    );
  }
  if (request.providerConnectionId !== options.selectedProviderConnectionId) {
    throw new Error(
      "RunRequest providerConnectionId differs from selected connection",
    );
  }
  if (!request.modelId.trim())
    throw new Error("RunRequest modelId must be selected");

  const listed = await provider.listModels(connection, options.signal);
  if (!listed.ok)
    throw new Error(`Provider model listing failed: ${listed.error.code}`);
  const modelIds = listed.value;
  if (new Set(modelIds).size !== modelIds.length) {
    throw new Error("Provider model selector returned duplicate model IDs");
  }
  const embeddingIds = new Set(options.embeddingModelIds);
  const exposedEmbeddings = modelIds.filter((modelId) =>
    embeddingIds.has(modelId),
  );
  if (exposedEmbeddings.length) {
    throw new Error(
      `Embedding-only models exposed to chat selection: ${exposedEmbeddings.join(", ")}`,
    );
  }
  if (!modelIds.includes(request.modelId)) {
    throw new Error(
      `Selected chat model is absent from provider model list: ${request.modelId}`,
    );
  }

  const capabilityResult = await provider.getCapabilities(
    connection,
    request.modelId,
    options.signal,
  );
  if (!capabilityResult.ok) {
    throw new Error(
      `Selected model capability lookup failed: ${capabilityResult.error.code}`,
    );
  }

  const events: RunEvent[] = [];
  for await (const event of provider.startRun(
    request,
    options.signal ?? new AbortController().signal,
  )) {
    events.push(event);
  }
  const parsedEvents = RunEventBatchSchema.safeParse(events);
  if (!parsedEvents.success) {
    throw new Error(
      `Provider emitted an invalid RunEvent batch: ${parsedEvents.error.message}`,
    );
  }
  if (
    !events.length ||
    !["RunCompleted", "RunCanceled", "RunFailed"].includes(events.at(-1)!.type)
  ) {
    throw new Error("Provider fixture run ended without a terminal event");
  }
  if (events.some((event) => event.runId !== request.runId)) {
    throw new Error("Provider event runId differs from selected request runId");
  }
  return { modelIds, capabilities: capabilityResult.value, events };
}
