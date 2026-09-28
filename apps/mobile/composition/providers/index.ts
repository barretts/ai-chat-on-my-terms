import type {
  ProviderPort,
  CapabilityMap,
  PortResult,
} from "@locallab/contracts/ports";
import { RunEventSchema } from "@locallab/contracts/run-events";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";

export interface ProviderBinding {
  readonly providerConnectionId: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly port: ProviderPort<any>;
  /** Resolves model IDs for this provider connection; never substitutes another provider. */
  listModels(
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<PortResult<readonly string[]>>;
  getCapabilities(
    connectionId: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<PortResult<CapabilityMap>>;
}

export interface ProviderRegistryOptions {
  readonly adapters: readonly ProviderAdapter[];
  readonly resolveBinding: (
    providerConnectionId: string,
  ) => Promise<ProviderBinding | null>;
  readonly isEmbeddingModel?: (modelId: string) => boolean;
}

export class ProviderRegistryError extends Error {
  constructor(
    readonly code:
      | "unknown-provider"
      | "unknown-connection"
      | "model-mismatch"
      | "invalid-event",
    message: string,
  ) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

/** Platform composition routes every operation through the explicitly saved provider connection. */
export function createProviderRegistry(options: ProviderRegistryOptions) {
  const adapters = new Map(
    options.adapters.map((adapter) => [adapter.id, adapter]),
  );
  if (adapters.size !== options.adapters.length)
    throw new Error("Provider adapter IDs must be unique");
  const isEmbedding =
    options.isEmbeddingModel ??
    ((id: string) => /(?:^|[-_.])embed(?:ding)?(?:[-_.]|$)/i.test(id));

  async function resolve(
    connectionId: string,
    modelId?: string,
    signal?: AbortSignal,
  ) {
    const binding = await options.resolveBinding(connectionId);
    if (!binding || binding.providerConnectionId !== connectionId)
      throw new ProviderRegistryError(
        "unknown-connection",
        "Saved provider connection is unavailable",
      );
    const adapter = adapters.get(binding.providerId);
    if (!adapter)
      throw new ProviderRegistryError(
        "unknown-provider",
        "Saved provider is not registered",
      );
    if (modelId !== undefined && binding.modelId !== modelId)
      throw new ProviderRegistryError(
        "model-mismatch",
        "The selected model changed; select it again before retrying",
      );
    if (signal?.aborted)
      throw signal.reason ?? new DOMException("Canceled", "AbortError");
    return { binding, adapter };
  }

  return Object.freeze({
    providerIds: Object.freeze([...adapters.keys()]),
    async listModels(
      connectionId: string,
      signal?: AbortSignal,
    ): Promise<PortResult<readonly string[]>> {
      const { adapter } = await resolve(connectionId, undefined, signal);
      const result = await adapter.listModels(connectionId, signal);
      return result.ok
        ? { ok: true, value: result.value.filter((id) => !isEmbedding(id)) }
        : result;
    },
    async getCapabilities(
      connectionId: string,
      modelId: string,
      signal?: AbortSignal,
    ) {
      const { adapter } = await resolve(connectionId, modelId, signal);
      return adapter.getCapabilities(connectionId, modelId, signal);
    },
    async *startRun(
      request: RunRequest,
      signal: AbortSignal,
    ): AsyncIterable<RunEvent> {
      const { binding, adapter } = await resolve(
        request.providerConnectionId,
        request.modelId,
        signal,
      );
      if (binding.providerId !== adapter.id)
        throw new ProviderRegistryError(
          "unknown-provider",
          "Provider binding changed before the run started",
        );
      let previousSequence = -1;
      let terminal = false;
      for await (const event of adapter.port.startRun(request, signal)) {
        const parsed = RunEventSchema.safeParse(event);
        if (
          !parsed.success ||
          event.runId !== request.runId ||
          event.sequence <= previousSequence ||
          terminal
        )
          throw new ProviderRegistryError(
            "invalid-event",
            "Provider returned an invalid or mismatched run event",
          );
        previousSequence = event.sequence;
        terminal =
          event.type === "RunCompleted" ||
          event.type === "RunCanceled" ||
          event.type === "RunFailed";
        yield event;
      }
      if (!terminal)
        throw new ProviderRegistryError(
          "invalid-event",
          "Provider stream ended without a terminal event",
        );
    },
    async dispose() {
      await Promise.all(
        [...adapters.values()].map(({ port }) => port.dispose?.()),
      );
    },
  });
}
