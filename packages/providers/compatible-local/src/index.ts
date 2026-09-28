import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  resolveCapabilities,
  type CapabilityDecision,
} from "@locallab/capabilities";
import { HttpTransportError, type HttpTransport } from "@locallab/network-http";
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
}

export interface CompatibleModel {
  /** Exact ID returned by the backend; never prettified or rewritten. */
  readonly id: string;
  readonly ownedBy?: string;
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
      throw new HttpTransportError(
        response.status === 401
          ? "unauthorized"
          : response.status === 403
            ? "forbidden"
            : "http",
        `Compatible server returned HTTP ${response.status}`,
        response.status >= 500,
        response.status,
      );
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.data))
      throw new TypeError(
        "Compatible server returned an invalid model catalog",
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
      models.push({
        id: row.id,
        ...(typeof row.owned_by === "string" ? { ownedBy: row.owned_by } : {}),
      });
    }
    return models;
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
      // OpenAI compatibility establishes the chat wire format only. Model-specific
      // tools, vision, reasoning, structured output, management, and MCP remain unknown.
      const resolved = resolveCapabilities({
        provider: {
          streaming: "yes",
          "parameter.temperature": "yes",
          "parameter.top_p": "yes",
          "parameter.max_output_tokens": "yes",
          tools: "unknown",
          vision: "unknown",
          reasoning: "unknown",
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
        let sawTerminalChunk = false;
        let finishReason: string | undefined;
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
          { signal, timeoutMs: 90_000 },
        )) {
          if (frame.data.trim() === "[DONE]") {
            sawTerminalChunk = true;
            continue;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            continue;
          }
          if (!isRecord(payload)) continue;
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
        }
        if (signal.aborted) {
          yield emit({ type: "RunCanceled", reason: "canceled" });
          return;
        }
        if (!sawTerminalChunk)
          throw new Error("Compatible chat stream ended without a final chunk");
        yield emit({
          type: "RunCompleted",
          ...(finishReason ? { finishReason } : {}),
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
function toMessages(
  request: RunRequest,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  for (const item of request.context) {
    if (!["system", "developer", "user", "assistant"].includes(item.kind))
      continue;
    const content =
      typeof item.value === "string"
        ? item.value
        : isRecord(item.value) && typeof item.value.content === "string"
          ? item.value.content
          : isRecord(item.value) && typeof item.value.text === "string"
            ? item.value.text
            : undefined;
    if (content !== undefined)
      messages.push({
        role: item.kind === "developer" ? "system" : item.kind,
        content,
      });
  }
  return messages;
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
      error.code === "timeout"
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
    message:
      error instanceof Error
        ? error.message
        : "Compatible-provider request failed",
    recoverable: true,
  };
}
function nonnegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
