import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  createHttpTransport,
  HttpTransportError,
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
        const data: unknown = await response.json();
        if (!isObj(data) || !Array.isArray(data.data))
          throw malformed("Model list was malformed");
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
          tools: "unknown",
          reasoning: "unknown",
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
        let completed = false;
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
          } catch {
            throw malformed("Provider sent malformed stream data");
          }
          if (!isObj(value))
            throw malformed("Provider sent malformed stream data");
          if (isObj(value.error)) throw apiError(value.error);
          const choice =
            Array.isArray(value.choices) && isObj(value.choices[0])
              ? value.choices[0]
              : undefined;
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
                if (!isObj(item) || !isObj(item.function)) continue;
                const index = integer(item.index);
                if (index === undefined) continue;
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
              continue;
            let input: unknown;
            try {
              input = JSON.parse(tool.arguments || "{}");
            } catch {
              throw malformed("Provider sent malformed tool arguments");
            }
            yield emit({
              type: "ToolCall",
              invocationId: stableId(
                `${request.runId}:${tool.id ?? index}:${tool.name}`,
              ),
              name: tool.name,
              input,
            });
          }
          yield emit({ type: "RunCompleted", finishReason: "stop" });
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
  const messages = request.context.flatMap(({ kind, value }) =>
    ["system", "developer", "user", "assistant"].includes(kind)
      ? [{ role: kind, content: plain(value) }]
      : [],
  );
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
  if (tools.length) body.tools = tools;
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
      | "quota",
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
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
    if (!ref) throw new Error();
    const value = (await secrets.resolveHeaders(origin, [ref])).authorization;
    if (!value || /[\r\n]/.test(value)) throw new Error();
    return {
      authorization: /^Bearer\s/i.test(value) ? value : `Bearer ${value}`,
    };
  } catch {
    throw new CloudCompatibleError(
      "unauthorized",
      "Saved API key is unavailable for this provider",
      true,
    );
  }
}
function apiError(e: Obj): CloudCompatibleError {
  const text = `${String(e.code ?? "")} ${String(e.type ?? "")} ${String(e.message ?? "")}`;
  if (/model.*(not found|unavailable)|invalid_model/i.test(text))
    return new CloudCompatibleError(
      "missing-model",
      "Selected model is unavailable",
      false,
    );
  if (/rate.?limit|quota|billing/i.test(text))
    return new CloudCompatibleError(
      "quota",
      "Provider quota was exceeded",
      true,
    );
  if (/auth|api.?key/i.test(text))
    return new CloudCompatibleError(
      "unauthorized",
      "Provider rejected the saved API key",
      false,
    );
  return malformed("Provider rejected the request");
}
function normalize(e: unknown): CloudCompatibleError {
  if (e instanceof CloudCompatibleError) return e;
  if (e instanceof HttpTransportError) {
    if (e.code === "canceled")
      return new CloudCompatibleError("canceled", "Request canceled", true);
    if (e.status === 401 || e.status === 403)
      return new CloudCompatibleError(
        "unauthorized",
        "Provider rejected the saved API key",
        false,
      );
    if (e.status === 404)
      return new CloudCompatibleError(
        "missing-model",
        "Selected model or endpoint is unavailable",
        false,
      );
    if (e.status === 429)
      return new CloudCompatibleError(
        "quota",
        "Provider quota was exceeded",
        true,
      );
  }
  return new CloudCompatibleError(
    "offline",
    "Could not connect to the selected provider",
    true,
  );
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
function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
function stableId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `cloud-${(h >>> 0).toString(16).padStart(8, "0")}-${s.length}`;
}
