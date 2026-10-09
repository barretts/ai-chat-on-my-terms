import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  resolveCapabilities,
  type CapabilityDecision,
} from "@locallab/capabilities";
import {
  errorDetails,
  httpResponseError,
  HttpTransportError,
  type HttpTransport,
} from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";

export type CompatibleLocalProviderId = "jan" | "omlx" | "unsloth" | "custom";

/** A preset is protocol metadata only; it does not assert backend management or MCP support. */
export interface CompatibleLocalPreset {
  readonly id: CompatibleLocalProviderId;
  readonly label: string;
  readonly defaultBaseUrl?: string;
}

export const COMPATIBLE_LOCAL_PRESETS: Readonly<
  Record<CompatibleLocalProviderId, CompatibleLocalPreset>
> = Object.freeze({
  jan: Object.freeze({ id: "jan", label: "JAN" }),
  omlx: Object.freeze({ id: "omlx", label: "oMLX" }),
  unsloth: Object.freeze({ id: "unsloth", label: "Unsloth" }),
  custom: Object.freeze({
    id: "custom",
    label: "Custom OpenAI-compatible server",
  }),
});

/** Connection values are user-selected and contain only opaque secret references. */
export interface CompatibleLocalConnection {
  readonly provider: CompatibleLocalProviderId;
  /** Exact origin only, e.g. http://127.0.0.1:1337. No credentials, paths or query. */
  readonly origin: string;
  readonly credentialRef?: SecretRef;
  readonly headerRefs?: readonly SecretRef[];
}

export interface CompatibleLocalOptions {
  /** Must be the shared transport configured for the user's explicitly approved origins. */
  readonly transport: HttpTransport;
  readonly resolveConnection: (
    providerConnectionId: string,
  ) => Promise<CompatibleLocalConnection>;
  readonly secretStore?: SecretStore;
  readonly now?: () => string;
  /** Enable only for a selected server/model whose function calling is established. */
  readonly toolsEnabled?: boolean;
  /** Add the NInfer thinking extension only after verifying this selected backend. */
  readonly ninferThinkingControl?: boolean;
}

export interface CompatibleModel {
  /** Exact ID returned by the backend; never prettified or rewritten. */
  readonly id: string;
  readonly ownedBy?: string;
  /** Effective request capacity advertised by the running server, not the training window. */
  readonly contextWindowTokens?: number;
  readonly contextWindowSource?: "models";
  readonly toolsSupported?: true;
}

export interface CompatibleModelContext {
  readonly contextWindowTokens: number;
  readonly source: "models" | "llama.cpp-props";
  readonly toolsSupported?: true;
}

type EventInput = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp">
    : never
  : never;

/** One OpenAI-compatible chat/model adapter shared by JAN, oMLX, Unsloth, and custom origins. */
export function createCompatibleLocalProvider(
  options: CompatibleLocalOptions,
): ProviderPort<CompatibleLocalConnection> & {
  listCompatibleModels(
    connection: CompatibleLocalConnection,
    signal?: AbortSignal,
  ): Promise<readonly CompatibleModel[]>;
  /** Best-effort discovery. Unsupported endpoints and unavailable metadata return undefined. */
  discoverCompatibleModelContext(
    connection: CompatibleLocalConnection,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<CompatibleModelContext | undefined>;
} {
  const now = options.now ?? (() => new Date().toISOString());

  async function headersFor(
    connection: CompatibleLocalConnection,
  ): Promise<Readonly<Record<string, string>>> {
    const refs = [
      ...(connection.credentialRef ? [connection.credentialRef] : []),
      ...(connection.headerRefs ?? []),
    ];
    if (!refs.length) return {};
    if (!options.secretStore)
      throw new Error(
        "This compatible-provider connection refers to secrets but no secret store is configured",
      );
    return options.secretStore.resolveHeaders(
      normalizeOrigin(connection.origin),
      refs,
    );
  }

  async function listCompatibleModels(
    connection: CompatibleLocalConnection,
    signal?: AbortSignal,
  ): Promise<readonly CompatibleModel[]> {
    const origin = normalizeOrigin(connection.origin);
    const headers = await headersFor(connection);
    const response = await options.transport.request(
      apiUrl(origin, "models"),
      {
        ...(signal ? { signal } : {}),
        headers: { accept: "application/json", ...headers },
      },
      signal ? { signal } : {},
    );
    if (!response.ok)
      throw await httpResponseError(response, {
        summary: "Compatible server rejected model discovery",
        ...(signal ? { signal } : {}),
      });
    const raw = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (cause) {
      throw new HttpTransportError(
        "malformed_stream",
        `Compatible server returned an unreadable model catalog (HTTP ${response.status} ${response.statusText}).\n${errorDetails(cause)}\nResponse body:\n${raw}`,
        false,
        response.status,
      );
    }
    if (!isRecord(body) || !Array.isArray(body.data))
      throw new TypeError(
        `Compatible server returned an invalid model catalog (HTTP ${response.status} ${response.statusText}).\nResponse body:\n${raw}`,
      );
    const seen = new Set<string>();
    const models: CompatibleModel[] = [];
    for (const row of body.data) {
      if (
        !isRecord(row) ||
        typeof row.id !== "string" ||
        !row.id.trim() ||
        isEmbeddingOnly(row)
      )
        continue;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const contextWindowTokens = advertisedContextWindow(row);
      models.push({
        id: row.id,
        ...(typeof row.owned_by === "string" ? { ownedBy: row.owned_by } : {}),
        ...(contextWindowTokens === undefined
          ? {}
          : { contextWindowTokens, contextWindowSource: "models" as const }),
        ...(row.owned_by === "ninfer" ? { toolsSupported: true as const } : {}),
      });
    }
    return models;
  }

  async function discoverCompatibleModelContext(
    connection: CompatibleLocalConnection,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<CompatibleModelContext | undefined> {
    if (!modelId.trim() || signal?.aborted) return undefined;
    const controller = new AbortController();
    let finishTimeout: (() => void) | undefined;
    const cancel = () => {
      controller.abort();
      finishTimeout?.();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    // This optional probe must not make a chat wait on an unsupported endpoint or
    // a response whose body stalls. The bound includes secret resolution and reads.
    const timedOut = new Promise<undefined>((resolve) => {
      finishTimeout = () => resolve(undefined);
    });
    const timer = setTimeout(() => {
      controller.abort();
      finishTimeout?.();
    }, 3_500);

    const discover = async (): Promise<CompatibleModelContext | undefined> => {
      const origin = normalizeOrigin(connection.origin);
      const models = await listCompatibleModels(connection, controller.signal);
      const model = models.find((candidate) => candidate.id === modelId);
      if (model?.contextWindowTokens !== undefined)
        return {
          contextWindowTokens: model.contextWindowTokens,
          source: "models",
          ...(model.toolsSupported ? { toolsSupported: true as const } : {}),
        };
      if (controller.signal.aborted) return undefined;
      const headers = await headersFor(connection);
      const optionalJson = async (url: URL): Promise<unknown> => {
        if (controller.signal.aborted) return undefined;
        try {
          const response = await options.transport.request(
            url,
            {
              signal: controller.signal,
              headers: { accept: "application/json", ...headers },
            },
            {
              signal: controller.signal,
              timeoutMs: 3_500,
              returnHttpErrors: true,
            },
          );
          if (!response.ok) return undefined;
          return JSON.parse(await response.text()) as unknown;
        } catch {
          return undefined;
        }
      };
      // NInfer/vLLM model cards can advertise the configured max_model_len.
      // Some servers expose more metadata on a single-model lookup than the list.
      const details = await optionalJson(
        apiUrl(origin, `models/${encodeURIComponent(modelId)}`),
      );
      if (isRecord(details) && details.id === modelId) {
        const contextWindowTokens = advertisedContextWindow(details);
        if (contextWindowTokens !== undefined)
          return {
            contextWindowTokens,
            source: "models",
            ...(details.owned_by === "ninfer" || model?.toolsSupported
              ? { toolsSupported: true as const }
              : {}),
          };
      }
      if (controller.signal.aborted) return undefined;
      // llama.cpp reports active per-slot context in /props. Passing autoload=false
      // also keeps a router probe from loading an otherwise idle model.
      const propsUrl = new URL("/props", origin);
      propsUrl.searchParams.set("model", modelId);
      propsUrl.searchParams.set("autoload", "false");
      const props = await optionalJson(propsUrl);
      if (!isRecord(props) || !isRecord(props.default_generation_settings))
        return undefined;
      const settings = props.default_generation_settings;
      const alias =
        typeof props.model_alias === "string"
          ? props.model_alias
          : settings.model;
      if (alias !== modelId) return undefined;
      const contextWindowTokens = positiveInt(settings.n_ctx);
      return contextWindowTokens === undefined
        ? undefined
        : { contextWindowTokens, source: "llama.cpp-props" };
    };

    try {
      return await Promise.race([discover().catch(() => undefined), timedOut]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      signal?.removeEventListener("abort", cancel);
    }
  }

  return {
    async listModels(connection, signal) {
      try {
        return {
          ok: true,
          value: (await listCompatibleModels(connection, signal)).map(
            (model) => model.id,
          ),
        };
      } catch (error) {
        return {
          ok: false,
          error: errorResult(error, signal?.aborted ?? false),
        };
      }
    },
    async listCompatibleModels(connection, signal) {
      return listCompatibleModels(connection, signal);
    },
    discoverCompatibleModelContext,
    async getCapabilities(_connection, _modelId, signal) {
      if (signal?.aborted)
        return {
          ok: false,
          error: {
            code: "canceled",
            message: "Capability request canceled",
            recoverable: true,
          },
        };
      // Function capability requires explicit selection metadata. Other model-specific
      // features remain unknown from OpenAI compatibility alone.
      const resolved = resolveCapabilities({
        provider: {
          streaming: "yes",
          "parameter.temperature": "yes",
          "parameter.top_p": "yes",
          "parameter.max_output_tokens": "yes",
          tools: options.toolsEnabled === true ? "yes" : "unknown",
          vision: "unknown",
          reasoning: options.ninferThinkingControl === true ? "yes" : "unknown",
          json: "unknown",
          modelManagement: "unknown",
          mcp: "unknown",
        },
      });
      return {
        ok: true,
        value: Object.fromEntries(
          Object.entries(resolved).map(([key, decision]) => [
            key,
            (decision as CapabilityDecision).value,
          ]),
        ),
      };
    },
    async *startRun(request, signal) {
      let sequence = 0;
      const emit = (event: EventInput): RunEvent =>
        ({
          ...event,
          runId: request.runId,
          sequence: sequence++,
          timestamp: now(),
        }) as RunEvent;
      yield emit({ type: "RunStarted" });
      try {
        if (signal.aborted) {
          yield emit({ type: "RunCanceled", reason: "canceled" });
          return;
        }
        const connection = await options.resolveConnection(
          request.providerConnectionId,
        );
        const headers = await headersFor(connection);
        const body: Record<string, unknown> = {
          model: request.modelId,
          messages: toMessages(request),
          stream: true,
          stream_options: { include_usage: true },
          ...safeParameters(request.parameters),
        };
        if (options.ninferThinkingControl === true)
          body.enable_thinking = request.reasoning;
        const tools = functionDefinitions(request);
        if (tools.length) {
          body.tools = tools;
          body.tool_choice = "auto";
        }
        let sawTerminalChunk = false;
        let finishReason: string | undefined;
        const toolDeltas = new Map<
          number,
          { id?: string; name: string; arguments: string }
        >();
        for await (const frame of options.transport.streamSse(
          apiUrl(connection.origin, "chat/completions"),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              ...headers,
            },
            body: JSON.stringify(body),
            signal,
          },
          { signal, timeoutMs: 300_000 },
        )) {
          if (frame.data.trim() === "[DONE]") {
            sawTerminalChunk = true;
            continue;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(frame.data);
          } catch (cause) {
            throw new HttpTransportError(
              "malformed_stream",
              `Compatible server sent malformed stream data.\n${errorDetails(cause)}\nResponse body:\n${frame.data}`,
              false,
            );
          }
          if (
            frame.event === "error" ||
            (isRecord(payload) &&
              Object.hasOwn(payload, "error") &&
              payload.error != null)
          ) {
            const details =
              isRecord(payload) && isRecord(payload.error)
                ? payload.error
                : payload;
            const statusValue = isRecord(details)
              ? (details.status ?? details.code)
              : undefined;
            const status =
              typeof statusValue === "number"
                ? statusValue
                : typeof statusValue === "string" && /^\d{3}$/.test(statusValue)
                  ? Number(statusValue)
                  : undefined;
            const text = errorDetails(details);
            throw new HttpTransportError(
              status === 401 || /auth|api.?key/i.test(text)
                ? "unauthorized"
                : status === 403
                  ? "forbidden"
                  : "http",
              `Compatible server returned a stream error.\nResponse body:\n${frame.data}`,
              status === 429 ||
                (status !== undefined && status >= 500) ||
                /rate.?limit|quota|billing/i.test(text),
              status,
            );
          }
          if (!isRecord(payload))
            throw new HttpTransportError(
              "malformed_stream",
              `Compatible server sent an invalid stream payload.\nResponse body:\n${frame.data}`,
              false,
            );
          if (!Array.isArray(payload.choices) && !isRecord(payload.usage))
            throw new HttpTransportError(
              "malformed_stream",
              `Compatible server sent a stream payload without choices or usage.\nResponse body:\n${frame.data}`,
              false,
            );
          if (isRecord(payload.usage)) {
            const inputTokens = nonnegativeInt(payload.usage.prompt_tokens);
            const outputTokens = nonnegativeInt(
              payload.usage.completion_tokens,
            );
            if (inputTokens !== undefined || outputTokens !== undefined)
              yield emit({
                type: "Usage",
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
              });
          }
          const choices = Array.isArray(payload.choices) ? payload.choices : [];
          const choice = choices[0];
          if (!isRecord(choice)) continue;
          if (typeof choice.finish_reason === "string") {
            finishReason = choice.finish_reason;
            sawTerminalChunk = true;
          }
          if (!isRecord(choice.delta)) continue;
          if (typeof choice.delta.content === "string")
            yield emit({ type: "TextDelta", text: choice.delta.content });
          // OpenAI-compatible servers disagree on reasoning field names. Preserve a
          // common field if supplied, but do not advertise reasoning support.
          if (typeof choice.delta.reasoning_content === "string")
            yield emit({
              type: "ReasoningDelta",
              text: choice.delta.reasoning_content,
            });
          if (Array.isArray(choice.delta.tool_calls))
            for (const item of choice.delta.tool_calls) {
              if (
                !isRecord(item) ||
                !isRecord(item.function) ||
                !Number.isInteger(item.index) ||
                (item.index as number) < 0
              )
                throw new Error(
                  "Compatible server sent a malformed function-call delta.",
                );
              const index = item.index as number;
              const tool = toolDeltas.get(index) ?? { name: "", arguments: "" };
              if (typeof item.id === "string") tool.id = item.id;
              if (typeof item.function.name === "string")
                tool.name += item.function.name;
              if (typeof item.function.arguments === "string")
                tool.arguments += item.function.arguments;
              toolDeltas.set(index, tool);
              if (toolDeltas.size > 128 || tool.arguments.length > 1_000_000)
                throw new HttpTransportError(
                  "malformed_stream",
                  "Compatible function calls exceeded their argument or call limit.",
                  false,
                );
            }
        }
        if (signal.aborted) {
          yield emit({ type: "RunCanceled", reason: "canceled" });
          return;
        }
        if (!sawTerminalChunk)
          throw new Error("Compatible chat stream ended without a final chunk");
        if (finishReason === "tool_calls" && !toolDeltas.size)
          throw new Error(
            "Compatible server ended for function calls without supplying a call.",
          );
        for (const [index, tool] of [...toolDeltas].sort(([a], [b]) => a - b)) {
          if (!tool.name || !request.permittedTools.includes(tool.name))
            throw new HttpTransportError(
              "forbidden",
              `Compatible server requested an unpermitted function: ${tool.name || "[missing name]"}.`,
              false,
            );
          let input: unknown;
          try {
            input = JSON.parse(tool.arguments);
          } catch (cause) {
            throw new HttpTransportError(
              "malformed_stream",
              `Compatible server sent malformed function arguments.\n${errorDetails(cause)}\nTool arguments:\n${tool.arguments}`,
              false,
            );
          }
          if (!isRecord(input))
            throw new HttpTransportError(
              "malformed_stream",
              `Compatible function arguments must be a JSON object.\nTool arguments:\n${tool.arguments}`,
              false,
            );
          yield emit({
            type: "ToolCall",
            invocationId: stableToolId(
              `${request.runId}:${tool.id ?? index}:${tool.name}`,
            ),
            name: tool.name,
            input,
          });
        }
        yield emit({
          type: "RunCompleted",
          ...(toolDeltas.size
            ? { finishReason: "tool_calls" }
            : finishReason
              ? { finishReason }
              : {}),
        });
      } catch (error) {
        if (signal.aborted)
          yield emit({ type: "RunCanceled", reason: "canceled" });
        else
          yield emit({ type: "RunFailed", error: errorResult(error, false) });
      }
    },
  };
}

export function createJanPreset(
  origin: string,
  auth?: Pick<CompatibleLocalConnection, "credentialRef" | "headerRefs">,
): CompatibleLocalConnection {
  return connection("jan", origin, auth);
}
export function createOMLXPreset(
  origin: string,
  auth?: Pick<CompatibleLocalConnection, "credentialRef" | "headerRefs">,
): CompatibleLocalConnection {
  return connection("omlx", origin, auth);
}
export function createUnslothPreset(
  origin: string,
  auth?: Pick<CompatibleLocalConnection, "credentialRef" | "headerRefs">,
): CompatibleLocalConnection {
  return connection("unsloth", origin, auth);
}
export function createCustomCompatiblePreset(
  origin: string,
  auth?: Pick<CompatibleLocalConnection, "credentialRef" | "headerRefs">,
): CompatibleLocalConnection {
  return connection("custom", origin, auth);
}

function connection(
  provider: CompatibleLocalProviderId,
  origin: string,
  auth?: Pick<CompatibleLocalConnection, "credentialRef" | "headerRefs">,
): CompatibleLocalConnection {
  return Object.freeze({
    provider,
    origin: normalizeOrigin(origin),
    ...(auth?.credentialRef ? { credentialRef: auth.credentialRef } : {}),
    ...(auth?.headerRefs ? { headerRefs: [...auth.headerRefs] } : {}),
  });
}
function normalizeOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError(
      "Compatible server URL must be an exact HTTP(S) origin",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new TypeError(
      "Compatible server URL must be an exact HTTP(S) origin without credentials, path, query, or fragment",
    );
  return url.origin;
}
function apiUrl(origin: string, path: string): URL {
  return new URL(`/v1/${path}`, normalizeOrigin(origin));
}
function isEmbeddingOnly(row: Record<string, unknown>): boolean {
  const markers = [row.type, row.task, row.model_type, row.kind, row.object]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());
  if (
    markers.some(
      (v) => /embedding/.test(v) || v === "embed" || v === "embeddings",
    )
  )
    return true;
  const caps = isRecord(row.capabilities) ? row.capabilities : undefined;
  if (
    caps &&
    (caps.embedding === true || caps.embeddings === true) &&
    caps.chat !== true &&
    caps.completion !== true
  )
    return true;
  // The OpenAI list API omits model family metadata. Exclude only recognizable
  // IDs; generic names are retained because they may identify dual-use models.
  return /(?:^|[\W_])(?:text[-_])?embeddings?(?:$|[\W_0-9])/i.test(
    row.id as string,
  );
}
function toMessages(request: RunRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const item of request.context) {
    if (
      !["system", "developer", "user", "assistant", "tool"].includes(item.kind)
    )
      continue;
    if (item.kind === "tool") {
      if (
        !isRecord(item.value) ||
        typeof item.value.tool_call_id !== "string" ||
        !item.value.tool_call_id
      )
        throw new TypeError(
          "Function results require a matching tool_call_id.",
        );
      messages.push({
        role: "tool",
        tool_call_id: item.value.tool_call_id,
        content:
          typeof item.value.content === "string"
            ? item.value.content
            : JSON.stringify(item.value.content ?? item.value.output ?? null),
      });
      continue;
    }
    const content =
      typeof item.value === "string"
        ? item.value
        : isRecord(item.value) && typeof item.value.content === "string"
          ? item.value.content
          : isRecord(item.value) && typeof item.value.text === "string"
            ? item.value.text
            : undefined;
    const toolCalls =
      item.kind === "assistant" &&
      isRecord(item.value) &&
      Array.isArray(item.value.tool_calls)
        ? item.value.tool_calls.map(encodeHistoryCall)
        : [];
    if (content !== undefined || toolCalls.length)
      messages.push({
        role: item.kind === "developer" ? "system" : item.kind,
        content: content ?? "",
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
  }
  return messages;
}
function encodeHistoryCall(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    !isRecord(value.function) ||
    typeof value.function.name !== "string" ||
    !value.function.name
  )
    throw new TypeError(
      "Saved assistant function calls require an ID and function name.",
    );
  const argumentsValue =
    typeof value.function.arguments === "string"
      ? JSON.parse(value.function.arguments)
      : value.function.arguments;
  if (!isRecord(argumentsValue))
    throw new TypeError("Saved function arguments must be a JSON object.");
  return {
    id: value.id,
    type: "function",
    function: {
      name: value.function.name,
      arguments: JSON.stringify(argumentsValue),
    },
  };
}
function functionDefinitions(
  request: RunRequest,
): Array<Record<string, unknown>> {
  const definitions = request.context.find(
    (item) => item.kind === "tool-definitions",
  )?.value;
  if (!Array.isArray(definitions)) return [];
  return definitions.flatMap((definition) => {
    if (
      !isRecord(definition) ||
      typeof definition.name !== "string" ||
      !request.permittedTools.includes(definition.name)
    )
      return [];
    if (
      !isRecord(definition.parameters) ||
      definition.parameters.type !== "object"
    )
      throw new TypeError(
        `Function ${definition.name} requires an object argument schema.`,
      );
    return [
      {
        type: "function",
        function: {
          name: definition.name,
          description:
            typeof definition.description === "string"
              ? definition.description
              : "",
          parameters: definition.parameters,
        },
      },
    ];
  });
}
function stableToolId(seed: string): string {
  let tail = "";
  for (let lane = 0; lane < 3; lane++) {
    let h = 2166136261 ^ Math.imul(lane + 1, 0x9e3779b9);
    for (let i = 0; i < seed.length; i++)
      h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    tail += ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, "0");
  }
  return `${seed.slice(0, 13)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18)}`;
}
function safeParameters(
  parameters: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    "temperature",
    "top_p",
    "max_tokens",
    "frequency_penalty",
    "presence_penalty",
    "seed",
  ]) {
    const value = parameters[key];
    if (typeof value === "number" && Number.isFinite(value))
      result[key] = value;
  }
  if (
    typeof parameters.max_output_tokens === "number" &&
    Number.isInteger(parameters.max_output_tokens) &&
    parameters.max_output_tokens >= 0
  )
    result.max_tokens = parameters.max_output_tokens;
  return result;
}
function errorResult(
  error: unknown,
  canceled: boolean,
): {
  code:
    | "offline"
    | "timeout"
    | "quota"
    | "unauthorized"
    | "permission"
    | "unsupported"
    | "malformed"
    | "canceled";
  message: string;
  recoverable: boolean;
} {
  if (canceled)
    return {
      code: "canceled",
      message: "Compatible-provider request canceled",
      recoverable: true,
    };
  if (error instanceof HttpTransportError) {
    const code =
      error.status === 429 || /rate.?limit|quota|billing/i.test(error.message)
        ? "quota"
        : error.code === "timeout"
          ? "timeout"
          : error.code === "unauthorized"
            ? "unauthorized"
            : error.code === "forbidden"
              ? "permission"
              : error.code === "host_not_authorized" ||
                  error.code === "cleartext_not_authorized"
                ? "permission"
                : error.code === "malformed_stream"
                  ? "malformed"
                  : "offline";
    return { code, message: error.message, recoverable: error.recoverable };
  }
  if (error instanceof TypeError)
    return { code: "malformed", message: error.message, recoverable: false };
  return {
    code: "offline",
    message: error instanceof Error ? error.message : errorDetails(error),
    recoverable: true,
  };
}
function nonnegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
function advertisedContextWindow(
  row: Record<string, unknown>,
): number | undefined {
  // max_model_len is NInfer/vLLM's effective served limit. llama.cpp's
  // meta.n_ctx_train is a model training property and must never set this budget.
  return positiveInt(row.max_model_len);
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
