import {
  MediaBackendError,
  type MediaBackendPort,
  type MediaSnapshot,
} from "@locallab/media-engine";

export type ComfyGraphNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};
export type ComfyGraph = Record<string, ComfyGraphNode>;

export interface ComfyLora {
  name: string;
  strengthModel?: number;
  strengthClip?: number;
}

export interface ComfyGenerationParams {
  prompt: string;
  negativePrompt?: string;
  seed: number;
  steps: number;
  cfgScale: number;
  width: number;
  height: number;
  samplerName: string;
  scheduler: string;
  checkpoint: string;
  loras: ComfyLora[];
}

export type ComfyWorkflowSource =
  | { kind: "default" }
  | { kind: "api-json"; graph: unknown }
  | { kind: "saved"; name: string };

const err = (code: "malformed" | "offline" | "host-stopped" | "unsupported", message: string) =>
  new MediaBackendError({
    code,
    message,
    recoverable: code !== "malformed",
    backend: "comfyui",
  });

/** Default txt2img graph: checkpoint -> dual clip encode -> sampler -> decode -> save. */
export function defaultGraph(params: ComfyGenerationParams): ComfyGraph {
  const graph: ComfyGraph = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: params.checkpoint },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["1", 1], text: params.prompt },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["1", 1], text: params.negativePrompt ?? "" },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: params.width, height: params.height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        seed: params.seed,
        steps: params.steps,
        cfg: params.cfgScale,
        sampler_name: params.samplerName,
        scheduler: params.scheduler,
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "LocalLab" } },
  };
  return graph;
}

/** Chain LoraLoader nodes between the checkpoint and the model/clip consumers. */
export function applyLoras(graph: ComfyGraph, loras: ComfyLora[]): { graph: ComfyGraph; loraNodeIds: string[] } {
  if (loras.length === 0) return { graph, loraNodeIds: [] };
  const checkpointId = Object.keys(graph).find(
    (id) => graph[id]?.class_type === "CheckpointLoaderSimple",
  );
  if (!checkpointId)
    throw err("malformed", "Graph has LoRA selections but no CheckpointLoaderSimple node to attach them to.");
  const next = Object.fromEntries(
    Object.entries(graph).map(([id, node]) => [id, { ...node, inputs: { ...node.inputs } }]),
  );
  let modelSource: [string, number] = [checkpointId, 0];
  let clipSource: [string, number] = [checkpointId, 1];
  const loraNodeIds: string[] = [];
  let nextLoraIndex = 0;
  loras.forEach((lora) => {
    let id: string;
    do {
      id = `2${nextLoraIndex++}`;
    } while (Object.hasOwn(next, id));
    next[id] = {
      class_type: "LoraLoader",
      inputs: {
        model: modelSource,
        clip: clipSource,
        lora_name: lora.name,
        strength_model: lora.strengthModel ?? 1,
        strength_clip: lora.strengthClip ?? 1,
      },
    };
    modelSource = [id, 0];
    clipSource = [id, 1];
    loraNodeIds.push(id);
  });
  for (const [id, node] of Object.entries(next)) {
    if (
      node.class_type === "CheckpointLoaderSimple" ||
      loraNodeIds.includes(id)
    )
      continue;
    const patched = { ...node.inputs };
    for (const key of Object.keys(patched)) {
      const value = patched[key];
      if (Array.isArray(value) && value[0] === checkpointId) {
        if (value[1] === 0) patched[key] = modelSource;
        else if (value[1] === 1) patched[key] = clipSource;
      }
    }
    node.inputs = patched;
  }
  return { graph: next, loraNodeIds };
}

/** Graph validation before queueing: shape, node links, SaveImage sink. */
export function validateGraph(graph: unknown): ComfyGraph {
  if (!graph || typeof graph !== "object" || Array.isArray(graph))
    throw err("malformed", "ComfyUI graph must be an object keyed by node id.");
  const record: Record<string, unknown> = graph as Record<string, unknown>;
  const out: ComfyGraph = {};
  for (const [id, raw] of Object.entries(record)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw err("malformed", `Graph node "${id}" is not an object.`);
    const node = raw as Record<string, unknown>;
    if (typeof node.class_type !== "string" || node.class_type.length === 0)
      throw err("malformed", `Graph node "${id}" has no class_type.`);
    if (!node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs))
      throw err("malformed", `Graph node "${id}" has no inputs object.`);
    out[id] = {
      class_type: node.class_type,
      inputs: node.inputs as Record<string, unknown>,
    };
  }
  for (const [id, node] of Object.entries(out)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
        if (!out[value[0]])
          throw err(
            "malformed",
            `Graph node "${id}" input "${key}" references missing node "${value[0]}".`,
          );
      }
    }
  }
  if (!Object.values(out).some((node) => node.class_type === "SaveImage"))
    throw err("malformed", "ComfyUI graph has no SaveImage node to write outputs.");
  return out;
}

const PLACEHOLDER = /^\{\{(\w+)\}\}$/;

/** Typed placeholder substitution for API-JSON graphs: "{{seed}}" -> number, etc. */
export function applyPlaceholders(graph: ComfyGraph, params: ComfyGenerationParams): ComfyGraph {
  const values: Record<string, unknown> = {
    positive: params.prompt,
    negative: params.negativePrompt ?? "",
    seed: params.seed,
    steps: params.steps,
    cfg: params.cfgScale,
    width: params.width,
    height: params.height,
    sampler: params.samplerName,
    scheduler: params.scheduler,
    checkpoint: params.checkpoint,
  };
  const next: ComfyGraph = {};
  for (const [id, node] of Object.entries(graph)) {
    const inputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.inputs)) {
      if (typeof value === "string") {
        const match = PLACEHOLDER.exec(value);
        if (match) {
          const name = match[1]!;
          if (!(name in values))
            throw err("malformed", `Graph references unknown placeholder "{{${name}}}".`);
          inputs[key] = values[name];
          continue;
        }
      }
      inputs[key] = value;
    }
    next[id] = { class_type: node.class_type, inputs };
  }
  return next;
}

type FetchLike = (url: string, init?: { method?: string; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface ComfySocketLike {
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}
export type ComfySocketFactory = (url: string) => Promise<ComfySocketLike>;

export class ComfyUiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly options: {
      fetchImpl?: FetchLike;
      socketFactory?: ComfySocketFactory;
      savedWorkflowLoader?: (name: string) => Promise<unknown>;
      now?: () => Date;
    } = {},
  ) {}

  private get fetchImpl(): FetchLike {
    return (
      this.options.fetchImpl ??
      ((url, init) =>
        (globalThis as { fetch: FetchLike }).fetch(url, init))
    );
  }

  async loadWorkflow(source: ComfyWorkflowSource, signal?: AbortSignal): Promise<unknown> {
    if (source.kind === "api-json") return source.graph;
    if (source.kind === "saved") {
      if (!this.options.savedWorkflowLoader)
        throw err("unsupported", "No saved-workflow loader is configured for this ComfyUI host.");
      return this.options.savedWorkflowLoader(source.name);
    }
    return undefined;
  }

  buildGraph(
    source: ComfyWorkflowSource,
    loaded: unknown,
    params: ComfyGenerationParams,
  ): ComfyGraph {
    let graph: ComfyGraph;
    if (source.kind === "default") graph = defaultGraph(params);
    else {
      graph = applyPlaceholders(validateGraph(loaded), params);
    }
    if (params.loras.length > 0)
      graph = applyLoras(graph, params.loras).graph;
    return graph;
  }

  /** Follow an already-submitted prompt WITHOUT re-POSTing /prompt. */
  async followPrompt(
    promptId: string,
    context: { signal: AbortSignal; reportProgress(fraction: number): void; clientId: string },
  ): Promise<{ filename: string; subfolder: string }[]> {
    let closed = false;
    const socket = await this.options.socketFactory?.(
      `${this.baseUrl.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(context.clientId)}`,
    );
    let pendingError: MediaBackendError | undefined;
    socket?.onMessage((data) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "progress" && event.data) {
        const progress = (event.data as Record<string, unknown>).value;
        const max = (event.data as Record<string, unknown>).max;
        if (typeof progress === "number" && typeof max === "number" && max > 0)
          context.reportProgress(Math.min(0.99, progress / max));
      } else if (event.type === "execution_error" && event.data) {
        const detail = (event.data as Record<string, unknown>).exception_message;
        pendingError = err(
          "host-stopped",
          `ComfyUI execution failed: ${String(detail ?? "unknown error")}`,
        );
      }
    });
    socket?.onClose(() => {
      closed = true;
    });
    try {
      const historyUrl = `${this.baseUrl}/history/${encodeURIComponent(promptId)}`;
      for (let attempt = 0; attempt < 240; attempt++) {
        if (context.signal.aborted) throw context.signal.reason ?? new Error("aborted");
        if (pendingError) throw pendingError;
        const history = await this.fetchImpl(historyUrl, { signal: context.signal });
        if (!history.ok)
          throw err("host-stopped", `ComfyUI /history returned HTTP ${history.status}.`);
        const raw = await history.json();
        const entry =
          raw && typeof raw === "object"
            ? (raw as Record<string, unknown>)[promptId]
            : undefined;
        if (entry && typeof entry === "object") {
          const outputs = (entry as Record<string, unknown>).outputs;
          const files: { filename: string; subfolder: string }[] = [];
          if (outputs && typeof outputs === "object")
            for (const nodeOutputs of Object.values(outputs as Record<string, unknown>)) {
              if (!nodeOutputs || typeof nodeOutputs !== "object") continue;
              const images = (nodeOutputs as Record<string, unknown>).images;
              if (!Array.isArray(images)) continue;
              for (const image of images) {
                if (!image || typeof image !== "object") continue;
                const record = image as Record<string, unknown>;
                if (typeof record.filename === "string")
                  files.push({
                    filename: record.filename,
                    subfolder: typeof record.subfolder === "string" ? record.subfolder : "",
                  });
              }
            }
          if (files.length === 0)
            throw err("malformed", "ComfyUI run completed with no output images.");
          return files;
        }
        if (closed && this.options.socketFactory)
          throw err("host-stopped", "ComfyUI progress socket closed before the run completed.");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw err("host-stopped", "ComfyUI run did not complete in time.");
    } finally {
      socket?.close();
    }
  }

  async run(
    graph: ComfyGraph,
    context: {
      signal: AbortSignal;
      reportProgress(fraction: number): void;
      clientId: string;
      onPromptId?(promptId: string): void;
    },
  ): Promise<{ promptId: string; outputs: { filename: string; subfolder: string }[] }> {
    let promptResponse: unknown;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: graph, client_id: context.clientId }),
        signal: context.signal,
      });
      if (!response.ok)
        throw err("host-stopped", `ComfyUI /prompt returned HTTP ${response.status}.`);
      promptResponse = await response.json();
    } catch (error) {
      if (error instanceof MediaBackendError) throw error;
      if (context.signal.aborted) throw error;
      throw err("offline", `ComfyUI at ${this.baseUrl} is not reachable (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (!promptResponse || typeof promptResponse !== "object")
      throw err("malformed", "ComfyUI /prompt returned a non-object response.");
    const promptRecord = promptResponse as Record<string, unknown>;
    if (typeof promptRecord.prompt_id !== "string" || promptRecord.prompt_id.trim() === "")
      throw err(
        "malformed",
        `ComfyUI /prompt returned no prompt_id: ${JSON.stringify(promptRecord.error ?? promptRecord.node_errors ?? {})}`,
      );
    const nodeErrors = promptRecord.node_errors;
    if (
      nodeErrors &&
      typeof nodeErrors === "object" &&
      Object.keys(nodeErrors as Record<string, unknown>).length > 0
    )
      throw err(
        "malformed",
        `ComfyUI rejected the graph: ${JSON.stringify(nodeErrors)}`,
      );
    const promptId = promptRecord.prompt_id;
    context.onPromptId?.(promptId);
    const outputs = await this.followPrompt(promptId, context);
    return { promptId, outputs };
  }

  /** Binary-safe output fetch: raw bytes, never text-decoded. */
  async fetchOutput(file: { filename: string; subfolder: string }, signal?: AbortSignal): Promise<Uint8Array> {
    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder,
      type: "output",
    });
    const response = await this.fetchImpl(
      `${this.baseUrl}/view?${query.toString()}`,
      signal === undefined ? {} : { signal },
    );
    if (!response.ok)
      throw err("host-stopped", `ComfyUI /view returned HTTP ${response.status} for ${file.filename}.`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** Params from a frozen workflow snapshot (IM-05..08 values). */
export function snapshotParams(snapshot: MediaSnapshot): {
  params: ComfyGenerationParams;
  source: ComfyWorkflowSource;
} {
  const definition = snapshot.workflowSnapshot.definition;
  const number_ = (key: string, fallback: number): number => {
    const value = definition[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const text = (key: string, fallback = ""): string =>
    typeof definition[key] === "string" ? (definition[key] as string) : fallback;
  const loras: ComfyLora[] = Array.isArray(definition.loras)
    ? (definition.loras as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        if (typeof record.name !== "string") return [];
        return [
          {
            name: record.name,
            ...(typeof record.strengthModel === "number" ? { strengthModel: record.strengthModel } : {}),
            ...(typeof record.strengthClip === "number" ? { strengthClip: record.strengthClip } : {}),
          },
        ];
      })
    : [];
  const rawSource = definition.workflow;
  let source: ComfyWorkflowSource = { kind: "default" };
  if (rawSource && typeof rawSource === "object") {
    const record = rawSource as Record<string, unknown>;
    if (record.kind === "api-json" && typeof record.graph === "object" && record.graph)
      source = { kind: "api-json", graph: record.graph };
    else if (record.kind === "saved" && typeof record.name === "string")
      source = { kind: "saved", name: record.name };
  }
  return {
    params: {
      prompt: snapshot.prompt,
      ...(typeof definition.negativePrompt === "string"
        ? { negativePrompt: definition.negativePrompt }
        : {}),
      seed: number_("seed", 0),
      steps: number_("steps", 20),
      cfgScale: number_("cfgScale", 7),
      width: number_("width", 512),
      height: number_("height", 512),
      samplerName: text("samplerName", "euler"),
      scheduler: text("scheduler", "normal"),
      checkpoint: text("checkpoint", ""),
      loras,
    },
    source,
  };
}

/** MediaBackendPort adapter over the ComfyUI HTTP + WebSocket API. */
export class ComfyUiMediaBackend implements MediaBackendPort {
  constructor(
    private readonly client: ComfyUiClient,
    private readonly blobSink: (bytes: Uint8Array, mimeType: string) => Promise<string>,
    private readonly mimeType = "image/png",
    private readonly createClientId: () => string = () =>
      crypto.randomUUID(),
  ) {}

  async generate(context: {
    snapshot: MediaSnapshot;
    jobId: string;
    signal: AbortSignal;
    reportProgress(progress: number): Promise<void>;
    reportServerJob(serverJobId: string): void;
  }): Promise<{ outputRefs: string[] }> {
    const { params, source } = snapshotParams(context.snapshot);
    const loaded = await this.client.loadWorkflow(source, context.signal);
    const graph = this.client.buildGraph(source, loaded, params);
    const { outputs } = await this.client.run(graph, {
      signal: context.signal,
      reportProgress: (fraction) => {
        void context.reportProgress(fraction);
      },
      clientId: this.createClientId(),
      onPromptId: (promptId) => context.reportServerJob(promptId),
    });
    return { outputRefs: await this.collectOutputs(outputs, context.signal) };
  }

  /** Reconnect path: follow the recorded prompt id, never resubmit. */
  async resume(context: {
    serverJobId: string;
    snapshot: MediaSnapshot;
    signal: AbortSignal;
    reportProgress(progress: number): Promise<void>;
  }): Promise<{ outputRefs: string[] }> {
    const outputs = await this.client.followPrompt(context.serverJobId, {
      signal: context.signal,
      reportProgress: (fraction) => {
        void context.reportProgress(fraction);
      },
      clientId: this.createClientId(),
    });
    return { outputRefs: await this.collectOutputs(outputs, context.signal) };
  }

  private async collectOutputs(
    files: { filename: string; subfolder: string }[],
    signal: AbortSignal,
  ): Promise<string[]> {
    const outputRefs: string[] = [];
    for (const file of files)
      outputRefs.push(
        await this.blobSink(await this.client.fetchOutput(file, signal), this.mimeType),
      );
    return outputRefs;
  }
}
