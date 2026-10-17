import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  createHttpTransport,
  HttpTransportError,
  errorDetails,
  type FetchLike,
} from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";

export type CloudCompatibleProviderId =
  | "openrouter"
  | "deepseek"
  | "zai"
  | "vercel-gateway"
  | "custom";
export const CLOUD_COMPATIBLE_PRESETS = Object.freeze({
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  zai: "https://open.bigmodel.cn/api/paas/v4",
  "vercel-gateway": "https://ai-gateway.vercel.sh/v1",
} satisfies Record<Exclude<CloudCompatibleProviderId, "custom">, string>);
export interface CloudCompatibleConnection {
  readonly provider: CloudCompatibleProviderId;
  /** Optional only for browsing OpenRouter's public model catalog. */
  readonly apiKeyRef?: SecretRef;
  readonly modelId?: string;
  /** Required only for provider="custom"; must be HTTPS. */
  readonly endpointOrigin?: string;
  /** Explicit opt-in for OpenRouter/Vercel cross-provider model routing. */
  readonly allowCrossProviderRouting?: boolean;
}
export interface CloudCompatibleOptions {
  readonly secrets: SecretStore;
  readonly resolveConnection: (
    id: string,
  ) => Promise<CloudCompatibleConnection>;
  readonly fetch: FetchLike;
  readonly now?: () => string;
  /** Enable only after confirming the selected model supports function tools. */
  readonly toolsEnabled?: boolean;
  /** Add the NInfer thinking extension only after verifying this selected backend. */
  readonly ninferThinkingControl?: boolean;
}
type Payload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp">
    : never
  : never;
type Obj = Record<string, unknown>;

/** OpenAI-compatible cloud adapter for OpenRouter, DeepSeek, Z.AI, Vercel AI Gateway, and explicitly configured endpoints. */
export function createCloudCompatibleProvider(
  options: CloudCompatibleOptions,
): ProviderPort<CloudCompatibleConnection> {
  const now = options.now ?? (() => new Date().toISOString());
  const transport = (origin: string) =>
    createHttpTransport({
      fetch: options.fetch,
      policy: { authorizedOrigins: [new URL(origin).origin] },
    });
  return {
    async listModels(connection, signal) {
      try {
        const origin = validate(connection);
        const headers =
          connection.provider === "openrouter" && !connection.apiKeyRef
            ? {}
            : await auth(
                options.secrets,
                new URL(origin).origin,
                connection.apiKeyRef,
              );
        const response = await transport(origin).request(
          apiEndpoint(origin, "models"),
          { headers, ...(signal ? { signal } : {}) },
          signal ? { signal } : {},
        );
        const raw = await response.text();
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch (cause) {
          throw malformed(
            `Model list was unreadable (HTTP ${response.status} ${response.statusText}).\n${errorDetails(cause)}\nResponse body:\n${raw}`,
          );
        }
        if (isObj(data) && Object.hasOwn(data, "error") && data.error != null)
          throw apiError(data.error, raw);
        if (!isObj(data) || !Array.isArray(data.data))
          throw malformed(
            `Model list was malformed (HTTP ${response.status} ${response.statusText}).\nResponse body:\n${raw}`,
          );
        return {
          ok: true,
          value: data.data.flatMap((row) =>
            isObj(row) && typeof row.id === "string" ? [row.id] : [],
          ),
        };
      } catch (error) {
        return { ok: false, error: portError(error) };
      }
    },
    async getCapabilities(_connection, _model, signal) {
      if (signal?.aborted)
        return {
          ok: false,
          error: portError(
            new CloudCompatibleError("canceled", "Request canceled", true),
          ),
        };
      return {
        ok: true,
        value: {
          streaming: "yes",
          "parameter.temperature": "yes",
          "parameter.top_p": "yes",
          "parameter.max_output_tokens": "yes",
          tools: options.toolsEnabled === true ? "yes" : "unknown",
          reasoning: options.ninferThinkingControl === true ? "yes" : "unknown",
          vision: "unknown",
        },
      };
    },
    async *startRun(request, signal) {
      let seq = 0;
      const emit = (e: Payload) =>
        ({
          ...e,
          runId: request.runId,
          sequence: seq++,
          timestamp: now(),
        }) as RunEvent;
      const abort = new AbortController();
      const onAbort = () => abort.abort(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      yield emit({ type: "RunStarted" });
      try {
        if (abort.signal.aborted) {
          yield emit({ type: "RunCanceled", reason: "canceled" });
          return;
        }
        const connection = await options.resolveConnection(
          request.providerConnectionId,
        );
        if (connection.modelId && connection.modelId !== request.modelId)
          throw new CloudCompatibleError(
            "missing-model",
            "Selected model changed on this provider connection",
            false,
          );
        const origin = validate(connection);
        const headers = await auth(
          options.secrets,
          new URL(origin).origin,
          connection.apiKeyRef,
        );
        headers["content-type"] = "application/json";
        headers.accept = "text/event-stream";
        const body = encodeChatCompletionRequest(request, connection);
        if (options.ninferThinkingControl === true)
          body.enable_thinking = request.reasoning;
        let completed = false;
        let finishReason: string | undefined;
        const toolDeltas = new Map<
          number,
          { id?: string; name: string; arguments: string }
        >();
        for await (const frame of transport(origin).streamSse(
          apiEndpoint(origin, "chat/completions"),
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: abort.signal,
          },
          { signal: abort.signal },
        )) {
          if (frame.data.trim() === "[DONE]") {
            completed = true;
            continue;
          }
          let value: unknown;
          try {
            value = JSON.parse(frame.data);
          } catch (cause) {
            throw malformed(
              `Provider sent malformed stream data.\n${errorDetails(cause)}\nResponse body:\n${frame.data}`,
            );
          }
          if (
            frame.event === "error" ||
            (isObj(value) &&
              Object.hasOwn(value, "error") &&
              value.error != null)
          )
            throw apiError(
              isObj(value) && value.error != null ? value.error : value,
              frame.data,
            );
          if (!isObj(value))
            throw malformed(
              `Provider sent malformed stream data.\nResponse body:\n${frame.data}`,
            );
          if (!Array.isArray(value.choices) && !isObj(value.usage))
            throw malformed(
              `Provider sent a stream payload without choices or usage.\nResponse body:\n${frame.data}`,
            );
          const choice =
            Array.isArray(value.choices) && isObj(value.choices[0])
              ? value.choices[0]
              : undefined;
          if (choice && typeof choice.finish_reason === "string")
            finishReason = choice.finish_reason;
          if (choice && isObj(choice.delta)) {
            const delta = choice.delta;
            if (typeof delta.content === "string")
              yield emit({ type: "TextDelta", text: delta.content });
            if (typeof delta.reasoning_content === "string")
              yield emit({
                type: "ReasoningDelta",
                text: delta.reasoning_content,
              });
            if (Array.isArray(delta.tool_calls))
              for (const item of delta.tool_calls) {
                if (!isObj(item) || !isObj(item.function))
                  throw malformed(
                    `Provider sent a malformed function-call delta.\nResponse body:\n${frame.data}`,
                  );
                const index = integer(item.index);
                if (index === undefined)
                  throw malformed(
                    `Provider sent a function call without a valid index.\nResponse body:\n${frame.data}`,
                  );
                const state = toolDeltas.get(index) ?? {
                  name: "",
                  arguments: "",
                };
                if (typeof item.id === "string") state.id = item.id;
                if (typeof item.function.name === "string")
                  state.name += item.function.name;
                if (typeof item.function.arguments === "string")
                  state.arguments += item.function.arguments;
                toolDeltas.set(index, state);
                if (toolDeltas.size > 128 || state.arguments.length > 1_000_000)
                  throw malformed(
                    "Provider function calls exceeded their argument or call limit.",
                  );
              }
          }
          if (isObj(value.usage)) {
            const inputTokens = integer(value.usage.prompt_tokens),
              outputTokens = integer(value.usage.completion_tokens);
            if (inputTokens !== undefined || outputTokens !== undefined)
              yield emit({
                type: "Usage",
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
              });
          }
        }
        if (abort.signal.aborted)
          yield emit({ type: "RunCanceled", reason: "canceled" });
        else if (!completed) throw malformed("Stream ended without [DONE]");
        else {
          for (const [index, tool] of [...toolDeltas].sort(
            ([a], [b]) => a - b,
          )) {
            if (!tool.name || !request.permittedTools.includes(tool.name))
              throw new CloudCompatibleError(
                "permission",
                `Provider requested an unpermitted function: ${tool.name || "[missing name]"}.`,
                false,
              );
            let input: unknown;
            try {
              input = JSON.parse(tool.arguments);
            } catch (cause) {
              throw malformed(
                `Provider sent malformed tool arguments.\n${errorDetails(cause)}\nTool arguments:\n${tool.arguments}`,
              );
            }
            if (!isObj(input))
              throw malformed(
                `Function arguments must be a JSON object.\nTool arguments:\n${tool.arguments}`,
              );
            yield emit({
              type: "ToolCall",
              invocationId: stableId(
                `${request.runId}:${tool.id ?? index}:${tool.name}`,
              ),
              name: tool.name,
              input,
            });
          }
          if (finishReason === "tool_calls" && !toolDeltas.size)
            throw malformed(
              "Provider ended for function calls without supplying a call.",
            );
          yield emit({
            type: "RunCompleted",
            finishReason: toolDeltas.size
              ? "tool_calls"
              : (finishReason ?? "stop"),
          });
        }
      } catch (error) {
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
        signal.removeEventListener("abort", onAbort);
        abort.abort();
      }
    },
  };
}

/** Preserves caller-selected model IDs and tools; routing fallback is never added implicitly. */
export function encodeChatCompletionRequest(
  request: RunRequest,
  connection: CloudCompatibleConnection,
): Obj {
  validate(connection);
  const model = request.modelId || connection.modelId;
  if (!model) throw malformed("A model ID is required");
  const messages: Obj[] = request.context.flatMap<Obj>(({ kind, value }) => {
    if (kind === "tool") {
      if (
        !isObj(value) ||
        typeof value.tool_call_id !== "string" ||
        !value.tool_call_id
      )
        throw malformed("Function results require a matching tool_call_id.");
      return [
        {
          role: "tool",
          tool_call_id: value.tool_call_id,
          content:
            typeof value.content === "string"
              ? value.content
              : JSON.stringify(value.content ?? value.output ?? null),
        },
      ];
    }
    if (!["system", "developer", "user", "assistant"].includes(kind)) return [];
    const calls =
      kind === "assistant" && isObj(value) && Array.isArray(value.tool_calls)
        ? value.tool_calls.map(encodeHistoryCall)
        : [];
    return [
      {
        role: kind,
        content:
          isObj(value) && typeof value.content === "string"
            ? value.content
            : plain(value),
        ...(calls.length ? { tool_calls: calls } : {}),
      },
    ];
  });
  const definitions = request.context.find(
    ({ kind }) => kind === "tool-definitions",
  )?.value;
  const allowed = new Set(request.permittedTools);
  const tools = Array.isArray(definitions)
    ? definitions.flatMap((item) =>
        isObj(item) && typeof item.name === "string" && allowed.has(item.name)
          ? [
              {
                type: "function",
                function: {
                  name: item.name,
                  description:
                    typeof item.description === "string"
                      ? item.description
                      : "",
                  parameters: isObj(item.parameters)
                    ? item.parameters
                    : isObj(item.input_schema)
                      ? item.input_schema
                      : { type: "object", properties: {} },
                },
              },
            ]
          : [],
      )
    : [];
  const body: Obj = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // Router fallback is opt-in and visible in the connection. Namespaced model IDs
  // remain intact because both routers use them to select a provider explicitly.
  if (connection.provider === "openrouter")
    body.provider = {
      allow_fallbacks: connection.allowCrossProviderRouting === true,
    };
  if (connection.provider === "vercel-gateway") {
    if (connection.allowCrossProviderRouting === true)
      body.providerOptions = { gateway: {} };
    else {
      const vendor = model.split("/", 1)[0];
      if (!vendor || vendor === model)
        throw new CloudCompatibleError(
          "unsupported",
          "Vercel Gateway requires a vendor/model ID unless cross-provider routing is enabled",
          false,
        );
      body.providerOptions = { gateway: { only: [vendor] } };
    }
  }
  for (const key of [
    "temperature",
    "top_p",
    "max_tokens",
    "frequency_penalty",
    "presence_penalty",
  ] as const)
    if (
      typeof request.parameters[key] === "number" &&
      Number.isFinite(request.parameters[key])
    )
      body[key] = request.parameters[key];
  if (
    typeof request.parameters.max_output_tokens === "number" &&
    Number.isInteger(request.parameters.max_output_tokens) &&
    request.parameters.max_output_tokens >= 0
  )
    body.max_tokens = request.parameters.max_output_tokens;
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (request.json) body.response_format = { type: "json_object" };
  return body;
}
export class CloudCompatibleError extends Error {
  readonly name = "CloudCompatibleError";
  constructor(
    readonly code:
      | "unauthorized"
      | "offline"
      | "missing-model"
      | "malformed"
      | "unsupported"
      | "canceled"
      | "quota"
      | "timeout"
      | "permission",
    message: string,
    readonly recoverable: boolean,
    readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
function validate(c: CloudCompatibleConnection): string {
  let origin: string;
  if (c.provider === "custom") {
    if (!c.endpointOrigin)
      throw malformed("Custom endpoint origin is required");
    origin = c.endpointOrigin;
  } else origin = CLOUD_COMPATIBLE_PRESETS[c.provider];
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw malformed("Provider endpoint is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (c.provider === "custom" && url.pathname !== "/") ||
    url.search ||
    url.hash
  )
    throw malformed("Provider endpoint must be an HTTPS origin");
  return c.provider === "custom"
    ? url.origin
    : `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}
function apiEndpoint(origin: string, suffix: string): URL {
  const url = new URL(origin);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${suffix}`;
  return url;
}
async function auth(
  secrets: SecretStore,
  origin: string,
  ref: SecretRef | undefined,
): Promise<Record<string, string>> {
  try {
    if (!ref) throw new Error("No saved API key reference is configured.");
    const value = (await secrets.resolveHeaders(origin, [ref])).authorization;
    if (!value || /[\r\n]/.test(value))
      throw new Error(
        "Secure storage returned an empty or invalid authorization header.",
      );
    return {
      authorization: /^Bearer\s/i.test(value) ? value : `Bearer ${value}`,
    };
  } catch (cause) {
    throw new CloudCompatibleError(
      "unauthorized",
      `Saved API key is unavailable for this provider.\n${errorDetails(cause)}`,
      true,
      cause,
    );
  }
}
function apiError(e: unknown, raw: string): CloudCompatibleError {
  const text = errorDetails(e);
  const details = `Provider returned an error response.\nResponse body:\n${raw}`;
  if (/model.*(not found|unavailable)|invalid_model/i.test(text))
    return new CloudCompatibleError("missing-model", details, false);
  if (/rate.?limit|quota|billing|\b429\b/i.test(text))
    return new CloudCompatibleError("quota", details, true);
  if (/auth|api.?key|\b401\b/i.test(text))
    return new CloudCompatibleError("unauthorized", details, false);
  return malformed(details);
}
function normalize(e: unknown): CloudCompatibleError {
  if (e instanceof CloudCompatibleError) return e;
  if (e instanceof HttpTransportError) {
    if (e.code === "canceled")
      return new CloudCompatibleError("canceled", errorDetails(e), true, e);
    if (e.status === 401 || e.status === 403)
      return new CloudCompatibleError(
        "unauthorized",
        errorDetails(e),
        false,
        e,
      );
    if (e.status === 404)
      return new CloudCompatibleError(
        "missing-model",
        errorDetails(e),
        false,
        e,
      );
    if (e.status === 429)
      return new CloudCompatibleError("quota", errorDetails(e), true, e);
    return new CloudCompatibleError(
      e.code === "timeout"
        ? "timeout"
        : e.code === "malformed_stream"
          ? "malformed"
          : e.code === "host_not_authorized" ||
              e.code === "cleartext_not_authorized"
            ? "permission"
            : "offline",
      errorDetails(e),
      e.recoverable,
      e,
    );
  }
  return new CloudCompatibleError("offline", errorDetails(e), true, e);
}
function portError(e: unknown) {
  const x = normalize(e);
  return {
    code: x.code,
    message: x.message,
    recoverable: x.recoverable,
    backend: "cloud-compatible",
  };
}
function malformed(message: string) {
  return new CloudCompatibleError("malformed", message, false);
}
function plain(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (isObj(value) && typeof value.text === "string") return value.text;
  if (Array.isArray(value))
    return value
      .flatMap((p) => (isObj(p) && typeof p.text === "string" ? [p.text] : []))
      .join("");
  return JSON.stringify(value);
}
function encodeHistoryCall(value: unknown): Obj {
  if (
    !isObj(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    !isObj(value.function) ||
    typeof value.function.name !== "string" ||
    !value.function.name
  )
    throw malformed(
      "Saved assistant function calls require an ID and function name.",
    );
  const argumentsValue =
    typeof value.function.arguments === "string"
      ? parseHistoryArguments(value.function.arguments)
      : value.function.arguments;
  if (!isObj(argumentsValue))
    throw malformed("Saved function arguments must be a JSON object.");
  return {
    id: value.id,
    type: "function",
    function: {
      name: value.function.name,
      arguments: JSON.stringify(argumentsValue),
    },
  };
}
function parseHistoryArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw malformed("Saved function arguments must contain valid JSON.");
  }
}
function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
function stableId(s: string): string {
  let tail = "";
  for (let lane = 0; lane < 3; lane++) {
    let h = 2166136261 ^ Math.imul(lane + 1, 0x9e3779b9);
    for (let i = 0; i < s.length; i++)
      h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    tail += ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, "0");
  }
  return `${s.slice(0, 13)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18)}`;
}
