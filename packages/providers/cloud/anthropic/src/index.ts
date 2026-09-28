import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  createHttpTransport,
  HttpTransportError,
  type FetchLike,
} from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";

export const ANTHROPIC_VERSION = "2023-06-01";
export interface AnthropicConnection {
  endpointUrl: string;
  modelId: string;
  apiKeyRef: SecretRef;
}
export interface AnthropicOptions {
  secrets: SecretStore;
  resolveConnection(id: string): Promise<AnthropicConnection>;
  fetch: FetchLike;
  now?: () => string;
}
export class AnthropicError extends Error {
  readonly name = "AnthropicError";
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
type Payload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp">
    : never
  : never;

/** Vendor-shaped Messages API request encoder; attachments need an upstream resolver to yield base64 bytes. */
export function encodeAnthropicRequest(
  request: RunRequest,
): Record<string, unknown> {
  let system: string | undefined;
  const messages: { role: "user" | "assistant"; content: unknown[] }[] = [];
  for (const item of request.context) {
    if (item.kind === "system" || item.kind === "developer") {
      system = [system, plainText(item.value)].filter(Boolean).join("\n\n");
      continue;
    }
    if (item.kind !== "user" && item.kind !== "assistant") continue;
    const role = item.kind;
    const content = anthropicContent(item.value);
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  const p = request.parameters;
  const thinkingBudget = request.reasoning
    ? Math.max(
        1024,
        Math.min(32000, Math.floor(finite(p.reasoning_budget, 4096))),
      )
    : undefined;
  const requestedMax = finite(p.max_output_tokens, 2048);
  const body: Record<string, unknown> = {
    model: request.modelId,
    max_tokens:
      thinkingBudget === undefined
        ? requestedMax
        : Math.max(requestedMax, thinkingBudget + 1),
    messages,
    stream: true,
  };
  if (system) body.system = system;
  for (const key of ["temperature", "top_p", "top_k"] as const)
    if (typeof p[key] === "number" && Number.isFinite(p[key]))
      body[key] = p[key];
  if (thinkingBudget !== undefined)
    body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  if (request.permittedTools.length) {
    const definitions = request.context.find(
      ({ kind }) => kind === "tool-definitions",
    )?.value;
    const allowed = new Set(request.permittedTools);
    body.tools = Array.isArray(definitions)
      ? definitions
          .filter(
            (v) =>
              isRecord(v) && typeof v.name === "string" && allowed.has(v.name),
          )
          .map((v) => ({
            name: v.name,
            description: typeof v.description === "string" ? v.description : "",
            input_schema: isRecord(v.input_schema)
              ? v.input_schema
              : isRecord(v.parameters)
                ? v.parameters
                : { type: "object", properties: {} },
          }))
      : [];
  }
  return body;
}
function anthropicContent(value: unknown): unknown[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (isRecord(value) && typeof value.text === "string")
    return [{ type: "text", text: value.text }];
  const parts =
    isRecord(value) && Array.isArray(value.parts)
      ? value.parts
      : Array.isArray(value)
        ? value
        : [];
  const content: unknown[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string"
    ) {
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mediaType === "string" &&
      /^image\/(?:jpeg|png|gif|webp)$/i.test(part.mediaType) &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(part.data) &&
      part.data.length < 20_000_000
    ) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: part.mediaType, data: part.data },
      });
      continue;
    }
    if (part.type === "image" && typeof part.dataUrl === "string") {
      const match =
        /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
          part.dataUrl,
        );
      if (match && match[2]!.length < 20_000_000)
        content.push({
          type: "image",
          source: { type: "base64", media_type: match[1], data: match[2] },
        });
      else
        throw new AnthropicError(
          "unsupported",
          "Resolve image attachments to supported base64 image data before sending",
          false,
        );
    } else if (part.type === "image")
      throw new AnthropicError(
        "unsupported",
        "Resolve image attachments to supported base64 image data before sending",
        false,
      );
  }
  return content;
}
function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.text === "string") return value.text;
  return "";
}
function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Anthropic SSE block state is kept per run; tool JSON is emitted only after it is complete. */
export function createAnthropicEventDecoder(
  runId = "",
): (data: Record<string, unknown>) => Payload[] {
  let block:
    | { index: number; type: string; id?: string; name?: string; json: string }
    | undefined;
  return (data) => {
    const type = data.type;
    const out: Payload[] = [];
    if (type === "content_block_start" && isRecord(data.content_block)) {
      const b = data.content_block;
      block = {
        index: asInt(data.index) ?? 0,
        type: typeof b.type === "string" ? b.type : "",
        ...(typeof b.id === "string" ? { id: b.id } : {}),
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        json: "",
      };
    } else if (type === "content_block_delta" && isRecord(data.delta)) {
      const delta = data.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string")
        out.push({ type: "TextDelta", text: delta.text });
      else if (
        delta.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      )
        out.push({ type: "ReasoningDelta", text: delta.thinking });
      else if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string" &&
        block?.type === "tool_use"
      )
        block.json += delta.partial_json;
    } else if (type === "content_block_stop" && block?.type === "tool_use") {
      let input: unknown;
      try {
        input = JSON.parse(block.json || "{}");
      } catch {
        throw malformed("Anthropic tool input was malformed");
      }
      if (block.name && block.id)
        out.push({
          type: "ToolCall",
          invocationId: uuidFrom(`${runId}:${block.id}`),
          name: block.name,
          input,
        });
      block = undefined;
    } else if (type === "message_delta" && isRecord(data.usage)) {
      const usage = data.usage;
      const outputTokens = asInt(usage.output_tokens);
      if (outputTokens !== undefined) out.push({ type: "Usage", outputTokens });
    } else if (
      type === "message_start" &&
      isRecord(data.message) &&
      isRecord(data.message.usage)
    ) {
      const inputTokens = asInt(data.message.usage.input_tokens);
      if (inputTokens !== undefined) out.push({ type: "Usage", inputTokens });
    } else if (type === "error") throw apiError(data);
    return out;
  };
}

export function createAnthropicProvider(
  options: AnthropicOptions,
): ProviderPort<AnthropicConnection> {
  const now = options.now ?? (() => new Date().toISOString());
  const make = (url: URL) =>
    createHttpTransport({
      fetch: options.fetch,
      policy: { authorizedOrigins: [url.origin] },
    });
  return {
    async listModels(connection, signal) {
      try {
        const url = endpoint(connection.endpointUrl);
        const modelsUrl = new URL(url);
        modelsUrl.pathname = "/v1/models";
        const response = await make(url).request(
          modelsUrl,
          {
            headers: await auth(
              options.secrets,
              connection.apiKeyRef,
              url.origin,
            ),
            ...(signal ? { signal } : {}),
          },
          { ...(signal ? { signal } : {}) },
        );
        const data = await response.json();
        if (!isRecord(data) || !Array.isArray(data.data)) throw malformed();
        return {
          ok: true,
          value: data.data.flatMap((m) =>
            isRecord(m) && typeof m.id === "string" ? [m.id] : [],
          ),
        };
      } catch (e) {
        const x = normalize(e);
        return {
          ok: false,
          error: {
            code: x.code,
            message: x.message,
            recoverable: x.recoverable,
            backend: "anthropic",
          },
        };
      }
    },
    async getCapabilities(_connection, _modelId, signal) {
      if (signal?.aborted)
        return {
          ok: false,
          error: {
            code: "canceled",
            message: "Request canceled",
            recoverable: true,
            backend: "anthropic",
          },
        };
      return {
        ok: true,
        value: {
          streaming: "yes",
          tools: "yes",
          vision: "yes",
          reasoning: "unknown",
        },
      };
    },
    async *startRun(request, signal) {
      let sequence = 0,
        terminal = false;
      const emit = (event: Payload) =>
        ({
          ...event,
          runId: request.runId,
          sequence: sequence++,
          timestamp: now(),
        }) as RunEvent;
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
        const connection = await options.resolveConnection(
          request.providerConnectionId,
        );
        const url = endpoint(connection.endpointUrl);
        const headers = await auth(
          options.secrets,
          connection.apiKeyRef,
          url.origin,
        );
        const decode = createAnthropicEventDecoder(request.runId);
        let completed = false;
        for await (const frame of make(url).streamSse(
          url,
          {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              accept: "text/event-stream",
              "anthropic-version": ANTHROPIC_VERSION,
            },
            body: JSON.stringify(encodeAnthropicRequest(request)),
            signal: controller.signal,
          },
          { signal: controller.signal },
        )) {
          let value: unknown;
          try {
            value = JSON.parse(frame.data);
          } catch {
            throw malformed("Anthropic stream contained invalid JSON");
          }
          if (!isRecord(value)) throw malformed();
          const kind =
            typeof value.type === "string" ? value.type : frame.event;
          if (kind === "message_stop") completed = true;
          for (const event of decode({ ...value, type: kind })) {
            if (
              event.type !== "ToolCall" ||
              request.permittedTools.includes(event.name)
            )
              yield emit(event);
          }
        }
        if (controller.signal.aborted) {
          terminal = true;
          yield emit({ type: "RunCanceled", reason: "canceled" });
        } else if (!completed)
          throw malformed("Anthropic stream ended without message_stop");
        else {
          terminal = true;
          yield emit({ type: "RunCompleted", finishReason: "stop" });
        }
      } catch (e) {
        terminal = true;
        if (
          controller.signal.aborted ||
          (e instanceof HttpTransportError && e.code === "canceled")
        )
          yield emit({ type: "RunCanceled", reason: "canceled" });
        else {
          const x = normalize(e);
          yield emit({
            type: "RunFailed",
            error: {
              code: x.code,
              message: x.message,
              recoverable: x.recoverable,
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
function endpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw malformed("Invalid Anthropic endpoint");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/v1\/messages\/?$/i.test(url.pathname)
  )
    throw malformed("Endpoint must be an HTTPS Anthropic Messages URL");
  url.pathname = "/v1/messages";
  return url;
}
async function auth(
  secrets: SecretStore,
  ref: SecretRef,
  host: string,
): Promise<Record<string, string>> {
  try {
    const headers = await secrets.resolveHeaders(host, [ref]);
    // Earlier app setup saved every vendor key under Authorization.
    const value =
      headers["x-api-key"] ??
      headers.authorization?.replace(/^(?:Bearer\s+)+/i, "");
    if (!value || /[\r\n]/.test(value)) throw new Error();
    return { "x-api-key": value };
  } catch {
    throw new AnthropicError(
      "unauthorized",
      "Saved API key is unavailable for this endpoint",
      true,
    );
  }
}
function apiError(data: Record<string, unknown>): AnthropicError {
  const error = isRecord(data.error) ? data.error : {};
  const type = typeof error.type === "string" ? error.type : "";
  if (/authentication/i.test(type))
    return new AnthropicError(
      "unauthorized",
      "Anthropic rejected the saved API key",
      false,
    );
  if (/rate_limit/i.test(type))
    return new AnthropicError("quota", "Anthropic quota was exceeded", true);
  if (/not_found/i.test(type))
    return new AnthropicError(
      "missing-model",
      "Selected Anthropic model is unavailable",
      false,
    );
  return malformed("Anthropic reported a request error");
}
function normalize(error: unknown): AnthropicError {
  if (error instanceof AnthropicError) return error;
  if (error instanceof HttpTransportError) {
    if (error.code === "unauthorized" || error.code === "forbidden")
      return new AnthropicError(
        "unauthorized",
        "Anthropic rejected the saved API key",
        false,
      );
    if (error.status === 404)
      return new AnthropicError(
        "missing-model",
        "Anthropic endpoint or model is unavailable",
        false,
      );
    if (error.status === 429)
      return new AnthropicError("quota", "Anthropic quota was exceeded", true);
    if (error.code === "canceled")
      return new AnthropicError("canceled", "Request canceled", true);
    return new AnthropicError(
      "offline",
      error.code === "timeout"
        ? "Anthropic request timed out"
        : "Could not connect to Anthropic",
      true,
    );
  }
  return malformed();
}
function malformed(message = "Anthropic returned an invalid response") {
  return new AnthropicError("malformed", message, false);
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
function uuidFrom(seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++)
    hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  const a = (hash >>> 0).toString(16).padStart(8, "0");
  let tail = "";
  for (let i = 0; i < 24; i++)
    tail += (
      (hash = Math.imul(
        hash ^ ((seed.charCodeAt(i % seed.length) || 0) + i),
        16777619,
      )) >>> 0
    )
      .toString(16)
      .slice(-1);
  return `${a}-${tail.slice(0, 4)}-7${tail.slice(5, 8)}-8${tail.slice(9, 12)}-${tail.slice(12, 24)}`;
}
