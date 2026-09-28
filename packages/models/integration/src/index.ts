import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";

export type ManagedModelFormat = "gguf" | "mlx";
export type RuntimeId = "gguf-ios" | "mlx-ios" | "gguf-macos";
export type RuntimeHost = "ios-device" | "mac-companion";

export interface ManagedRuntimeModel {
  readonly id: string;
  readonly format: ManagedModelFormat;
  readonly runtime: RuntimeId;
  /** Opaque app managed ID, never an arbitrary path. */
  readonly managedRef: string;
  readonly sha256: string;
}

export interface RuntimeAvailability {
  readonly state: "yes" | "no" | "unknown";
  readonly reason?: string;
}

export interface LoadedModelRuntime {
  readonly provider: ProviderPort;
  dispose(): Promise<void>;
}

export interface ModelRuntimeAdapter {
  readonly id: RuntimeId;
  availability(host: RuntimeHost): Promise<RuntimeAvailability>;
  load(model: ManagedRuntimeModel): Promise<LoadedModelRuntime>;
}

export type RuntimeResolution =
  | { readonly ok: true; readonly adapter: ModelRuntimeAdapter }
  | { readonly ok: false; readonly reason: string };

export class ModelRuntimeError extends Error {
  constructor(
    readonly code:
      | "unknown-runtime"
      | "wrong-format"
      | "unavailable"
      | "invalid-managed-model"
      | "model-in-use",
    message: string,
  ) {
    super(message);
    this.name = "ModelRuntimeError";
  }
}

/** Routes only to the model's declared runtime; it never silently falls back. */
export class ModelRuntimeCoordinator {
  private readonly adapters: ReadonlyMap<RuntimeId, ModelRuntimeAdapter>;
  private loaded:
    | {
        modelId: string;
        runtime: LoadedModelRuntime;
        activeRuns: number;
      }
    | undefined;

  constructor(
    adapters: readonly ModelRuntimeAdapter[],
    private readonly host: RuntimeHost,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    if (this.adapters.size !== adapters.length)
      throw new Error("Runtime adapter IDs must be unique");
  }

  async resolve(model: ManagedRuntimeModel): Promise<RuntimeResolution> {
    const validation = validateModel(model);
    if (validation) return { ok: false, reason: validation };
    const adapter = this.adapters.get(model.runtime);
    if (!adapter)
      return {
        ok: false,
        reason: `No ${model.runtime} adapter is registered for this host`,
      };
    const available = await adapter.availability(this.host);
    if (available.state !== "yes")
      return {
        ok: false,
        reason:
          available.reason ??
          (available.state === "unknown"
            ? "Runtime capability is not verified on this host"
            : "Runtime is unavailable on this host"),
      };
    return { ok: true, adapter };
  }

  async load(model: ManagedRuntimeModel): Promise<void> {
    const resolution = await this.resolve(model);
    if (!resolution.ok) {
      const code = validateModel(model)
        ? "invalid-managed-model"
        : this.adapters.has(model.runtime)
          ? "unavailable"
          : "unknown-runtime";
      throw new ModelRuntimeError(code, resolution.reason);
    }
    if (this.loaded?.modelId === model.id) return;
    if (this.loaded) {
      if (this.loaded.activeRuns > 0)
        throw new ModelRuntimeError(
          "model-in-use",
          "Wait for the current generation to finish before changing models",
        );
      const prior = this.loaded;
      this.loaded = undefined;
      await prior.runtime.dispose();
    }
    const runtime = await resolution.adapter.load(model);
    this.loaded = { modelId: model.id, runtime, activeRuns: 0 };
  }

  async unload(): Promise<void> {
    if (!this.loaded) return;
    if (this.loaded.activeRuns > 0)
      throw new ModelRuntimeError(
        "model-in-use",
        "The loaded model is leased by an active generation",
      );
    const current = this.loaded;
    this.loaded = undefined;
    await current.runtime.dispose();
  }

  get loadedModelId(): string | null {
    return this.loaded?.modelId ?? null;
  }

  async *startRun(
    request: RunRequest,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const loaded = this.loaded;
    if (!loaded)
      throw new ModelRuntimeError(
        "unavailable",
        "Load a verified local model before starting generation",
      );
    if (request.modelId !== loaded.modelId)
      throw new ModelRuntimeError(
        "unavailable",
        "The request model does not match the explicitly loaded model",
      );
    loaded.activeRuns += 1;
    try {
      yield* loaded.runtime.provider.startRun(request, signal);
    } finally {
      loaded.activeRuns = Math.max(0, loaded.activeRuns - 1);
    }
  }
}

function validateModel(model: ManagedRuntimeModel): string | null {
  if (model.runtime.startsWith("gguf") && model.format !== "gguf")
    return "The GGUF runtime only accepts GGUF models";
  if (model.runtime === "mlx-ios" && model.format !== "mlx")
    return "The MLX runtime only accepts MLX model folders";
  if (!model.id || !model.managedRef || !/^[0-9a-f]{64}$/i.test(model.sha256))
    return "The model requires an app-managed reference and verified SHA-256";
  if (
    model.runtime === "gguf-ios" &&
    !/^blob:[0-9a-f-]{36}$/i.test(model.managedRef)
  )
    return "The iOS GGUF runtime requires a managed blob ID";
  if (
    model.runtime === "mlx-ios" &&
    !/^mlx:[a-z0-9][a-z0-9._:-]*$/i.test(model.managedRef)
  )
    return "The iOS MLX runtime requires a managed model ID";
  if (
    model.runtime === "gguf-macos" &&
    !/^managed:[a-z0-9][a-z0-9._:-]*$/i.test(model.managedRef)
  )
    return "The Mac GGUF runtime requires an app-managed model ID";
  return null;
}
