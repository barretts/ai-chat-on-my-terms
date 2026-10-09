import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  createHttpTransport,
  errorDetails,
  HttpTransportError,
  type FetchLike,
} from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";

export interface OpenAIAdvancedConnection {
  endpointUrl: string;
  modelId: string;
  apiKeyRef: SecretRef;
}
export interface OpenAIAdvancedOptions {
  secrets: SecretStore;
  resolveConnection(id: string): Promise<OpenAIAdvancedConnection>;
  fetch: FetchLike;
  now?: () => string;
}
export class OpenAIAdvancedError extends Error {
  readonly name = "OpenAIAdvancedError";
  constructor(
    readonly code:
      | "unauthorized"
      | "offline"
      | "missing-model"
      | "malformed"
      | "unsupported"
      | "canceled"
      | "quota",
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

/** Encode the advanced request surface independently of transport/composition. */
export function encodeOpenAIAdvancedRequest(
  request: RunRequest,
): Record<string, unknown> {
  const input = request.context.flatMap(({ kind, value }) => {
    if (!["system", "developer", "user", "assistant"].includes(kind)) return [];
    return [{ role: kind, content: openAIContent(value) }];
  });
  const definitions = request.context.find(
    ({ kind }) => kind === "tool-definitions",
  )?.value;
  const byName = new Map<string, unknown>();
  if (Array.isArray(definitions))
    for (const item of definitions)
      if (record(item) && typeof item.name === "string")
        byName.set(item.name, item);
  const tools = request.permittedTools.flatMap((name) => {
    const definition = byName.get(name);
    if (record(definition))
      return [
        {
          type: "function",
          name,
          description:
            typeof definition.description === "string"
              ? definition.description
              : undefined,
          parameters: record(definition.parameters)
            ? definition.parameters
            : { type: "object", properties: {} },
          strict: definition.strict === true,
        },
      ];
    // A permitted name without a schema cannot safely be advertised to the model.
    return [];
  });
  const p = request.parameters;
  const body: Record<string, unknown> = {
    model: request.modelId,
    input,
    stream: true,
  };
  for (const key of [
    "temperature",
    "top_p",
    "max_output_tokens",
    "frequency_penalty",
    "presence_penalty",
  ] as const)
    if (typeof p[key] === "number" && Number.isFinite(p[key]))
      body[key] = p[key];
  if (request.reasoning)
    body.reasoning = {
      effort: oneOf(p.reasoning_effort, ["low", "medium", "high"], "medium"),
      summary: "auto",
    };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (request.json) body.text = { format: { type: "json_object" } };
  return body;
}

function openAIContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    if (record(value) && Array.isArray(value.content))
      return openAIContent(value.content);
    if (record(value) && typeof value.text === "string") return value.text;
    if (record(value) && Array.isArray(value.parts))
      return openAIContent(value.parts);
    return JSON.stringify(value);
  }
  const content: unknown[] = [];
  for (const part of value) {
    if (!record(part)) continue;
    if (
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string"
    )
      content.push({ type: "input_text", text: part.text });
    if (part.type === "image" || part.type === "input_image") {
      const url =
        typeof part.image_url === "string"
          ? part.image_url
          : typeof part.url === "string"
            ? part.url
            : typeof part.dataUrl === "string"
              ? part.dataUrl
              : typeof part.data === "string" &&
                  typeof part.mediaType === "string"
                ? `data:${part.mediaType};base64,${part.data}`
                : undefined;
      if (url && isAllowedImageUrl(url))
        content.push({ type: "input_image", image_url: url });
      else
        throw new OpenAIAdvancedError(
          "unsupported",
          "Resolve image attachments to HTTPS URLs or supported base64 image data before sending",
          false,
        );
    }
  }
  return content;
}
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
function isAllowedImageUrl(value: string): boolean {
  if (value.length > 20_000_000) return false;
  if (
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(
      value,
    )
  )
    return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Converts Responses API frames to the frozen event vocabulary. */
export function decodeOpenAIAdvancedFrame(
  data: Record<string, unknown>,
  event?: string,
  runId = "",
): EventPayload[] {
  const type = typeof data.type === "string" ? data.type : event;
  if (type === "response.output_text.delta" && typeof data.delta === "string")
    return [{ type: "TextDelta", text: data.delta }];
  if (
    (type === "response.reasoning_text.delta" ||
      type === "response.reasoning_summary_text.delta") &&
    typeof data.delta === "string"
  )
    return [{ type: "ReasoningDelta", text: data.delta }];
  if (
    type === "response.output_item.done" &&
    record(data.item) &&
    data.item.type === "function_call"
  ) {
    const item = data.item;
    const name = typeof item.name === "string" ? item.name : "";
    const args =
      typeof item.arguments === "string"
        ? parseJson(item.arguments)
        : item.arguments;
    const callId =
      typeof item.call_id === "string"
        ? item.call_id
        : typeof item.id === "string"
          ? item.id
          : "";
    if (name && callId && args !== undefined)
      return [
        {
          type: "ToolCall",
          invocationId: stableUuid(`${runId}:${callId}`),
          name,
          input: args,
        },
      ];
    throw malformed(
      `OpenAI returned a malformed function call.\nServer response:\n${JSON.stringify(data, null, 2)}`,
    );
  }
  if (
    type === "response.output_text.annotation.added" &&
    record(data.annotation) &&
    data.annotation.type === "url_citation" &&
    typeof data.annotation.url === "string"
  )
    return [
      {
        type: "Source",
        url: data.annotation.url,
        ...(typeof data.annotation.title === "string"
          ? { title: data.annotation.title }
          : {}),
      },
    ];
  if (
    type === "response.completed" &&
    record(data.response) &&
    record(data.response.usage)
  ) {
    const usage = data.response.usage;
    const inputTokens = integer(usage.input_tokens),
      outputTokens = integer(usage.output_tokens);
    return inputTokens === undefined && outputTokens === undefined
      ? []
      : [
          {
            type: "Usage",
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
          },
        ];
  }
  return [];
}

/** Stable T025 composition point for the T021A core transport. */
export const openAIAdvancedExtension = Object.freeze({
  encodeRequest: encodeOpenAIAdvancedRequest,
  decodeFrame: decodeOpenAIAdvancedFrame,
});

/** Advanced OpenAI Responses adapter. T025 may compose these codecs with its core provider transport. */
export function createOpenAIAdvancedProvider(
  options: OpenAIAdvancedOptions,
): ProviderPort<OpenAIAdvancedConnection> {
  const now = options.now ?? (() => new Date().toISOString());
  const base = (url: URL) =>
    createHttpTransport({
      fetch: options.fetch,
      policy: { authorizedOrigins: [url.origin] },
    });
  return {
    async listModels(connection, signal) {
      try {
        const url = endpoint(connection.endpointUrl);
        const modelsUrl = new URL(url);
        modelsUrl.pathname = modelsUrl.pathname.replace(
          /\/responses\/?$/i,
          "/models",
        );
        const response = await base(url).request(
          modelsUrl,
          {
            headers: await headers(
              options.secrets,
              connection.apiKeyRef,
              url.origin,
            ),
            ...(signal ? { signal } : {}),
          },
          { ...(signal ? { signal } : {}) },
        );
        const raw = await response.text();
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch (cause) {
          throw malformed(
            `OpenAI model list contained invalid JSON.\n${errorDetails(cause)}\nServer response:\n${raw}`,
          );
        }
        if (!record(value) || !Array.isArray(value.data))
          throw malformed(
            `OpenAI model list was malformed.\nServer response:\n${raw}`,
          );
        return {
          ok: true,
          value: value.data.flatMap((m) =>
            record(m) && typeof m.id === "string" ? [m.id] : [],
          ),
        };
      } catch (e) {
        return { ok: false, error: portError(e) };
      }
    },
    async getCapabilities(_connection, _modelId, signal) {
      if (signal?.aborted)
        return {
          ok: false,
          error: portError(
            new OpenAIAdvancedError("canceled", "Request canceled", true),
          ),
        };
      return {
        ok: true,
        value: {
          streaming: "yes",
          reasoning: "yes",
          tools: "yes",
          vision: "yes",
        },
      };
    },
    async *startRun(request, signal) {
      let seq = 0,
        terminal = false;
      const emit = (e: EventPayload) =>
        ({
          ...e,
          runId: request.runId,
          sequence: seq++,
          timestamp: now(),
        }) as RunEvent;
      const abort = new AbortController();
      const cancel = () => abort.abort(signal.reason);
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
      yield emit({ type: "RunStarted" });
      try {
        if (abort.signal.aborted) {
          terminal = true;
          yield emit({ type: "RunCanceled", reason: "canceled" });
          return;
        }
        const connection = await options.resolveConnection(
          request.providerConnectionId,
        );
        const url = endpoint(connection.endpointUrl);
        const auth = await headers(
          options.secrets,
          connection.apiKeyRef,
          url.origin,
        );
        let completed = false;
        for await (const frame of base(url).streamSse(
          url,
          {
            method: "POST",
            headers: {
              ...auth,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body: JSON.stringify(encodeOpenAIAdvancedRequest(request)),
            signal: abort.signal,
          },
          { signal: abort.signal },
        )) {
          if (frame.data.trim() === "[DONE]") continue;
          let data: unknown;
          try {
            data = JSON.parse(frame.data);
          } catch (cause) {
            throw malformed(
              `Responses stream contained invalid JSON.\n${errorDetails(cause)}\nServer response:\n${frame.data}`,
            );
          }
          if (!record(data))
            throw malformed(
              `Responses stream event was malformed.\nServer response:\n${frame.data}`,
            );
          const type = typeof data.type === "string" ? data.type : frame.event;
          if (
            type === "response.failed" ||
            type === "error" ||
            data.error != null
          )
            throw apiError(data);
          for (const value of decodeOpenAIAdvancedFrame(
            data,
            frame.event,
            request.runId,
          )) {
            if (
              value.type !== "ToolCall" ||
              request.permittedTools.includes(value.name)
            )
              yield emit(value);
          }
          if (type === "response.completed") completed = true;
        }
        if (abort.signal.aborted) {
          terminal = true;
          yield emit({ type: "RunCanceled", reason: "canceled" });
        } else if (!completed)
          throw malformed("Responses stream ended without completion");
        else {
          terminal = true;
          yield emit({ type: "RunCompleted", finishReason: "stop" });
        }
      } catch (error) {
        terminal = true;
        if (
          abort.signal.aborted ||
          (error instanceof HttpTransportError && error.code === "canceled")
        )
          yield emit({ type: "RunCanceled", reason: "canceled" });
        else {
          const e = normalize(error);
          yield emit({
            type: "RunFailed",
            error: {
              code: e.code,
              message: e.message,
              recoverable: e.recoverable,
            },
          });
        }
      } finally {
        signal.removeEventListener("abort", cancel);
        if (!terminal) abort.abort();
      }
    },
  };
}
function endpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw malformed("Invalid endpoint");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/\/responses\/?$/i.test(url.pathname)
  )
    throw malformed("Endpoint must be an HTTPS Responses URL");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}
async function headers(
  secrets: SecretStore,
  ref: SecretRef,
  host: string,
): Promise<Record<string, string>> {
  try {
    const value = (await secrets.resolveHeaders(host, [ref])).authorization;
    if (!value || /[\r\n]/.test(value)) throw new Error();
    const key = value.trim().replace(/^(?:Bearer(?:\s+|$))+/i, "");
    if (!key) throw new Error();
    return { authorization: `Bearer ${key}` };
  } catch (cause) {
    throw new OpenAIAdvancedError(
      "unauthorized",
      `Saved API key is unavailable for this endpoint.\n${errorDetails(cause)}`,
      true,
    );
  }
}
function apiError(data: Record<string, unknown>): OpenAIAdvancedError {
  const classified = classifyApiError(data);
  return new OpenAIAdvancedError(
    classified.code,
    `${classified.message}\nServer response:\n${JSON.stringify(data, null, 2)}`,
    classified.recoverable,
  );
}
function classifyApiError(data: Record<string, unknown>): OpenAIAdvancedError {
  const root = record(data.response) ? data.response : data;
  const error = record(root.error)
    ? root.error
    : record(data.error)
      ? data.error
      : {};
  const code = `${error.code ?? ""} ${error.type ?? ""}`;
  if (/model.*not.*found|invalid_model/i.test(code))
    return new OpenAIAdvancedError(
      "missing-model",
      "Selected model is unavailable",
      false,
    );
  if (/rate_limit|quota/i.test(code))
    return new OpenAIAdvancedError("quota", "OpenAI quota was exceeded", true);
  if (/auth|api_key/i.test(code))
    return new OpenAIAdvancedError(
      "unauthorized",
      "OpenAI rejected the saved API key",
      false,
    );
  return malformed("OpenAI rejected the advanced request");
}
function normalize(error: unknown): OpenAIAdvancedError {
  const classified = classify(error);
  const detail = errorDetails(error);
  return classified.message.includes(detail)
    ? classified
    : new OpenAIAdvancedError(
        classified.code,
        `${classified.message}\n${detail}`,
        classified.recoverable,
      );
}
function classify(error: unknown): OpenAIAdvancedError {
  if (error instanceof OpenAIAdvancedError) return error;
  if (error instanceof HttpTransportError) {
    if (error.code === "unauthorized" || error.code === "forbidden")
      return new OpenAIAdvancedError(
        "unauthorized",
        "OpenAI rejected the saved API key",
        false,
      );
    if (error.status === 404)
      return new OpenAIAdvancedError(
        "missing-model",
        "Selected model or endpoint is unavailable",
        false,
      );
    if (error.status === 429)
      return new OpenAIAdvancedError(
        "quota",
        "OpenAI quota was exceeded",
        true,
      );
    if (error.code === "canceled")
      return new OpenAIAdvancedError("canceled", "Request canceled", true);
    return new OpenAIAdvancedError(
      "offline",
      error.code === "timeout"
        ? "OpenAI request timed out"
        : "Could not connect to OpenAI",
      true,
    );
  }
  return malformed();
}
function portError(e: unknown) {
  const x = normalize(e);
  return {
    code: x.code,
    message: x.message,
    recoverable: x.recoverable,
    backend: "openai-responses-advanced",
  };
}
function malformed(message = "OpenAI returned an invalid advanced response") {
  return new OpenAIAdvancedError("malformed", message, false);
}
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stableUuid(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++)
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const first = (h >>> 0).toString(16).padStart(8, "0");
  let tail = "";
  for (let i = 0; i < 24; i++) {
    h = Math.imul(
      h ^ ((seed.charCodeAt(i % Math.max(1, seed.length)) || 0) + i),
      16777619,
    );
    tail += (h >>> 0).toString(16).slice(-1);
  }
  return `${first}-${tail.slice(0, 4)}-7${tail.slice(5, 8)}-8${tail.slice(9, 12)}-${tail.slice(12, 24)}`;
}
