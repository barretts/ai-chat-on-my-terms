import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  createHttpTransport,
  errorDetails,
  HttpTransportError,
  type FetchLike,
} from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";

export const MISTRAL_ORIGIN = "https://api.mistral.ai";
export interface MistralConnection {
  readonly modelId?: string;
  readonly endpointOrigin?: string;
  readonly apiKeyRef: SecretRef;
}
export interface MistralOptions {
  readonly secrets: SecretStore;
  readonly resolveConnection: (
    providerConnectionId: string,
  ) => Promise<MistralConnection>;
  readonly fetch: FetchLike;
  readonly now?: () => string;
  /** Optional host media bridge; currently image attachments only. */ readonly resolveMedia?: (
    attachmentId: string,
  ) => Promise<{ readonly mimeType: string; readonly base64: string }>;
}
type Payload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp">
    : never
  : never;
type Obj = Record<string, unknown>;

/** Mistral's OpenAI-compatible chat-completions SSE adapter. */
export function createMistralProvider(
  options: MistralOptions,
): ProviderPort<MistralConnection> {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async listModels(connection, signal) {
      try {
        const config = validate(connection),
          key = await keyFor(options.secrets, config.origin, config.apiKeyRef);
        const http = createHttpTransport({
          fetch: options.fetch,
          policy: { authorizedOrigins: [config.origin] },
        });
        const response = await http.request(
          new URL("/v1/models", config.origin),
          {
            headers: { authorization: `Bearer ${key}` },
            ...(signal ? { signal } : {}),
          },
          signal ? { signal } : {},
        );
        const raw = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch (cause) {
          throw new ProtocolError(
            `Mistral model list contained invalid JSON.\n${errorDetails(cause)}\nServer response:\n${raw}`,
          );
        }
        if (!isObj(body) || !Array.isArray(body.data))
          throw new ProtocolError(
            `Mistral model list was malformed.\nServer response:\n${raw}`,
          );
        return {
          ok: true,
          value: [
            ...new Set(
              body.data.flatMap((m) =>
                isObj(m) && typeof m.id === "string" ? [m.id] : [],
              ),
            ),
          ],
        };
      } catch (error) {
        return { ok: false, error: normalize(error) };
      }
    },
    async getCapabilities(_connection, _modelId, signal) {
      if (signal?.aborted)
        return {
          ok: false,
          error: normalize(
            new HttpTransportError("canceled", "canceled", true),
          ),
        };
      return {
        ok: true,
        value: {
          streaming: "yes",
          tools: "unknown",
          reasoning: "unknown",
          vision: "unknown",
          json: "unknown",
        },
      };
    },
    async *startRun(request, signal) {
      let sequence = 0;
      const emit = (v: Payload): RunEvent =>
        ({
          ...v,
          runId: request.runId,
          sequence: sequence++,
          timestamp: now(),
        }) as RunEvent;
      const controller = new AbortController(),
        abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      yield emit({ type: "RunStarted" });
      try {
        if (controller.signal.aborted) {
          yield emit({ type: "RunCanceled", reason: "canceled" });
          return;
        }
        const images = await resolveImages(request, options.resolveMedia);
        const config = validate(
          await options.resolveConnection(request.providerConnectionId),
        );
        const key = await keyFor(
          options.secrets,
          config.origin,
          config.apiKeyRef,
        );
        const http = createHttpTransport({
          fetch: options.fetch,
          policy: { authorizedOrigins: [config.origin] },
        });
        const url = new URL("/v1/chat/completions", config.origin);
        const tools = request.parameters.tools;
        const body: Obj = {
          model: request.modelId || config.modelId,
          messages: toMessages(request, images),
          stream: true,
          ...safeParameters(request.parameters),
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
          ...(Array.isArray(tools)
            ? { tools: filterTools(tools, request.permittedTools) }
            : {}),
        };
        let finish: string | undefined,
          done = false,
          inputTokens: number | undefined,
          outputTokens: number | undefined;
        let filteredResponse: string | undefined;
        const calls = new Map<
          number,
          { id?: string; name: string; args: string }
        >();
        for await (const frame of http.streamSse(
          url,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
          { signal: controller.signal },
        )) {
          if (frame.data.trim() === "[DONE]") {
            done = true;
            continue;
          }
          const data = parse(frame.data);
          if (!data) continue;
          if (data.error != null || frame.event === "error")
            throw classifyApiError(data);
          if (isObj(data.usage)) {
            inputTokens = int(data.usage.prompt_tokens);
            outputTokens = int(data.usage.completion_tokens);
          }
          const choices = Array.isArray(data.choices) ? data.choices : [];
          for (const choice of choices) {
            if (!isObj(choice)) continue;
            if (typeof choice.finish_reason === "string") {
              finish = choice.finish_reason;
              done = true;
              if (finish === "content_filter") filteredResponse = frame.data;
            }
            const delta = isObj(choice.delta) ? choice.delta : undefined;
            if (!delta) continue;
            if (typeof delta.content === "string" && delta.content)
              yield emit({ type: "TextDelta", text: delta.content });
            if (
              typeof delta.reasoning_content === "string" &&
              delta.reasoning_content
            )
              yield emit({
                type: "ReasoningDelta",
                text: delta.reasoning_content,
              });
            if (Array.isArray(delta.tool_calls))
              for (const part of delta.tool_calls) {
                if (!isObj(part) || !Number.isInteger(part.index)) continue;
                const index = part.index as number,
                  tool = calls.get(index) ?? { name: "", args: "" };
                if (typeof part.id === "string") tool.id = part.id;
                const fn = isObj(part.function) ? part.function : undefined;
                if (typeof fn?.name === "string") tool.name += fn.name;
                if (typeof fn?.arguments === "string")
                  tool.args += fn.arguments;
                calls.set(index, tool);
              }
          }
        }
        if (controller.signal.aborted)
          yield emit({ type: "RunCanceled", reason: "canceled" });
        else if (!done)
          throw new ProtocolError("Mistral stream ended without a final chunk");
        else if (finish === "content_filter")
          throw new SafetyError(
            `Mistral blocked the response under its content policy.\nServer response:\n${filteredResponse ?? "The provider returned no further details."}`,
          );
        else {
          for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
            if (!call.name || !request.permittedTools.includes(call.name))
              continue;
            let input: unknown = call.args;
            try {
              input = JSON.parse(call.args);
            } catch (cause) {
              throw new ProtocolError(
                `Mistral returned malformed tool arguments.\n${errorDetails(cause)}\nServer response:\n${call.args}`,
              );
            }
            yield emit({
              type: "ToolCall",
              invocationId: invocationId(request.runId, index),
              name: call.name,
              input,
            });
          }
          if (inputTokens !== undefined || outputTokens !== undefined)
            yield emit({
              type: "Usage",
              ...(inputTokens === undefined ? {} : { inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens }),
            });
          yield emit({ type: "RunCompleted", finishReason: finish });
        }
      } catch (error) {
        if (
          controller.signal.aborted ||
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
        signal.removeEventListener("abort", abort);
        if (!controller.signal.aborted) controller.abort();
      }
    },
  };
}
function validate(c: MistralConnection) {
  const origin = c.endpointOrigin ?? MISTRAL_ORIGIN;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ProtocolError("Mistral origin is invalid");
  }
  if (
    url.origin !== origin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new ProtocolError("Mistral endpoint must be an exact HTTPS origin");
  const modelId = (c.modelId ?? "").trim();
  if (!c.apiKeyRef || modelId.length > 200)
    throw new ProtocolError("Mistral connection is incomplete");
  return { origin: url.origin, modelId, apiKeyRef: c.apiKeyRef };
}
async function keyFor(store: SecretStore, origin: string, ref: SecretRef) {
  try {
    const values = await store.resolveHeaders(origin, [ref]);
    const key =
      values.authorization?.replace(/^Bearer\s+/i, "") ?? values["x-api-key"];
    if (!key || /[\r\n]/.test(key)) throw new Error();
    return key;
  } catch (cause) {
    throw new AuthError(
      `Mistral API key is unavailable for this host.\n${errorDetails(cause)}`,
    );
  }
}
function toMessages(
  r: RunRequest,
  images: readonly { mimeType: string; base64: string }[],
): Obj[] {
  const messages: Obj[] = r.context.flatMap<Obj>(({ kind, value }) => {
    if (kind === "tool") {
      // R011: replay OpenAI-compatible tool results into the next round.
      if (
        !isObj(value) ||
        typeof value.tool_call_id !== "string" ||
        !value.tool_call_id
      )
        throw new ProtocolError(
          "Mistral tool results require a matching tool_call_id.",
        );
      return [
        {
          role: "tool",
          tool_call_id: value.tool_call_id,
          content:
            typeof value.content === "string"
              ? value.content
              : JSON.stringify(value.content ?? null),
        },
      ];
    }
    if (!["system", "developer", "user", "assistant"].includes(kind)) return [];
    const role = kind === "developer" ? "system" : kind;
    const calls =
      kind === "assistant" && isObj(value) && Array.isArray(value.tool_calls)
        ? value.tool_calls.map(mistralHistoryCall)
        : [];
    const attached = calls.length ? { tool_calls: calls } : {};
    if (typeof value === "string")
      return [{ role, content: value, ...attached }];
    if (isObj(value) && typeof value.content === "string")
      return [{ role, content: value.content, ...attached }];
    if (isObj(value) && Array.isArray(value.parts)) {
      const text = value.parts
        .flatMap((part) =>
          isObj(part) &&
          (part.type === "text" || part.type === "reasoning") &&
          typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("");
      return text ? [{ role, content: text, ...attached }] : [];
    }
    return calls.length ? [{ role, content: "", ...attached }] : [];
  });
  if (images.length) {
    let user: Obj | undefined = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    if (!user) {
      user = { role: "user", content: [] };
      messages.push(user);
    }
    const prior =
      typeof user.content === "string"
        ? [{ type: "text", text: user.content }]
        : Array.isArray(user.content)
          ? user.content
          : [];
    user.content = [
      ...prior,
      ...images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
      })),
    ];
  }
  return messages;
}

// R011: a canonical assistant tool_calls entry replays as an OpenAI-shaped history call.
function mistralHistoryCall(value: unknown): Obj {
  if (
    !isObj(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    !isObj(value.function) ||
    typeof value.function.name !== "string" ||
    !value.function.name
  )
    throw new ProtocolError(
      "Assistant function calls require an ID and function name.",
    );
  return {
    id: value.id,
    type: "function",
    function: {
      name: value.function.name,
      arguments:
        typeof value.function.arguments === "string"
          ? value.function.arguments
          : JSON.stringify(value.function.arguments ?? {}),
    },
  };
}
async function resolveImages(
  r: RunRequest,
  resolver: MistralOptions["resolveMedia"],
) {
  if (!r.attachmentRefs.length)
    return [] as Array<{ mimeType: string; base64: string }>;
  if (!resolver)
    throw new UnsupportedError("Mistral media requires a host media resolver");
  const images = [] as Array<{ mimeType: string; base64: string }>;
  for (const id of r.attachmentRefs) {
    const item = await resolver(id);
    if (
      !item.mimeType.startsWith("image/") ||
      !item.base64 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64)
    )
      throw new UnsupportedError(
        "Mistral adapter currently supports image attachments only",
      );
    images.push(item);
  }
  return images;
}
function safeParameters(params: Record<string, unknown>): Obj {
  const result: Obj = {};
  for (const key of [
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "random_seed",
    "presence_penalty",
    "frequency_penalty",
    "stop",
  ]) {
    const v = params[key];
    if (
      (typeof v === "number" && Number.isFinite(v)) ||
      typeof v === "string" ||
      (Array.isArray(v) && v.every((x) => typeof x === "string"))
    )
      result[key] = v;
  }
  return result;
}
function filterTools(value: unknown[], permitted: string[]): unknown[] {
  return value.filter((item) => {
    if (!isObj(item)) return false;
    const fn = isObj(item.function) ? item.function : item;
    return typeof fn.name === "string" && permitted.includes(fn.name);
  });
}
function parse(raw: string): Obj | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new ProtocolError(
      `Mistral stream contained malformed JSON.\n${errorDetails(cause)}\nServer response:\n${raw}`,
    );
  }
  if (!isObj(value))
    throw new ProtocolError(
      `Mistral stream event was malformed.\nServer response:\n${raw}`,
    );
  return value;
}
function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function int(v: unknown): number | undefined {
  return Number.isInteger(v) && typeof v === "number" && v >= 0 ? v : undefined;
}
function invocationId(run: string, index: number): string {
  const hex = (index + 1).toString(16).padStart(12, "0").slice(-12);
  return `${run.slice(0, 24)}${hex}`;
}
class ProtocolError extends Error {}
class AuthError extends Error {}
class SafetyError extends Error {}
class UnsupportedError extends Error {}
function classifyApiError(data: Obj) {
  const error = isObj(data.error) ? data.error : data;
  const classified = classifyErrorResponse(error);
  classified.message = `${classified.message || "Mistral reported a request error"}\nServer response:\n${JSON.stringify(data, null, 2)}`;
  return classified;
}
function classifyErrorResponse(error: Obj) {
  const code =
    `${String(error.code ?? "")} ${String(error.type ?? "")}`.toLowerCase();
  if (/quota|rate.?limit/.test(code)) return new QuotaError();
  if (/auth|api.?key|permission/.test(code))
    return new AuthError("Mistral rejected the saved API key");
  if (/model.*not.*found|unknown.model/.test(code))
    return new MissingModelError();
  return new ProtocolError("Mistral reported a request error");
}
class QuotaError extends Error {}
class MissingModelError extends Error {}
function normalize(error: unknown) {
  const classified = classify(error);
  const detail = errorDetails(error);
  return {
    ...classified,
    message: classified.message.includes(detail)
      ? classified.message
      : `${classified.message}\n${detail}`,
  };
}
function classify(error: unknown) {
  if (
    error instanceof AuthError ||
    (error instanceof HttpTransportError &&
      ["unauthorized", "forbidden"].includes(error.code))
  )
    return {
      code: "unauthorized" as const,
      message: "Mistral rejected the saved API key",
      recoverable: false,
      backend: "mistral",
    };
  if (
    error instanceof QuotaError ||
    (error instanceof HttpTransportError && error.status === 429)
  )
    return {
      code: "quota" as const,
      message: "Mistral quota or rate limit was reached",
      recoverable: true,
      backend: "mistral",
    };
  if (
    error instanceof MissingModelError ||
    (error instanceof HttpTransportError && error.status === 404)
  )
    return {
      code: "missing-model" as const,
      message: "Mistral model or endpoint was not found",
      recoverable: false,
      backend: "mistral",
    };
  if (error instanceof HttpTransportError && error.status === 413)
    return {
      code: "context-full" as const,
      message: "Mistral request exceeded a provider size limit",
      recoverable: false,
      backend: "mistral",
    };
  if (
    error instanceof HttpTransportError &&
    error.status &&
    error.status >= 400 &&
    error.status < 500
  )
    return {
      code: "malformed" as const,
      message: "Mistral rejected the request",
      recoverable: false,
      backend: "mistral",
    };
  if (error instanceof UnsupportedError)
    return {
      code: "unsupported" as const,
      message: error.message,
      recoverable: false,
      backend: "mistral",
    };
  if (error instanceof SafetyError)
    return {
      code: "permission" as const,
      message: error.message,
      recoverable: false,
      backend: "mistral",
    };
  if (error instanceof ProtocolError)
    return {
      code: "malformed" as const,
      message: error.message,
      recoverable: false,
      backend: "mistral",
    };
  if (error instanceof HttpTransportError && error.code === "timeout")
    return {
      code: "timeout" as const,
      message: "Mistral request timed out",
      recoverable: true,
      backend: "mistral",
    };
  if (error instanceof HttpTransportError && error.code === "canceled")
    return {
      code: "canceled" as const,
      message: "Mistral request canceled",
      recoverable: true,
      backend: "mistral",
    };
  return {
    code: "offline" as const,
    message: "Mistral request failed",
    recoverable: true,
    backend: "mistral",
  };
}
