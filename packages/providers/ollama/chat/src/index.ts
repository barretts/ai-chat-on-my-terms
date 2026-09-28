import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import { HttpTransportError, type HttpTransport } from "@locallab/network-http";
import type { OllamaModelService } from "@locallab/provider-ollama-models";

/** Resolved connection data is supplied by the host at request time. */
export interface OllamaConnection {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Ollama accepts a duration such as "5m", "0", or a number of seconds. */
  readonly keepAlive?: string | number;
}

export interface OllamaChatOptions {
  readonly transport: HttpTransport;
  readonly resolveConnection: (
    providerConnectionId: string,
  ) => Promise<OllamaConnection>;
  readonly now?: () => string;
  readonly timeoutMs?: number;
  /** Share this instance with model pulls to exclude pull/chat overlap. */
  readonly modelService?: Pick<OllamaModelService, "acquireModelUse">;
}

type Payload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp">
    : never
  : never;

/** Ollama's native /api/chat NDJSON adapter. The request's immutable binding is
 * resolved by providerConnectionId and modelId on every start, including retry
 * or regenerate requests created from the same binding. */
export function createOllamaChatProvider(
  options: OllamaChatOptions,
): ProviderPort<OllamaConnection> {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async listModels(connection, signal) {
      try {
        const response = await options.transport.request(
          endpoint(connection.baseUrl, "api/tags"),
          {
            ...(connection.headers ? { headers: connection.headers } : {}),
            ...(signal ? { signal } : {}),
          },
          signal ? { signal } : {},
        );
        const body = (await response.json()) as {
          models?: Array<{ name?: unknown; model?: unknown }>;
        };
        return {
          ok: true,
          value: (body.models ?? []).flatMap((item) => {
            const id = typeof item.name === "string" ? item.name : item.model;
            return typeof id === "string" ? [id] : [];
          }),
        };
      } catch (error) {
        return {
          ok: false,
          error: normalizeError(
            error,
            signal?.aborted,
            "Ollama model catalog request failed",
          ),
        };
      }
    },

    async getCapabilities(_connection, _modelId, signal) {
      if (signal?.aborted)
        return {
          ok: false,
          error: normalizeError(
            undefined,
            true,
            "Ollama capability request canceled",
          ),
        };
      return {
        ok: true,
        value: {
          streaming: "yes",
          tools: "unknown",
          reasoning: "unknown",
          vision: "unknown",
        },
      };
    },

    async *startRun(
      request: RunRequest,
      signal: AbortSignal,
    ): AsyncIterable<RunEvent> {
      let sequence = 0;
      let terminal = false;
      const emit = (value: Payload): RunEvent =>
        ({
          ...value,
          runId: request.runId,
          sequence: sequence++,
          timestamp: now(),
        }) as RunEvent;
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let releaseModelUse: (() => void) | undefined;
      yield emit({ type: "RunStarted" });
      try {
        if (controller.signal.aborted) {
          terminal = true;
          yield emit({ type: "RunCanceled", reason: "canceled" });
          return;
        }
        const connection = await options.resolveConnection(
          request.providerConnectionId,
        );
        releaseModelUse = options.modelService?.acquireModelUse(
          request.providerConnectionId,
          request.modelId,
        );
        const configuredKeepAlive = request.parameters.keep_alive;
        const keepAlive =
          typeof configuredKeepAlive === "string" ||
          typeof configuredKeepAlive === "number"
            ? configuredKeepAlive
            : connection.keepAlive;
        const body = toOllamaRequest(request, keepAlive);
        const response = await options.transport.request(
          endpoint(connection.baseUrl, "api/chat"),
          {
            method: "POST",
            headers: {
              ...connection.headers,
              "content-type": "application/json",
              accept: "application/x-ndjson",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
          {
            signal: controller.signal,
            ...(options.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.timeoutMs }),
            returnHttpErrors: true,
          },
        );
        if (!response.ok) {
          const detail = await boundedErrorDetail(response);
          if (response.status === 401 || response.status === 403)
            throw new HttpTransportError(
              response.status === 401 ? "unauthorized" : "forbidden",
              "Ollama access was denied",
              false,
              response.status,
            );
          throw new OllamaBackendError(detail || `HTTP ${response.status}`);
        }
        if (!response.body)
          throw new OllamaProtocolError("Ollama returned an empty stream");
        reader = response.body.getReader();
        const activeReader = reader;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let buffer = "";
        let doneReason: string | undefined;
        let usageIn: number | undefined;
        let usageOut: number | undefined;
        const tools = new Map<number, { name: string; arguments: string }>();
        const consumeLine = (line: string): RunEvent[] => {
          if (!line.trim()) return [];
          let chunk: OllamaChunk;
          try {
            chunk = JSON.parse(line) as OllamaChunk;
          } catch {
            throw new OllamaProtocolError("Ollama returned malformed NDJSON");
          }
          if (chunk.error) throw new OllamaBackendError(chunk.error);
          const events: RunEvent[] = [];
          const message = chunk.message;
          if (typeof message?.thinking === "string" && message.thinking)
            events.push(
              emit({ type: "ReasoningDelta", text: message.thinking }),
            );
          if (typeof message?.content === "string" && message.content)
            events.push(emit({ type: "TextDelta", text: message.content }));
          for (const [position, call] of (
            message?.tool_calls ?? []
          ).entries()) {
            const index = Number.isInteger(call.index) ? call.index! : position;
            const current = tools.get(index) ?? { name: "", arguments: "" };
            if (typeof call.function?.name === "string")
              current.name += call.function.name;
            const args = call.function?.arguments;
            current.arguments +=
              typeof args === "string"
                ? args
                : args === undefined
                  ? ""
                  : JSON.stringify(args);
            tools.set(index, current);
          }
          if (Number.isInteger(chunk.prompt_eval_count))
            usageIn = chunk.prompt_eval_count;
          if (Number.isInteger(chunk.eval_count)) usageOut = chunk.eval_count;
          if (chunk.done) {
            doneReason =
              typeof chunk.done_reason === "string"
                ? chunk.done_reason
                : "stop";
            if (usageIn !== undefined || usageOut !== undefined)
              events.push(
                emit({
                  type: "Usage",
                  ...(usageIn === undefined ? {} : { inputTokens: usageIn }),
                  ...(usageOut === undefined ? {} : { outputTokens: usageOut }),
                }),
              );
            for (const [index, tool] of [...tools.entries()].sort(
              ([a], [b]) => a - b,
            )) {
              if (!tool.name || !request.permittedTools.includes(tool.name))
                continue;
              let input: unknown = tool.arguments;
              try {
                input = JSON.parse(tool.arguments);
              } catch {
                /* preserve incomplete/raw provider arguments */
              }
              events.push(
                emit({
                  type: "ToolCall",
                  invocationId: invocationId(request.runId, index),
                  name: tool.name,
                  input,
                }),
              );
            }
          }
          return events;
        };
        let streamDone = false;
        while (!streamDone) {
          const read = await activeReader.read();
          buffer += decoder.decode(read.value, { stream: !read.done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const raw of lines) {
            for (const event of consumeLine(
              raw.endsWith("\r") ? raw.slice(0, -1) : raw,
            ))
              yield event;
          }
          streamDone = read.done;
        }
        if (buffer.trim()) for (const event of consumeLine(buffer)) yield event;
        if (controller.signal.aborted) {
          terminal = true;
          yield emit({ type: "RunCanceled", reason: "canceled" });
        } else if (doneReason === undefined) {
          throw new OllamaDisconnectError();
        } else {
          terminal = true;
          yield emit({ type: "RunCompleted", finishReason: doneReason });
        }
      } catch (error) {
        terminal = true;
        if (controller.signal.aborted || isCanceled(error))
          yield emit({ type: "RunCanceled", reason: "canceled" });
        else {
          const normalized = normalizeError(
            error,
            false,
            "Ollama chat request failed",
          );
          yield emit({
            type: "RunFailed",
            error: {
              code: normalized.code,
              message: normalized.message,
              recoverable: normalized.recoverable,
            },
          });
        }
      } finally {
        releaseModelUse?.();
        signal.removeEventListener("abort", abort);
        if (!terminal) controller.abort();
        if (reader) {
          try {
            await reader.cancel();
          } catch {
            /* already closed */
          }
        }
      }
    },
  };
}

async function boundedErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length > 8192) return text.slice(0, 8192);
    try {
      const value: unknown = JSON.parse(text);
      if (isRecord(value) && typeof value.error === "string")
        return value.error;
    } catch {
      // Keep small plain-text Ollama error bodies classifiable.
    }
    return text;
  } catch {
    return "";
  }
}

interface OllamaChunk {
  readonly error?: string;
  readonly message?: {
    readonly content?: unknown;
    readonly thinking?: unknown;
    readonly tool_calls?: Array<{
      index?: number;
      function?: { name?: unknown; arguments?: unknown };
    }>;
  };
  readonly done?: boolean;
  readonly done_reason?: unknown;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

function toOllamaRequest(request: RunRequest, keepAlive?: string | number) {
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request.parameters)) {
    if (["keep_alive", "tools", "format", "think"].includes(key)) continue;
    options[key] = value;
  }
  const embeddedTools = request.parameters.tools;
  const tools = Array.isArray(embeddedTools)
    ? embeddedTools.filter((item) => {
        const name = (item as { function?: { name?: unknown } })?.function
          ?.name;
        return (
          typeof name === "string" && request.permittedTools.includes(name)
        );
      })
    : undefined;
  const messages = request.context
    .filter(({ kind }) => kind !== "tool-definitions")
    .map(({ kind, value }) => {
      if (isRecord(value) && typeof value.role === "string") return value;
      return {
        role: kind === "assistant" || kind === "system" ? kind : "user",
        content: typeof value === "string" ? value : JSON.stringify(value),
      };
    });
  return {
    model: request.modelId,
    messages,
    stream: true,
    ...(Object.keys(options).length ? { options } : {}),
    ...(keepAlive === undefined ? {} : { keep_alive: keepAlive }),
    ...(request.reasoning ? { think: true } : {}),
    ...(request.json ? { format: "json" } : {}),
    ...(tools?.length ? { tools } : {}),
  };
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

function invocationId(runId: string, index: number): string {
  const hex = (Math.max(0, index) + 1)
    .toString(16)
    .slice(-12)
    .padStart(12, "0");
  const tail = runId.slice(-12);
  const mixed = (BigInt(`0x${tail}`) ^ BigInt(`0x${hex}`))
    .toString(16)
    .padStart(12, "0");
  return `${runId.slice(0, -12)}${mixed}`;
}

class OllamaProtocolError extends Error {}
class OllamaDisconnectError extends Error {}
class OllamaBackendError extends Error {
  constructor(message: string) {
    super(message);
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isCanceled(error: unknown): boolean {
  return error instanceof HttpTransportError && error.code === "canceled";
}

function normalizeError(
  error: unknown,
  canceled: boolean | undefined,
  fallback: string,
) {
  if (canceled || isCanceled(error))
    return {
      code: "canceled" as const,
      message: "Ollama request canceled",
      recoverable: true,
      backend: "ollama",
    };
  if (error instanceof OllamaBackendError) {
    const message = error.message.toLowerCase();
    if (
      /context length|context window|too many tokens|input length/.test(message)
    )
      return {
        code: "context-full" as const,
        message: "Ollama context limit exceeded",
        recoverable: false,
        backend: "ollama",
      };
    if (/model .* not found|pull model/.test(message))
      return {
        code: "missing-model" as const,
        message: "Ollama model is unavailable",
        recoverable: false,
        backend: "ollama",
      };
    return {
      code: "malformed" as const,
      message: "Ollama rejected the chat request",
      recoverable: false,
      backend: "ollama",
    };
  }
  if (error instanceof OllamaProtocolError)
    return {
      code: "malformed" as const,
      message: error.message,
      recoverable: false,
      backend: "ollama",
    };
  if (error instanceof OllamaDisconnectError)
    return {
      code: "offline" as const,
      message: "Ollama stream disconnected before completion",
      recoverable: true,
      backend: "ollama",
    };
  if (error instanceof HttpTransportError) {
    const code =
      error.code === "unauthorized" || error.code === "forbidden"
        ? ("unauthorized" as const)
        : error.code === "timeout"
          ? ("timeout" as const)
          : error.code === "canceled"
            ? ("canceled" as const)
            : ("offline" as const);
    return {
      code,
      message:
        code === "unauthorized"
          ? "Ollama access was denied"
          : code === "timeout"
            ? "Ollama request timed out"
            : "Ollama connection failed",
      recoverable: error.recoverable,
      backend: "ollama",
    };
  }
  return {
    code: "offline" as const,
    message: fallback,
    recoverable: true,
    backend: "ollama",
  };
}
