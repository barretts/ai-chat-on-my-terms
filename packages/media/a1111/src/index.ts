import {
  MediaBackendError,
  type MediaBackendPort,
  type MediaSnapshot,
} from "@locallab/media-engine";

export interface A1111Model {
  title: string;
  modelName: string;
  sha256: string | null;
}

export interface A1111GenerationParams {
  prompt: string;
  negativePrompt?: string;
  steps: number;
  cfgScale: number;
  width: number;
  height: number;
  seed: number;
  samplerName?: string;
  checkpoint?: string;
  enableHr?: boolean;
  hrUpscaler?: string;
  hrScale?: number;
  denoisingStrength?: number;
  restoreFace?: boolean;
}

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Reads generation parameters from a frozen workflow snapshot. */
export function snapshotParams(snapshot: MediaSnapshot): A1111GenerationParams {
  const definition = snapshot.workflowSnapshot.definition;
  const require_ = (key: string): number => {
    const value = definition[key];
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new MediaBackendError({
        code: "malformed",
        message: `Workflow "${snapshot.workflowSnapshot.name}" is missing numeric parameter "${key}".`,
        recoverable: false,
        backend: "a1111",
      });
    return value;
  };
  return {
    prompt: snapshot.prompt,
    ...(typeof definition.negativePrompt === "string"
      ? { negativePrompt: definition.negativePrompt }
      : {}),
    steps: require_("steps"),
    cfgScale: require_("cfgScale"),
    width: require_("width"),
    height: require_("height"),
    seed: "seed" in definition ? require_("seed") : -1,
    ...(typeof definition.samplerName === "string"
      ? { samplerName: definition.samplerName }
      : {}),
    ...(typeof definition.checkpoint === "string"
      ? { checkpoint: definition.checkpoint }
      : {}),
    ...(typeof definition.enableHr === "boolean"
      ? { enableHr: definition.enableHr }
      : {}),
    ...(typeof definition.hrUpscaler === "string"
      ? { hrUpscaler: definition.hrUpscaler }
      : {}),
    ...(typeof definition.hrScale === "number"
      ? { hrScale: definition.hrScale }
      : {}),
    ...(typeof definition.denoisingStrength === "number"
      ? { denoisingStrength: definition.denoisingStrength }
      : {}),
    ...(typeof definition.restoreFace === "boolean"
      ? { restoreFace: definition.restoreFace }
      : {}),
  };
}

/** API discovery + txt2img for an AUTOMATIC1111 web UI instance (IM-03/04). */
export class A1111Client {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (
      globalThis as { fetch: FetchLike }).fetch,
  ) {}

  private async api(
    path: string,
    init: {
      method?: string;
      body?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new MediaBackendError({
        code: "offline",
        message: `AUTOMATIC1111 at ${this.baseUrl} is not reachable (${error instanceof Error ? error.message : String(error)}).`,
        recoverable: true,
        backend: "a1111",
      });
    }
    if (!response.ok)
      throw new MediaBackendError({
        code: "host-stopped",
        message: `AUTOMATIC1111 returned HTTP ${response.status} for ${path}.`,
        recoverable: true,
        backend: "a1111",
      });
    return response.json();
  }

  async listModels(signal?: AbortSignal): Promise<A1111Model[]> {
    const raw = await this.api(
      "/sdapi/v1/sd-models",
      signal === undefined ? {} : { signal },
    );
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record: Record<string, unknown> = entry as Record<string, unknown>;
      if (typeof record.title !== "string") return [];
      return [
        {
          title: record.title,
          modelName:
            typeof record.model_name === "string" ? record.model_name : record.title,
          sha256: typeof record.sha256 === "string" ? record.sha256 : null,
        },
      ];
    });
  }

  async listSamplers(signal?: AbortSignal): Promise<string[]> {
    const raw = await this.api(
      "/sdapi/v1/samplers",
      signal === undefined ? {} : { signal },
    );
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const name = (entry as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    });
  }

  /** Validates checkpoint and sampler before queueing (step 3). */
  async validate(params: A1111GenerationParams, signal?: AbortSignal): Promise<void> {
    if (params.checkpoint) {
      const models = await this.listModels(signal);
      if (!models.some((model) => model.title === params.checkpoint))
        throw new MediaBackendError({
          code: "missing-model",
          message: `Checkpoint "${params.checkpoint}" is not available on this AUTOMATIC1111 server.`,
          recoverable: true,
          backend: "a1111",
        });
    }
    if (params.samplerName) {
      const samplers = await this.listSamplers(signal);
      if (!samplers.includes(params.samplerName))
        throw new MediaBackendError({
          code: "unsupported",
          message: `Sampler "${params.samplerName}" is not available on this AUTOMATIC1111 server.`,
          recoverable: true,
          backend: "a1111",
        });
    }
  }

  buildRequestBody(params: A1111GenerationParams): Record<string, unknown> {
    const body: Record<string, unknown> = {
      prompt: params.prompt,
      negative_prompt: params.negativePrompt ?? "",
      steps: params.steps,
      cfg_scale: params.cfgScale,
      width: params.width,
      height: params.height,
      seed: params.seed,
      enable_hr: params.enableHr ?? false,
      restore_faces: params.restoreFace ?? false,
    };
    if (params.samplerName) body.sampler_name = params.samplerName;
    if (params.enableHr) {
      if (params.hrUpscaler) body.hr_upscaler = params.hrUpscaler;
      if (params.hrScale !== undefined) body.hr_scale = params.hrScale;
      if (params.denoisingStrength !== undefined)
        body.denoising_strength = params.denoisingStrength;
    }
    if (params.checkpoint)
      body.override_settings = { sd_model_checkpoint: params.checkpoint };
    return body;
  }

  /** POSTs txt2img, follows progress, returns decoded image bytes. */
  async txt2img(
    params: A1111GenerationParams,
    context: { signal?: AbortSignal; reportProgress?(fraction: number): void },
  ): Promise<{ images: Uint8Array[]; info: string }> {
    await this.validate(params, context.signal);
    const pollSignal = context.signal;
    const poll = pollSignal
      ? setInterval(() => {
          void this.api("/sdapi/v1/progress", { signal: pollSignal })
            .then((raw) => {
              if (!raw || typeof raw !== "object") return;
              const progress = (raw as Record<string, unknown>).progress;
              if (typeof progress === "number")
                context.reportProgress?.(progress);
            })
            .catch(() => undefined);
        }, 1_500)
      : undefined;
    const body = JSON.stringify(this.buildRequestBody(params));
    try {
      const raw = await this.api("/sdapi/v1/txt2img", {
        method: "POST",
        body,
        ...(pollSignal ? { signal: pollSignal } : {}),
      });
      if (!raw || typeof raw !== "object")
        throw new MediaBackendError({
          code: "malformed",
          message: "AUTOMATIC1111 returned a non-object txt2img response.",
          recoverable: true,
          backend: "a1111",
        });
      const record = raw as Record<string, unknown>;
      if (!Array.isArray(record.images))
        throw new MediaBackendError({
          code: "malformed",
          message: "AUTOMATIC1111 txt2img response has no images array.",
          recoverable: true,
          backend: "a1111",
        });
      const images = record.images.flatMap((entry) =>
        typeof entry === "string" ? [Buffer.from(entry, "base64")] : [],
      );
      if (images.length === 0)
        throw new MediaBackendError({
          code: "malformed",
          message: "AUTOMATIC1111 returned no decodable images.",
          recoverable: true,
          backend: "a1111",
        });
      return {
        images,
        info: typeof record.info === "string" ? record.info : "",
      };
    } finally {
      clearInterval(poll);
    }
  }
}

/** MediaBackendPort adapter: snapshots in, managed blob refs out. */
export class A1111MediaBackend implements MediaBackendPort {
  constructor(
    private readonly client: A1111Client,
    private readonly blobSink: (
      bytes: Uint8Array,
      mimeType: string,
    ) => Promise<string>,
    private readonly mimeType = "image/png",
  ) {}

  async generate(context: {
    snapshot: MediaSnapshot;
    signal: AbortSignal;
    reportProgress(progress: number): Promise<void>;
  }): Promise<{ outputRefs: string[] }> {
    const params = snapshotParams(context.snapshot);
    const { images } = await this.client.txt2img(params, {
      signal: context.signal,
      reportProgress: (fraction) => {
        void context.reportProgress(fraction);
      },
    });
    const outputRefs: string[] = [];
    for (const image of images)
      outputRefs.push(await this.blobSink(image, this.mimeType));
    return { outputRefs };
  }
}
