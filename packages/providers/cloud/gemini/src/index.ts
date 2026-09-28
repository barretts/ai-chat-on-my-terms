import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  createHttpTransport,
  HttpTransportError,
  type FetchLike,
} from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";

export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
export interface GeminiConnection {
  readonly modelId?: string;
  readonly endpointOrigin?: string;
  readonly apiKeyRef: SecretRef;
}
export interface GeminiOptions {
  readonly secrets: SecretStore;
  readonly resolveConnection: (
    providerConnectionId: string,
  ) => Promise<GeminiConnection>;
  readonly fetch: FetchLike;
  /** Optional host media bridge. Only image bytes are currently supported. */
  readonly resolveMedia?: (
    attachmentId: string,
  ) => Promise<{ readonly mimeType: string; readonly base64: string }>;
  readonly now?: () => string;
}
type Payload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp">
    : never
  : never;
type Obj = Record<string, unknown>;

/** Gemini generateContent streaming adapter. Credentials stay in a host-scoped secret ref. */
export function createGeminiProvider(
  options: GeminiOptions,
): ProviderPort<GeminiConnection> {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async listModels(connection, signal) {
      try {
        const config = validate(connection);
        const key = await keyFor(
          options.secrets,
          config.origin,
          config.apiKeyRef,
        );
        const http = createHttpTransport({
          fetch: options.fetch,
          policy: { authorizedOrigins: [config.origin] },
        });
        const response = await http.request(
          new URL("/v1beta/models", config.origin),
          { headers: { "x-goog-api-key": key }, ...(signal ? { signal } : {}) },
          signal ? { signal } : {},
        );
        const body: unknown = await response.json();
        if (!isObj(body) || !Array.isArray(body.models))
          throw new ProtocolError("Gemini model list was malformed");
        const values = body.models.flatMap((m) =>
          isObj(m) && typeof m.name === "string"
            ? [m.name.replace(/^models\//, "")]
            : [],
        );
        return {
          ok: true,
          value: [...new Set(values)],
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
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      yield emit({ type: "RunStarted" });
      try {
        if (controller.signal.aborted) {
          yield emit({ type: "RunCanceled", reason: "canceled" });
          return;
        }
        const media = await resolveImages(request, options.resolveMedia);
        const config = validate(
          await options.resolveConnection(request.providerConnectionId),
        );
        const key = await keyFor(
          options.secrets,
          config.origin,
          config.apiKeyRef,
        );
        const url = new URL(
          `/v1beta/models/${encodeURIComponent(request.modelId || config.modelId)}:streamGenerateContent`,
          config.origin,
        );
        url.searchParams.set("alt", "sse");
        const http = createHttpTransport({
          fetch: options.fetch,
          policy: { authorizedOrigins: [config.origin] },
        });
        let completed = false,
          finish: string | undefined;
        const functionCalls = new Map<string, { name: string; args: Obj }>();
        for await (const frame of http.streamSse(
          url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              "x-goog-api-key": key,
            },
            body: JSON.stringify(toGeminiBody(request, media)),
            signal: controller.signal,
          },
          { signal: controller.signal },
        )) {
          const data = parse(frame.data);
          if (!data) continue;
          if (isObj(data.error)) throw classifyApiError(data.error);
          const feedback = isObj(data.promptFeedback)
            ? data.promptFeedback
            : undefined;
          if (feedback?.blockReason)
            throw new SafetyError(
              "Gemini blocked the prompt under its safety policy",
            );
          const candidates = Array.isArray(data.candidates)
            ? data.candidates
            : [];
          for (const candidate of candidates) {
            if (!isObj(candidate)) continue;
            const reason =
              typeof candidate.finishReason === "string"
                ? candidate.finishReason
                : undefined;
            if (reason) {
              finish = reason;
              completed = true;
            }
            if (reason === "SAFETY" || reason === "RECITATION")
              throw new SafetyError(
                "Gemini blocked the response under its safety policy",
              );
            const content = isObj(candidate.content)
              ? candidate.content
              : undefined;
            const parts = Array.isArray(content?.parts) ? content.parts : [];
            for (const part of parts) {
              if (!isObj(part)) continue;
              if (typeof part.text === "string" && part.text)
                yield emit({ type: "TextDelta", text: part.text });
              // Function calls are only forwarded when they were explicitly permitted.
              if (
                isObj(part.functionCall) &&
                typeof part.functionCall.name === "string" &&
                request.permittedTools.includes(part.functionCall.name)
              ) {
                const name = part.functionCall.name;
                const call = functionCalls.get(name) ?? { name, args: {} };
                if (isObj(part.functionCall.args))
                  Object.assign(call.args, part.functionCall.args);
                functionCalls.set(name, call);
              }
            }
          }
          if (isObj(data.usageMetadata)) {
            const input = int(data.usageMetadata.promptTokenCount),
              output = int(data.usageMetadata.candidatesTokenCount);
            if (input !== undefined || output !== undefined)
              yield emit({
                type: "Usage",
                ...(input === undefined ? {} : { inputTokens: input }),
                ...(output === undefined ? {} : { outputTokens: output }),
              });
          }
        }
        if (controller.signal.aborted)
          yield emit({ type: "RunCanceled", reason: "canceled" });
        else if (!completed)
          throw new ProtocolError(
            "Gemini stream ended without a candidate finish reason",
          );
        else {
          for (const call of functionCalls.values())
            yield emit({
              type: "ToolCall",
              invocationId: toolId(request.runId, call.name),
              name: call.name,
              input: call.args,
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

function validate(c: GeminiConnection) {
  const origin = c.endpointOrigin ?? GEMINI_ORIGIN;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ProtocolError("Gemini origin is invalid");
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
    throw new ProtocolError("Gemini endpoint must be an exact HTTPS origin");
  const modelId = (c.modelId ?? "").trim();
  if (!c.apiKeyRef || modelId.length > 200)
    throw new ProtocolError("Gemini connection is incomplete");
  return { origin: url.origin, modelId, apiKeyRef: c.apiKeyRef };
}
async function keyFor(store: SecretStore, origin: string, ref: SecretRef) {
  try {
    const values = await store.resolveHeaders(origin, [ref]);
    const key =
      values["x-goog-api-key"] ??
      values["authorization"]?.replace(/^Bearer\s+/i, "");
    if (!key || /[\r\n]/.test(key)) throw new Error();
    return key;
  } catch {
    throw new AuthError("Gemini API key is unavailable for this host");
  }
}
function toGeminiBody(
  r: RunRequest,
  media: readonly { mimeType: string; base64: string }[],
): Obj {
  const system: string[] = [],
    contents: Obj[] = [];
  for (const item of r.context) {
    if (!["system", "developer", "user", "assistant"].includes(item.kind))
      continue;
    const text =
      typeof item.value === "string"
        ? item.value
        : isObj(item.value) && typeof item.value.text === "string"
          ? item.value.text
          : isObj(item.value) && typeof item.value.content === "string"
            ? item.value.content
            : undefined;
    if (text === undefined) continue;
    if (item.kind === "system" || item.kind === "developer") system.push(text);
    else
      contents.push({
        role: item.kind === "assistant" ? "model" : "user",
        parts: [{ text }],
      });
  }
  if (media.length) {
    const user = [...contents].reverse().find((m) => m.role === "user");
    if (user && Array.isArray(user.parts))
      for (const image of media)
        user.parts.push({
          inlineData: { mimeType: image.mimeType, data: image.base64 },
        });
  }
  const generationConfig: Obj = {};
  for (const [key, value] of Object.entries(r.parameters))
    if (
      [
        "temperature",
        "topP",
        "topK",
        "maxOutputTokens",
        "candidateCount",
        "stopSequences",
      ].includes(key) &&
      isSafeParam(value)
    )
      generationConfig[key] = value;
  if (r.json) {
    generationConfig.responseMimeType = "application/json";
  }
  const toolsParam = Array.isArray(r.parameters.tools)
    ? r.parameters.tools.flatMap((x) => {
        if (!isObj(x)) return [];
        const fn = isObj(x.function) ? x.function : x;
        if (typeof fn.name !== "string" || !r.permittedTools.includes(fn.name))
          return [];
        return [
          {
            name: fn.name,
            ...(typeof fn.description === "string"
              ? { description: fn.description }
              : {}),
            ...(isObj(fn.parameters) ? { parameters: fn.parameters } : {}),
          },
        ];
      })
    : [];
  return {
    ...(system.length
      ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } }
      : {}),
    contents,
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(toolsParam.length
      ? { tools: [{ functionDeclarations: toolsParam }] }
      : {}),
  };
}
function parse(raw: string): Obj | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError("Gemini stream contained malformed JSON");
  }
  if (!isObj(value))
    throw new ProtocolError("Gemini stream event was malformed");
  return value;
}
function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function int(v: unknown): number | undefined {
  return Number.isInteger(v) && typeof v === "number" && v >= 0 ? v : undefined;
}
async function resolveImages(
  r: RunRequest,
  resolver: GeminiOptions["resolveMedia"],
) {
  if (!r.attachmentRefs.length)
    return [] as Array<{ mimeType: string; base64: string }>;
  if (!resolver)
    throw new UnsupportedError("Gemini media requires a host media resolver");
  const images = [] as Array<{ mimeType: string; base64: string }>;
  for (const id of r.attachmentRefs) {
    const item = await resolver(id);
    if (
      !item.mimeType.startsWith("image/") ||
      !item.base64 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64)
    )
      throw new UnsupportedError(
        "Gemini adapter currently supports image attachments only",
      );
    images.push(item);
  }
  return images;
}
function isSafeParam(v: unknown): boolean {
  return (
    typeof v === "string" ||
    (typeof v === "number" && Number.isFinite(v)) ||
    (Array.isArray(v) && v.every((x) => typeof x === "string"))
  );
}
function toolId(run: string, name: string) {
  const suffix = [...name]
    .reduce((n, c) => (n * 33 + c.charCodeAt(0)) >>> 0, 5381)
    .toString(16)
    .padStart(12, "0")
    .slice(-12);
  return `${run.slice(0, 24)}${suffix}`;
}
class ProtocolError extends Error {}
class AuthError extends Error {}
class SafetyError extends Error {}
class UnsupportedError extends Error {}
class QuotaError extends Error {}
class MissingModelError extends Error {}
class ProviderRejectedError extends Error {}
function classifyApiError(error: Obj) {
  const detail =
    `${String(error.status ?? "")} ${String(error.message ?? "")} ${String(error.code ?? "")}`.toLowerCase();
  if (/resource_exhausted|quota|rate.?limit|429/.test(detail))
    return new QuotaError();
  if (/not_found|model.*not.*found|404/.test(detail))
    return new MissingModelError();
  if (/permission_denied|forbidden|403/.test(detail))
    return new ProviderRejectedError();
  if (/unauthenticated|invalid.*key|401/.test(detail))
    return new AuthError("Gemini rejected the saved API key");
  return new ProtocolError("Gemini reported a request error");
}
function normalize(error: unknown) {
  if (
    error instanceof AuthError ||
    (error instanceof HttpTransportError &&
      ["unauthorized", "forbidden"].includes(error.code))
  )
    return {
      code: "unauthorized" as const,
      message: "Gemini rejected the saved API key",
      recoverable: false,
      backend: "gemini",
    };
  if (error instanceof UnsupportedError)
    return {
      code: "unsupported" as const,
      message: error.message,
      recoverable: false,
      backend: "gemini",
    };
  if (error instanceof SafetyError)
    return {
      code: "permission" as const,
      message: error.message,
      recoverable: false,
      backend: "gemini",
    };
  if (
    error instanceof QuotaError ||
    (error instanceof HttpTransportError && error.status === 429)
  )
    return {
      code: "quota" as const,
      message: "Gemini quota or rate limit was reached",
      recoverable: true,
      backend: "gemini",
    };
  if (
    error instanceof MissingModelError ||
    (error instanceof HttpTransportError && error.status === 404)
  )
    return {
      code: "missing-model" as const,
      message: "Gemini model or endpoint was not found",
      recoverable: false,
      backend: "gemini",
    };
  if (error instanceof ProviderRejectedError)
    return {
      code: "permission" as const,
      message: "Gemini denied this request",
      recoverable: false,
      backend: "gemini",
    };
  if (error instanceof ProtocolError)
    return {
      code: "malformed" as const,
      message: error.message,
      recoverable: false,
      backend: "gemini",
    };
  if (error instanceof HttpTransportError && error.status === 413)
    return {
      code: "context-full" as const,
      message: "Gemini request exceeded a provider size limit",
      recoverable: false,
      backend: "gemini",
    };
  if (
    error instanceof HttpTransportError &&
    error.status &&
    error.status >= 400 &&
    error.status < 500
  )
    return {
      code: "malformed" as const,
      message: "Gemini rejected the request",
      recoverable: false,
      backend: "gemini",
    };
  if (error instanceof HttpTransportError && error.code === "timeout")
    return {
      code: "timeout" as const,
      message: "Gemini request timed out",
      recoverable: true,
      backend: "gemini",
    };
  if (error instanceof HttpTransportError && error.code === "canceled")
    return {
      code: "canceled" as const,
      message: "Gemini request canceled",
      recoverable: true,
      backend: "gemini",
    };
  return {
    code: "offline" as const,
    message: "Gemini request failed",
    recoverable: true,
    backend: "gemini",
  };
}
