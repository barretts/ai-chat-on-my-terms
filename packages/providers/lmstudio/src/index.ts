import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  createHttpTransport,
  type FetchLike,
  type HttpAuthorizationPolicy,
  type HttpTransport,
} from "@locallab/network-http";

export type LMStudioMode = "native" | "compatible";
export interface LMStudioOptions {
  /** Origin plus optional path prefix, e.g. http://127.0.0.1:1234. */
  baseUrl: string;
  /** Optional bearer token. Kept only in this client instance. */
  token?: string;
  /** Defaults to native v1 chat. */
  mode?: LMStudioMode;
  fetch?: FetchLike;
  http?: HttpTransport;
  policy?: HttpAuthorizationPolicy;
}

export interface LMStudioAdapter {
  startRun(request: RunRequest, signal: AbortSignal): AsyncIterable<RunEvent>;
  clearConversation(conversationId: string): void;
  dispose(): void;
}

interface NativeContinuation {
  providerId: string;
  modelId: string;
  expectedHistory: ChatMessage[];
  responseId: string;
}
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
type RunEventInput = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp">
    : never
  : never;
interface StreamEvent {
  [key: string]: unknown;
  type?: string;
  progress?: number;
  content?: string;
  result?: Record<string, unknown>;
  error?: { message?: string; type?: string };
}

/**
 * LM Studio v1 adapter. Native response IDs are only reused when the full
 * committed transcript is an exact prefix of the next request. A mismatch
 * falls back to a stateless compatible request with the complete transcript.
 */
export function createLMStudioAdapter(
  options: LMStudioOptions,
): LMStudioAdapter {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:")
    throw new TypeError("LM Studio URL must use HTTP or HTTPS");
  base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
  if (!options.http && !options.policy)
    throw new TypeError(
      "LM Studio requires an approved shared HTTP origin policy",
    );
  const transport =
    options.http ??
    createHttpTransport({
      fetch: options.fetch ?? fetch,
      policy: options.policy!,
    });
  const mode = options.mode ?? "native";
  const continuations = new Map<string, NativeContinuation>();
  const nativeInFlight = new Set<string>();
  const headers = new Headers({
    "content-type": "application/json",
    accept: "text/event-stream",
  });
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);

  function endpoint(path: string): URL {
    return new URL(path.replace(/^\//, ""), base);
  }
  function clearConversation(conversationId: string): void {
    for (const key of continuations.keys())
      if (key.endsWith(`\0${conversationId}`)) continuations.delete(key);
  }

  async function* startRun(
    request: RunRequest,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    let sequence = 0;
    const emit = (event: RunEventInput): RunEvent =>
      ({
        ...event,
        runId: request.runId,
        sequence: sequence++,
        timestamp: new Date().toISOString(),
      }) as RunEvent;
    yield emit({ type: "RunStarted" });
    const history = toMessages(request.context);
    const key = `${request.providerConnectionId}\0${request.conversationId}`;
    for (const [continuationKey, continuation] of continuations) {
      if (!continuationKey.endsWith(`\0${request.conversationId}`)) continue;
      if (
        continuation.providerId !== request.providerConnectionId ||
        continuation.modelId !== request.modelId
      )
        continuations.delete(continuationKey);
    }
    const saved = continuations.get(key);
    const canContinue =
      mode === "native" &&
      !nativeInFlight.has(key) &&
      saved &&
      saved.providerId === request.providerConnectionId &&
      saved.modelId === request.modelId &&
      isContinuationOf(saved.expectedHistory, history);
    const useNative =
      mode === "native" &&
      !nativeInFlight.has(key) &&
      ((!saved && history.length === 1 && history[0]?.role === "user") ||
        Boolean(canContinue));
    if (saved && !canContinue) continuations.delete(key);
    if (useNative) {
      nativeInFlight.add(key);
      if (canContinue) continuations.delete(key);
    }
    const authHeaders = new Headers(headers);
    const body = useNative
      ? nativeBody(
          request,
          canContinue ? history.at(-1)!.content : (history[0]?.content ?? ""),
          canContinue ? saved.responseId : undefined,
        )
      : compatibleBody(request, history);
    let final: Record<string, unknown> | undefined;
    let text = "";
    let reasoning = "";
    try {
      for await (const frame of transport.streamSse(
        endpoint(useNative ? "api/v1/chat" : "v1/chat/completions"),
        { method: "POST", headers: authHeaders, body: JSON.stringify(body) },
        { signal },
      )) {
        const data = parseFrame(frame.data);
        if (!data) continue;
        const type = frame.event ?? data.type;
        if (type === "model_load.start")
          yield emit({
            type: "LoadProgress",
            fraction: 0,
            detail: "Loading model",
          });
        else if (type === "model_load.progress" && isProgress(data.progress))
          yield emit({ type: "LoadProgress", fraction: data.progress });
        else if (type === "model_load.end")
          yield emit({
            type: "LoadProgress",
            fraction: 1,
            detail: "Model loaded",
          });
        else if (type === "prompt_processing.start")
          yield emit({ type: "PromptProgress", fraction: 0 });
        else if (
          type === "prompt_processing.progress" &&
          isProgress(data.progress)
        )
          yield emit({ type: "PromptProgress", fraction: data.progress });
        else if (type === "prompt_processing.end")
          yield emit({ type: "PromptProgress", fraction: 1 });
        else if (
          type === "reasoning.delta" &&
          typeof data.content === "string"
        ) {
          reasoning += data.content;
          yield emit({ type: "ReasoningDelta", text: data.content });
        } else if (
          type === "message.delta" &&
          typeof data.content === "string"
        ) {
          text += data.content;
          yield emit({ type: "TextDelta", text: data.content });
        } else if (type === "chat.end" && isRecord(data.result))
          final = data.result;
        else if (type === "error")
          throw new Error(
            data.error?.message ?? "LM Studio reported a chat error",
          );
        // Compatible API streams use OpenAI's data-only chunk framing.
        else if (
          type === undefined &&
          data.choices &&
          Array.isArray(data.choices)
        ) {
          const choice = data.choices[0];
          if (isRecord(choice) && isRecord(choice.delta)) {
            if (typeof choice.delta.content === "string") {
              text += choice.delta.content;
              yield emit({ type: "TextDelta", text: choice.delta.content });
            }
            if (typeof choice.delta.reasoning_content === "string") {
              reasoning += choice.delta.reasoning_content;
              yield emit({
                type: "ReasoningDelta",
                text: choice.delta.reasoning_content,
              });
            }
          }
          if (isRecord(choice) && choice.finish_reason) final = data;
        }
      }
      if (!final && useNative)
        throw new Error("LM Studio stream ended without chat.end");
      if (!useNative && !final)
        throw new Error(
          "LM Studio compatible stream ended without a final chunk",
        );
      const stats =
        useNative && isRecord(final?.stats)
          ? final.stats
          : compatibleUsage(final);
      if (useNative && text.length === 0) {
        text = extractNativeText(final);
        if (text) yield emit({ type: "TextDelta", text });
      }
      const inputTokens = readNumber(
        stats?.input_tokens ?? stats?.prompt_tokens,
      );
      const outputTokens = readNumber(
        stats?.total_output_tokens ?? stats?.completion_tokens,
      );
      if (inputTokens !== undefined || outputTokens !== undefined)
        yield emit({
          type: "Usage",
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        });
      if (useNative) {
        const responseId =
          typeof final?.response_id === "string"
            ? final.response_id
            : undefined;
        if (responseId && responseId.startsWith("resp_")) {
          const assistantText = text || extractNativeText(final);
          continuations.set(key, {
            providerId: request.providerConnectionId,
            modelId: request.modelId,
            responseId,
            expectedHistory: [
              ...history,
              ...(assistantText
                ? [{ role: "assistant" as const, content: assistantText }]
                : []),
            ],
          });
        } else continuations.delete(key);
      }
      yield emit({
        type: "RunCompleted",
        finishReason: readFinish(final, useNative),
      });
    } catch (error) {
      continuations.delete(key);
      yield emit({
        type: "RunFailed",
        error: {
          code: signal.aborted ? "canceled" : "provider_error",
          message: safeError(error),
          recoverable: signal.aborted,
        },
      });
    } finally {
      if (useNative) nativeInFlight.delete(key);
    }
  }

  return {
    startRun,
    clearConversation,
    dispose() {
      continuations.clear();
      nativeInFlight.clear();
    },
  };
}

function nativeBody(
  request: RunRequest,
  input: string,
  previousResponseId?: string,
): Record<string, unknown> {
  return {
    model: request.modelId,
    input,
    stream: true,
    store: true,
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    ...parameters(request.parameters),
    ...(request.reasoning ? { reasoning: "on" } : {}),
  };
}
function compatibleBody(
  request: RunRequest,
  history: ChatMessage[],
): Record<string, unknown> {
  const system = history
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  return {
    model: request.modelId,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      ...history.filter((m) => m.role !== "system"),
    ],
    stream: true,
    ...compatibleParameters(request.parameters),
    ...(request.reasoning ? { reasoning_effort: "high" } : {}),
  };
}
function compatibleParameters(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result = parameters(value);
  if (result.max_output_tokens !== undefined) {
    result.max_tokens = result.max_output_tokens;
    delete result.max_output_tokens;
  }
  return result;
}
function parameters(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "repeat_penalty",
    "max_output_tokens",
    "context_length",
  ])
    if (value[key] !== undefined) result[key] = value[key];
  return result;
}
function toMessages(context: RunRequest["context"]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const item of context) {
    if (!["system", "developer", "user", "assistant"].includes(item.kind))
      continue;
    const role =
      item.kind === "developer" ? "system" : (item.kind as ChatMessage["role"]);
    const content =
      typeof item.value === "string"
        ? item.value
        : isRecord(item.value) && typeof item.value.content === "string"
          ? item.value.content
          : isRecord(item.value) && typeof item.value.text === "string"
            ? item.value.text
            : isRecord(item.value) && Array.isArray(item.value.parts)
              ? item.value.parts
                  .filter(isRecord)
                  .filter(
                    (part) => part.type === "text" || part.type === "reasoning",
                  )
                  .map((part) =>
                    typeof part.text === "string" ? part.text : "",
                  )
                  .join("")
              : undefined;
    if (content !== undefined) result.push({ role, content });
  }
  return result;
}
function isContinuationOf(
  expected: ChatMessage[],
  next: ChatMessage[],
): boolean {
  return (
    next.length === expected.length + 1 &&
    next.at(-1)?.role === "user" &&
    expected.every(
      (message, i) =>
        message.role === next[i]?.role && message.content === next[i]?.content,
    )
  );
}
function parseFrame(raw: string): StreamEvent | undefined {
  if (raw.trim() === "[DONE]") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? (value as StreamEvent) : undefined;
  } catch {
    return undefined;
  }
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isProgress(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}
function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
function compatibleUsage(
  final: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return isRecord(final?.usage) ? final.usage : undefined;
}
function readFinish(
  final: Record<string, unknown> | undefined,
  native: boolean,
): string | undefined {
  if (native && isRecord(final?.stats)) return "stop";
  const choices = final?.choices;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  return isRecord(choice) && typeof choice.finish_reason === "string"
    ? choice.finish_reason
    : undefined;
}
function extractNativeText(final: Record<string, unknown> | undefined): string {
  if (!Array.isArray(final?.output)) return "";
  return final.output
    .filter(isRecord)
    .filter(
      (item) => item.type === "message" && typeof item.content === "string",
    )
    .map((item) => item.content as string)
    .join("");
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "LM Studio request failed";
}
