import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  createHttpTransport,
  errorDetails,
  HttpTransportError,
  type FetchLike,
  type HttpTransport,
} from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";

export const DEFAULT_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

/** Persist only these connection settings. The API key itself belongs in SecretStore. */
export interface OpenAIResponsesConnection {
  readonly endpointUrl: string;
  readonly modelId: string;
  readonly apiKeyRef: SecretRef;
}

export interface OpenAIFirstRunOptions {
  readonly secrets: SecretStore;
  readonly resolveConnection: (
    providerConnectionId: string,
  ) => Promise<OpenAIResponsesConnection>;
  /** Runtime fetch is Expo fetch on iOS. Each request gets an exact-origin policy. */
  readonly fetch: FetchLike;
  readonly now?: () => string;
}

export type OpenAIRecoverableCode =
  | "unauthorized"
  | "offline"
  | "missing-model"
  | "malformed"
  | "canceled";

export class OpenAIResponsesError extends Error {
  readonly name = "OpenAIResponsesError";
  constructor(
    readonly code: OpenAIRecoverableCode,
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
  }
}

type EventPayload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp">
    : never
  : never;

/** OpenAI Responses API adapter. It resolves one host-scoped secret at run time and never logs it. */
export function createOpenAIResponsesProvider(
  options: OpenAIFirstRunOptions,
): ProviderPort<OpenAIResponsesConnection> {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async listModels(connection, signal) {
      try {
        const config = validateConnection(connection);
        const headers = await authHeaders(options.secrets, config);
        const transport = createTransport(options.fetch, config.url.origin);
        const modelsUrl = new URL(config.url);
        modelsUrl.pathname = modelsUrl.pathname.replace(
          /\/responses\/?$/i,
          "/models",
        );
        if (modelsUrl.pathname === config.url.pathname)
          throw new OpenAIResponsesError(
            "malformed",
            "Responses endpoint path must end in /responses",
            false,
          );
        modelsUrl.search = "";
        modelsUrl.hash = "";
        const response = await transport.request(
          modelsUrl,
          { headers, ...(signal ? { signal } : {}) },
          signal ? { signal } : {},
        );
        const raw = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch (cause) {
          throw malformed(
            `OpenAI model list contained invalid JSON.\n${errorDetails(cause)}\nServer response:\n${raw}`,
          );
        }
        if (!isRecord(body) || !Array.isArray(body.data))
          throw malformed(
            `OpenAI model list was malformed.\nServer response:\n${raw}`,
          );
        const ids = body.data.flatMap((item) =>
          isRecord(item) && typeof item.id === "string" ? [item.id] : [],
        );
        return { ok: true, value: [...new Set(ids)] };
      } catch (error) {
        return { ok: false, error: toPortError(error) };
      }
    },

    async getCapabilities(_connection, _modelId, signal) {
      if (signal?.aborted) return { ok: false, error: toPortError(canceled()) };
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
      const emit = (value: EventPayload): RunEvent =>
        ({
          ...value,
          runId: request.runId,
          sequence: sequence++,
          timestamp: now(),
        }) as RunEvent;
      let terminal = false;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      yield emit({ type: "RunStarted" });
      try {
        if (controller.signal.aborted) {
          terminal = true;
          yield emit({ type: "RunCanceled", reason: "canceled" });
          return;
        }
        // The connection and its secret are selected by this immutable run binding.
        const connection = await options.resolveConnection(
          request.providerConnectionId,
        );
        const config = validateConnection(connection);
        const headers = await authHeaders(options.secrets, config);
        const transport = createTransport(options.fetch, config.url.origin);
        let completed = false;
        let finishReason = "stop";
        for await (const frame of transport.streamSse(
          config.url,
          {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body: JSON.stringify(toResponsesBody(request)),
            signal: controller.signal,
          },
          { signal: controller.signal },
        )) {
          const data = parseFrame(frame.data);
          if (!data) continue;
          const type = typeof data.type === "string" ? data.type : frame.event;
          if (data.error != null) throw apiFailure(data);
          if (type === "response.output_text.delta") {
            if (typeof data.delta !== "string")
              throw malformed(
                `Responses text delta was malformed.\nServer response:\n${frame.data}`,
              );
            yield emit({ type: "TextDelta", text: data.delta });
          } else if (
            type === "response.reasoning_text.delta" ||
            type === "response.reasoning_summary_text.delta"
          ) {
            if (typeof data.delta !== "string")
              throw malformed(
                `Responses reasoning delta was malformed.\nServer response:\n${frame.data}`,
              );
            yield emit({ type: "ReasoningDelta", text: data.delta });
          } else if (type === "response.completed") {
            if (!isRecord(data.response))
              throw malformed(
                `Responses completion event was malformed.\nServer response:\n${frame.data}`,
              );
            const response = data.response;
            const usage = isRecord(response.usage) ? response.usage : undefined;
            const inputTokens = safeNonnegativeInt(usage?.input_tokens);
            const outputTokens = safeNonnegativeInt(usage?.output_tokens);
            if (inputTokens !== undefined || outputTokens !== undefined)
              yield emit({
                type: "Usage",
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
              });
            completed = true;
            break;
          } else if (type === "response.incomplete") {
            if (!isRecord(data.response))
              throw malformed(
                `Responses incomplete event was malformed.\nServer response:\n${frame.data}`,
              );
            const response = data.response;
            const usage = isRecord(response.usage) ? response.usage : undefined;
            const inputTokens = safeNonnegativeInt(usage?.input_tokens);
            const outputTokens = safeNonnegativeInt(usage?.output_tokens);
            if (inputTokens !== undefined || outputTokens !== undefined)
              yield emit({
                type: "Usage",
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
              });
            completed = true;
            finishReason = "length";
            break;
          } else if (type === "response.failed" || type === "error") {
            throw apiFailure(data);
          } else if (
            type?.startsWith("response.") &&
            !KNOWN_NON_TERMINAL.has(type)
          ) {
            // Future Responses events can be ignored, but malformed payloads for known text deltas cannot.
            continue;
          }
        }
        if (controller.signal.aborted) {
          terminal = true;
          yield emit({ type: "RunCanceled", reason: "canceled" });
        } else if (!completed) {
          throw malformed("Responses stream ended without a completion event");
        } else {
          terminal = true;
          yield emit({ type: "RunCompleted", finishReason });
        }
      } catch (error) {
        terminal = true;
        if (
          controller.signal.aborted ||
          (error instanceof HttpTransportError && error.code === "canceled")
        )
          yield emit({ type: "RunCanceled", reason: "canceled" });
        else {
          const normalized = normalizeError(error);
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
        signal.removeEventListener("abort", abort);
        if (!terminal) controller.abort();
      }
    },
  };
}

const KNOWN_NON_TERMINAL = new Set([
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_item.done",
  "response.output_text.done",
  "response.reasoning_text.done",
  "response.reasoning_summary_text.done",
]);

export function validateResponsesEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw malformed("Enter a valid HTTPS Responses endpoint");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/\/responses\/?$/i.test(url.pathname)
  )
    throw malformed(
      "Responses endpoint must be an HTTPS URL ending in /responses",
    );
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function validateConnection(connection: OpenAIResponsesConnection): {
  url: URL;
  modelId: string;
  apiKeyRef: SecretRef;
} {
  const url = validateResponsesEndpoint(connection.endpointUrl);
  const modelId = connection.modelId.trim();
  if (!modelId || modelId.length > 200)
    throw malformed("Enter a valid model ID");
  if (!connection.apiKeyRef)
    throw new OpenAIResponsesError(
      "unauthorized",
      "Add an API key in secure storage",
      true,
    );
  return { url, modelId, apiKeyRef: connection.apiKeyRef };
}

async function authHeaders(
  secrets: SecretStore,
  config: { url: URL; modelId: string; apiKeyRef: SecretRef },
): Promise<Record<string, string>> {
  try {
    const resolved = await secrets.resolveHeaders(config.url.origin, [
      config.apiKeyRef,
    ]);
    const value = resolved.authorization;
    if (!value || /[\r\n]/.test(value)) throw new Error();
    return { authorization: `Bearer ${value}` };
  } catch (cause) {
    throw new OpenAIResponsesError(
      "unauthorized",
      `The saved API key is unavailable for this endpoint.\n${errorDetails(cause)}`,
      true,
    );
  }
}

function createTransport(fetcher: FetchLike, origin: string): HttpTransport {
  return createHttpTransport({
    fetch: fetcher,
    policy: { authorizedOrigins: [origin] },
  });
}

function toResponsesBody(request: RunRequest): Record<string, unknown> {
  const input = request.context.flatMap(({ kind, value }) => {
    const role = kind === "text" ? "user" : kind;
    if (!["system", "developer", "user", "assistant"].includes(role)) return [];
    const content =
      isRecord(value) && Array.isArray(value.content)
        ? value.content
        : typeof value === "string"
          ? value
          : isRecord(value) && typeof value.content === "string"
            ? value.content
            : isRecord(value) && typeof value.text === "string"
              ? value.text
              : JSON.stringify(value);
    return [{ role, content }];
  });
  const allowed = ["temperature", "top_p", "max_output_tokens"];
  const parameters = Object.fromEntries(
    Object.entries(request.parameters).filter(
      ([key, value]) =>
        allowed.includes(key) &&
        typeof value === "number" &&
        Number.isFinite(value),
    ),
  );
  return {
    model: request.modelId,
    input,
    stream: true,
    ...parameters,
    ...(request.json ? { text: { format: { type: "json_object" } } } : {}),
  };
}

function parseFrame(raw: string): Record<string, unknown> | undefined {
  if (raw.trim() === "[DONE]") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw malformed(
      `Responses stream contained malformed JSON.\n${errorDetails(cause)}\nServer response:\n${raw}`,
    );
  }
  if (!isRecord(value))
    throw malformed(
      `Responses stream contained a malformed event.\nServer response:\n${raw}`,
    );
  return value;
}

function apiFailure(event: Record<string, unknown>): OpenAIResponsesError {
  const classified = classifyApiFailure(event);
  return new OpenAIResponsesError(
    classified.code,
    `${classified.message}\nServer response:\n${JSON.stringify(event, null, 2)}`,
    classified.recoverable,
  );
}
function classifyApiFailure(
  event: Record<string, unknown>,
): OpenAIResponsesError {
  const root = isRecord(event.response) ? event.response : event;
  const error = isRecord(root.error)
    ? root.error
    : isRecord(event.error)
      ? event.error
      : {};
  const code = typeof error.code === "string" ? error.code : "";
  const type = typeof error.type === "string" ? error.type : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (
    /model_not_found|invalid_model|model.*not.*found|does not exist/i.test(
      `${code} ${type} ${message}`,
    )
  )
    return new OpenAIResponsesError(
      "missing-model",
      "The selected model is unavailable for this API key",
      false,
    );
  if (
    /invalid_api_key|authentication|unauthorized|api key/i.test(
      `${code} ${type} ${message}`,
    )
  )
    return new OpenAIResponsesError(
      "unauthorized",
      "OpenAI rejected the saved API key",
      false,
    );
  return new OpenAIResponsesError(
    "malformed",
    "The Responses API reported a request error",
    false,
  );
}

function malformed(
  message = "OpenAI Responses returned an invalid response",
): OpenAIResponsesError {
  return new OpenAIResponsesError("malformed", message, false);
}
function canceled(): OpenAIResponsesError {
  return new OpenAIResponsesError("canceled", "OpenAI request canceled", true);
}
function normalizeError(error: unknown): OpenAIResponsesError {
  const classified = classifyError(error);
  const detail = errorDetails(error);
  return classified.message.includes(detail)
    ? classified
    : new OpenAIResponsesError(
        classified.code,
        `${classified.message}\n${detail}`,
        classified.recoverable,
      );
}
function classifyError(error: unknown): OpenAIResponsesError {
  if (error instanceof OpenAIResponsesError) return error;
  if (error instanceof HttpTransportError) {
    if (error.code === "unauthorized" || error.code === "forbidden")
      return new OpenAIResponsesError(
        "unauthorized",
        "OpenAI rejected the saved API key",
        false,
      );
    if (error.status === 404)
      return new OpenAIResponsesError(
        "missing-model",
        "The selected model or Responses endpoint is unavailable",
        false,
      );
    if (error.code === "malformed_stream" || error.code === "stream_too_large")
      return malformed();
    if (error.code === "canceled") return canceled();
    return new OpenAIResponsesError(
      "offline",
      error.code === "timeout"
        ? "OpenAI request timed out"
        : "Could not connect to OpenAI",
      true,
    );
  }
  if (error instanceof SyntaxError) return malformed();
  return new OpenAIResponsesError("offline", "OpenAI request failed", true);
}
function toPortError(error: unknown) {
  const normalized = normalizeError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    recoverable: normalized.recoverable,
    backend: "openai-responses",
  };
}
function safeNonnegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
