import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";

export interface DirectHttpConnection {
  /** The provider's own OpenAI-compatible API origin, such as https://api.example/v1. */
  baseUrl: string;
  /** Optional ephemeral BYOK value. It is used only to construct the Authorization header. */
  apiKey?: string;
  /** Allows providers that use a compatible but non-standard authentication header. */
  headers?: Readonly<Record<string, string>>;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ExpoStreamingProviderOptions {
  fetch: FetchLike;
  resolveConnection: (
    providerConnectionId: string,
  ) => Promise<DirectHttpConnection>;
  now?: () => string;
}

type EventPayload<T = RunEvent> = T extends RunEvent
  ? Omit<T, "runId" | "sequence" | "timestamp">
  : never;

/**
 * OpenAI-compatible SSE transport intended for Expo's fetch implementation.
 * Credentials are resolved at request time, never placed in the run request,
 * URL, emitted events, diagnostics, or error text.
 */
export function createExpoStreamingProviderPort(
  options: ExpoStreamingProviderOptions,
): ProviderPort<DirectHttpConnection> {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async listModels(connection, signal) {
      try {
        const response = await options.fetch(
          endpoint(connection.baseUrl, "models"),
          {
            method: "GET",
            headers: requestHeaders(connection),
            ...(signal ? { signal } : {}),
          },
        );
        if (!response.ok)
          return failure("unauthorized", "Provider model request failed");
        const body = (await response.json()) as {
          data?: Array<{ id?: unknown }>;
        };
        return {
          ok: true,
          value: (body.data ?? []).flatMap((item) =>
            typeof item.id === "string" ? [item.id] : [],
          ),
        };
      } catch (error) {
        return failure(
          signal?.aborted ? "canceled" : "offline",
          "Provider model request failed",
        );
      }
    },

    async getCapabilities(_connection, _modelId, signal) {
      if (signal?.aborted)
        return failure("canceled", "Capability request canceled");
      return {
        ok: true,
        value: { streaming: "yes", tools: "unknown", vision: "unknown" },
      };
    },

    async *startRun(
      request: RunRequest,
      signal: AbortSignal,
    ): AsyncIterable<RunEvent> {
      const runId = request.runId;
      let sequence = 0;
      const event = (value: EventPayload): RunEvent =>
        ({
          ...value,
          runId,
          sequence: sequence++,
          timestamp: now(),
        }) as RunEvent;
      let terminal = false;
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(signal.reason);
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener("abort", abortFromCaller, { once: true });

      yield event({ type: "RunStarted" });

      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        if (controller.signal.aborted) {
          terminal = true;
          yield event({ type: "RunCanceled", reason: "canceled" });
          return;
        }
        const connection = await options.resolveConnection(
          request.providerConnectionId,
        );
        const response = await options.fetch(
          endpoint(connection.baseUrl, "chat/completions"),
          {
            method: "POST",
            headers: {
              ...requestHeaders(connection),
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body: JSON.stringify(toChatRequest(request)),
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) {
          terminal = true;
          yield event({
            type: "RunFailed",
            error: {
              code:
                response.status === 401 || response.status === 403
                  ? "unauthorized"
                  : "offline",
              message: "Provider streaming request failed",
              recoverable: response.status >= 500,
            },
          });
          return;
        }

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let doneMarker = false;
        while (!doneMarker) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.endsWith("\r")
              ? rawLine.slice(0, -1)
              : rawLine;
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trimStart();
            if (data === "[DONE]") {
              doneMarker = true;
              break;
            }
            if (!data) continue;
            const parsed = parseChunk(data, runId);
            if (parsed === undefined) continue;
            for (const delta of parsed) yield event(delta as EventPayload);
          }
          if (done) break;
        }
        if (controller.signal.aborted) {
          terminal = true;
          yield event({ type: "RunCanceled", reason: "canceled" });
        } else {
          terminal = true;
          yield event({ type: "RunCompleted", finishReason: "stop" });
        }
      } catch {
        terminal = true;
        if (controller.signal.aborted) {
          yield event({ type: "RunCanceled", reason: "canceled" });
        } else {
          yield event({
            type: "RunFailed",
            error: {
              code: "offline",
              message: "Provider streaming request failed",
              recoverable: true,
            },
          });
        }
      } finally {
        signal.removeEventListener("abort", abortFromCaller);
        if (reader) {
          try {
            await reader.cancel();
          } catch {
            /* stream already closed */
          }
        }
        // Breaking iteration also closes the transport, even if caller forgot to abort.
        if (!terminal) controller.abort();
      }
    },
  };
}

function failure(
  code: "canceled" | "offline" | "unauthorized",
  message: string,
) {
  return {
    ok: false as const,
    error: {
      code,
      message,
      recoverable: code !== "unauthorized",
      backend: "openai-compatible",
    },
  };
}

function endpoint(baseUrl: string, resource: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new TypeError("Provider URL must use HTTP or HTTPS");
  if (url.username || url.password)
    throw new TypeError("Provider credentials must be supplied as headers");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${resource}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function requestHeaders(
  connection: DirectHttpConnection,
): Record<string, string> {
  const headers = { ...connection.headers };
  if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
  return headers;
}

function toChatRequest(request: RunRequest) {
  const messages = request.context.map(({ kind, value }) => {
    if (
      value &&
      typeof value === "object" &&
      "role" in value &&
      "content" in value
    )
      return value;
    return {
      role: kind === "system" || kind === "assistant" ? kind : "user",
      content: typeof value === "string" ? value : JSON.stringify(value),
    };
  });
  return {
    ...request.parameters,
    model: request.modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
}

function parseChunk(
  data: string,
  runId: string,
): Array<Record<string, unknown>> | undefined {
  let chunk: any;
  try {
    chunk = JSON.parse(data);
  } catch {
    return undefined;
  }
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta;
  if (!delta) return undefined;
  const events: Array<Record<string, unknown>> = [];
  if (typeof delta.content === "string" && delta.content.length)
    events.push({ type: "TextDelta", text: delta.content });
  if (Array.isArray(delta.content)) {
    for (const item of delta.content)
      if (item?.type === "text" && typeof item.text === "string")
        events.push({ type: "TextDelta", text: item.text });
  }
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === "string" && reasoning.length)
    events.push({ type: "ReasoningDelta", text: reasoning });
  for (const tool of delta.tool_calls ?? []) {
    if (tool?.function?.name || tool?.function?.arguments) {
      const index = Number.isInteger(tool?.index) ? tool.index : 0;
      // Invocation IDs are domain UUIDv7s; retain this run's UUID prefix and
      // reserve the tail for the provider's per-run tool index.
      const invocationId = `${runId.slice(0, -12)}${Math.max(0, index).toString(16).padStart(12, "0").slice(-12)}`;
      events.push({
        type: "ToolCall",
        invocationId,
        name: tool.function?.name ?? "pending",
        input: tool.function?.arguments ?? "",
      });
    }
  }
  return events;
}
