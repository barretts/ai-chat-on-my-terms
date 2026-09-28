import { HttpTransportError, type HttpTransport } from "@locallab/network-http";

export interface OllamaModelConnection {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type OllamaModelLifecycle = "installed" | "loaded" | "selected";
export interface OllamaModelInventoryItem {
  readonly id: string;
  readonly name: string;
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly selected: boolean;
  readonly sizeBytes?: number;
  readonly digest?: string;
  readonly expiresAt?: string;
  readonly families?: readonly string[];
  readonly parameterSize?: string;
  readonly quantizationLevel?: string;
}
export interface OllamaModelLifecycleCapabilities {
  readonly listInstalled: true;
  readonly listLoaded: true;
  readonly pull: true;
  readonly cancelPull: true;
  readonly pullProgress: true;
  readonly delete: true;
  readonly selectionOwnedByCaller: true;
}

export type OllamaPullStatus = "running" | "completed" | "canceled" | "failed";
export interface OllamaPullProgress {
  readonly status: OllamaPullStatus;
  readonly digest?: string;
  readonly total?: number;
  readonly completed?: number;
  readonly progress?: number;
  readonly error?: string;
}
export interface OllamaPullOperation {
  readonly id: string;
  readonly model: string;
  readonly signal: AbortSignal;
  readonly result: Promise<OllamaPullProgress>;
  readonly progress: OllamaPullProgress;
  cancel(): void;
}

export class OllamaModelServiceError extends Error {
  constructor(
    readonly operation: "inventory" | "pull" | "delete",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OllamaModelServiceError";
  }
}

export interface OllamaModelServiceOptions {
  readonly transport: HttpTransport;
  readonly resolveConnection: (
    connectionId: string,
  ) => Promise<OllamaModelConnection>;
  readonly createOperationId?: () => string;
}

/** Native Ollama model lifecycle API. Selection belongs to the caller and is
 * only reflected in inventory; failed pulls/deletes never mutate it. */
export class OllamaModelService {
  private readonly pulls = new Map<string, OllamaPullOperation>();
  private readonly pullLocks = new Map<string, string>();
  private readonly modelUsers = new Set<string>();
  private readonly createId: () => string;

  constructor(private readonly options: OllamaModelServiceOptions) {
    this.createId = options.createOperationId ?? (() => crypto.randomUUID());
  }

  capabilities(): OllamaModelLifecycleCapabilities {
    return {
      listInstalled: true,
      listLoaded: true,
      pull: true,
      cancelPull: true,
      pullProgress: true,
      delete: true,
      selectionOwnedByCaller: true,
    };
  }

  async inventory(
    connectionId: string,
    selectedModelId?: string,
    signal?: AbortSignal,
  ): Promise<readonly OllamaModelInventoryItem[]> {
    const connection = await this.options.resolveConnection(connectionId);
    const [tagsResponse, psResponse] = await Promise.all([
      this.request(
        connection,
        "api/tags",
        "GET",
        undefined,
        signal,
        "inventory",
      ),
      this.request(connection, "api/ps", "GET", undefined, signal, "inventory"),
    ]);
    const tags = await readObject(tagsResponse, "inventory");
    const ps = await readObject(psResponse, "inventory");
    const installed = asArray(tags.models).flatMap((row) => {
      if (!isRecord(row)) return [];
      const id = stringField(row, "name") ?? stringField(row, "model");
      return id ? [[id, row] as const] : [];
    });
    const loaded = asArray(ps.models).flatMap((row) => {
      if (!isRecord(row)) return [];
      const id = stringField(row, "name") ?? stringField(row, "model");
      return id ? [[id, row] as const] : [];
    });
    const ids = new Set([
      ...installed.map(([id]) => id),
      ...loaded.map(([id]) => id),
    ]);
    const installedById = new Map(installed);
    const loadedById = new Map(loaded);
    return [...ids].sort().map((id) => {
      const tag = installedById.get(id);
      const active = loadedById.get(id);
      const details = isRecord(tag?.details) ? tag.details : undefined;
      const size = numericField(tag ?? {}, "size");
      const families = Array.isArray(details?.families)
        ? details.families.filter(
            (value): value is string => typeof value === "string",
          )
        : undefined;
      return {
        id,
        name: stringField(tag ?? active ?? {}, "name") ?? id,
        installed: tag !== undefined,
        loaded: active !== undefined,
        selected: id === selectedModelId,
        ...(size === undefined ? {} : { sizeBytes: size }),
        ...(stringField(tag ?? {}, "digest") === undefined
          ? {}
          : { digest: stringField(tag ?? {}, "digest")! }),
        ...(stringField(active ?? {}, "expires_at") === undefined
          ? {}
          : { expiresAt: stringField(active ?? {}, "expires_at")! }),
        ...(families === undefined ? {} : { families }),
        ...(stringField(details ?? {}, "parameter_size") === undefined
          ? {}
          : { parameterSize: stringField(details ?? {}, "parameter_size")! }),
        ...(stringField(details ?? {}, "quantization_level") === undefined
          ? {}
          : {
              quantizationLevel: stringField(
                details ?? {},
                "quantization_level",
              )!,
            }),
      };
    });
  }

  pull(connectionId: string, model: string): OllamaPullOperation {
    validateModel(model);
    const id = this.createId();
    const key = `${connectionId}\u0000${model}`;
    if (this.pullLocks.has(key) || this.modelUsers.has(key))
      throw new OllamaModelServiceError(
        "pull",
        "This model is in use or already being pulled",
      );
    const controller = new AbortController();
    let snapshot: OllamaPullProgress = { status: "running" };
    let resolveResult!: (value: OllamaPullProgress) => void;
    const result = new Promise<OllamaPullProgress>((resolve) => {
      resolveResult = resolve;
    });
    const operation: OllamaPullOperation = {
      id,
      model,
      signal: controller.signal,
      result,
      get progress() {
        return snapshot;
      },
      cancel: () => controller.abort(),
    };
    this.pullLocks.set(key, id);
    this.pulls.set(id, operation);
    void this.performPull(connectionId, model, controller.signal, (value) => {
      snapshot = value;
    })
      .then(
        (value) => {
          snapshot = value;
          resolveResult(value);
        },
        (error: unknown) => {
          snapshot = controller.signal.aborted
            ? { status: "canceled" }
            : { status: "failed", error: publicError(error) };
          resolveResult(snapshot);
        },
      )
      .finally(() => {
        if (this.pullLocks.get(key) === id) this.pullLocks.delete(key);
        this.pulls.delete(id);
      });
    return operation;
  }

  getPull(id: string): OllamaPullOperation | undefined {
    return this.pulls.get(id);
  }

  /** Run chat/model work under a per-connection/model lease. Sharing this
   * service instance with the chat adapter prevents pull/use overlap. */
  async withModelUse<T>(
    connectionId: string,
    model: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const release = this.acquireModelUse(connectionId, model);
    try {
      return await action();
    } finally {
      release();
    }
  }

  /** Acquire a model-use lease that can span an async stream. Release in finally. */
  acquireModelUse(connectionId: string, model: string): () => void {
    validateModel(model);
    const key = `${connectionId}\u0000${model}`;
    if (this.pullLocks.has(key) || this.modelUsers.has(key))
      throw new OllamaModelServiceError(
        "pull",
        "This model is being pulled or already in use",
      );
    this.modelUsers.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.modelUsers.delete(key);
    };
  }

  async delete(
    connectionId: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<void> {
    validateModel(model);
    const connection = await this.options.resolveConnection(connectionId);
    const response = await this.request(
      connection,
      "api/delete",
      "DELETE",
      { model },
      signal,
      "delete",
      true,
    );
    if (!response.ok) throw await responseError(response, "delete");
  }

  private async performPull(
    connectionId: string,
    model: string,
    signal: AbortSignal,
    onProgress: (value: OllamaPullProgress) => void,
  ): Promise<OllamaPullProgress> {
    const connection = await this.options.resolveConnection(connectionId);
    const response = await this.request(
      connection,
      "api/pull",
      "POST",
      { model, stream: true },
      signal,
      "pull",
      true,
    );
    if (!response.ok) throw await responseError(response, "pull");
    if (!response.body)
      throw new OllamaModelServiceError(
        "pull",
        "Ollama returned an empty pull stream",
      );
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let latest: OllamaPullProgress = { status: "running" };
    const consume = (line: string): OllamaPullProgress | undefined => {
      if (!line.trim()) return undefined;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        throw new OllamaModelServiceError(
          "pull",
          "Ollama returned malformed pull progress",
        );
      }
      if (!isRecord(row))
        throw new OllamaModelServiceError(
          "pull",
          "Ollama returned invalid pull progress",
        );
      if (typeof row.error === "string")
        throw new OllamaModelServiceError("pull", row.error);
      const total = numericField(row, "total");
      const completed = numericField(row, "completed");
      const status = stringField(row, "status")?.toLowerCase();
      const progress =
        total && completed !== undefined
          ? Math.min(1, completed / total)
          : undefined;
      latest = {
        status: status === "success" ? "completed" : "running",
        ...(stringField(row, "digest") === undefined
          ? {}
          : { digest: stringField(row, "digest")! }),
        ...(total === undefined ? {} : { total }),
        ...(completed === undefined ? {} : { completed }),
        ...(progress === undefined ? {} : { progress }),
      };
      return latest;
    };
    try {
      while (true) {
        if (signal.aborted) return { status: "canceled" };
        const { value, done } = await readAbortable(reader, signal);
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const value = consume(line.endsWith("\r") ? line.slice(0, -1) : line);
          if (value) onProgress(value);
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const value = consume(buffer);
        if (value) onProgress(value);
      }
      if (latest.status !== "completed")
        throw new OllamaModelServiceError(
          "pull",
          "Ollama pull stream ended before success",
        );
      return latest;
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof HttpTransportError && error.code === "canceled")
      )
        return { status: "canceled" };
      throw error;
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* stream closed */
      }
      reader.releaseLock();
    }
  }

  private async request(
    connection: OllamaModelConnection,
    path: string,
    method: string,
    body: unknown,
    signal: AbortSignal | undefined,
    operation: OllamaModelServiceError["operation"],
    returnErrors = false,
  ): Promise<Response> {
    const url = endpoint(connection.baseUrl, path);
    try {
      return await this.options.transport.request(
        url,
        {
          method,
          ...(connection.headers ? { headers: connection.headers } : {}),
          ...(body === undefined
            ? {}
            : {
                body: JSON.stringify(body),
                headers: {
                  ...connection.headers,
                  "content-type": "application/json",
                  accept:
                    path === "api/pull"
                      ? "application/x-ndjson"
                      : "application/json",
                },
              }),
          ...(signal ? { signal } : {}),
        },
        { ...(signal ? { signal } : {}), returnHttpErrors: returnErrors },
      );
    } catch (error) {
      if (error instanceof HttpTransportError)
        throw new OllamaModelServiceError(
          operation,
          error.message,
          error.status,
        );
      throw new OllamaModelServiceError(operation, "Ollama request failed");
    }
  }
}

async function readAbortable(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted)
    throw new HttpTransportError("canceled", "Pull canceled", true);
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new HttpTransportError("canceled", "Pull canceled", true));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
async function readObject(
  response: Response,
  operation: "inventory",
): Promise<Record<string, unknown>> {
  if (!response.ok) throw await responseError(response, operation);
  try {
    const value: unknown = await response.json();
    if (isRecord(value)) return value;
  } catch {
    /* normalize below */
  }
  throw new OllamaModelServiceError(
    operation,
    "Ollama returned invalid inventory data",
  );
}
async function responseError(
  response: Response,
  operation: OllamaModelServiceError["operation"],
): Promise<OllamaModelServiceError> {
  let message = `Ollama ${operation} failed (HTTP ${response.status})`;
  try {
    const text = (await response.text()).slice(0, 4096);
    const parsed: unknown = JSON.parse(text);
    message =
      isRecord(parsed) && typeof parsed.error === "string"
        ? parsed.error
        : text || message;
  } catch {
    /* bounded fallback */
  }
  return new OllamaModelServiceError(operation, message, response.status);
}
function endpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  )
    throw new TypeError(
      "Ollama host must be an HTTP(S) origin without embedded credentials",
    );
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
function validateModel(model: string): void {
  if (!model.trim() || model.length > 512 || /[\r\n]/.test(model))
    throw new TypeError("Invalid Ollama model name");
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? (value[key] as string) : undefined;
}
function numericField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? (value[key] as number)
    : undefined;
}
function publicError(error: unknown): string {
  return error instanceof Error ? error.message : "Ollama pull failed";
}
