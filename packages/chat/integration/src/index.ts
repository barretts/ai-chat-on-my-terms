import type { RunEvent } from "@locallab/contracts/run-events";
import {
  localFailureCause,
  retainLocalFailureCause,
} from "@locallab/contracts/local-failure-details";
export * from "./features";

export interface IntegratedRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<RunEvent>;
  stop(reason?: string): Promise<void>;
}

export interface ChatSendIntent {
  readonly conversationId: string;
  readonly text: string;
  readonly attachmentRefs?: readonly string[];
}

export interface ChatFeatureBindings {
  retainAttachments(ownerId: string, refs: readonly string[]): Promise<void>;
  indexConversation?(conversationId: string): Promise<void>;
  onEvent?(conversationId: string, event: RunEvent): Promise<void> | void;
}

export class ChatIntegrationError extends Error {
  constructor(
    readonly code:
      | "empty-message"
      | "missing-model"
      | "host-stopped"
      | "context-full"
      | "unauthorized"
      | "network"
      | "web-research"
      | "feature-failed"
      | "generation-failed",
    message: string,
    readonly recoverable = true,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ChatIntegrationError";
  }
}

/** Bridges composer send intent to the selected engine and shared chat features. */
export class ChatIntegration<
  TIntent extends ChatSendIntent = ChatSendIntent,
  TRun extends IntegratedRunHandle = IntegratedRunHandle,
> {
  constructor(
    private readonly start: (input: TIntent) => Promise<TRun>,
    private readonly features: ChatFeatureBindings,
  ) {}

  async send(input: TIntent): Promise<TRun> {
    const refs = [...new Set(input.attachmentRefs ?? [])];
    if (!input.conversationId.trim())
      throw new ChatIntegrationError(
        "generation-failed",
        "Open a conversation before sending.",
      );
    if (!input.text.trim() && refs.length === 0)
      throw new ChatIntegrationError(
        "empty-message",
        "Write a message or attach a file before sending.",
      );

    const ownerId = `conversation:${input.conversationId}`;
    await this.features.retainAttachments(ownerId, refs);
    let run: TRun;
    try {
      run = await this.start({ ...input, attachmentRefs: refs });
    } catch (error) {
      // Retain refs on failure so the composer can retry without data loss.
      throw toRecoverableChatError(error);
    }
    return {
      ...run,
      runId: run.runId,
      events: this.observe(input.conversationId, run),
      stop: (reason?: string) => run.stop(reason),
    };
  }

  private async *observe(
    conversationId: string,
    run: IntegratedRunHandle,
  ): AsyncIterable<RunEvent> {
    const iterator = run.events[Symbol.asyncIterator]();
    let terminal = false;
    let featureFailed = false;
    const record = async (event: RunEvent) => {
      terminal = isTerminal(event);
      try {
        await this.features.onEvent?.(conversationId, event);
      } catch (cause) {
        featureFailed = true;
        throw featureError(cause);
      }
    };
    try {
      while (!terminal) {
        const next = await iterator.next();
        if (next.done) break;
        const event = normalizeFailureEvent(next.value);
        await record(event);
        yield event;
      }
    } catch (error) {
      throw toRecoverableChatError(error);
    } finally {
      try {
        if (!terminal) {
          await run.stop("Chat stream consumer closed");
          // The engine persists cancellation before stop resolves. Consume its terminal
          // so lifecycle and search hooks see the same durable state as the transcript.
          while (!terminal) {
            const next = await iterator.next();
            if (next.done) break;
            try {
              await record(normalizeFailureEvent(next.value));
            } catch {
              featureFailed = true;
            }
          }
        }
      } catch (error) {
        throw toRecoverableChatError(error);
      } finally {
        try {
          await iterator.return?.();
        } catch {
          featureFailed = true;
        }
        if (terminal) {
          try {
            await this.features.indexConversation?.(conversationId);
          } catch {
            featureFailed = true;
          }
        }
        if (featureFailed) throw featureError();
      }
    }
  }
}

function isTerminal(event: RunEvent): boolean {
  return (
    event.type === "RunCompleted" ||
    event.type === "RunCanceled" ||
    event.type === "RunFailed"
  );
}

function featureError(cause?: unknown): ChatIntegrationError {
  return new ChatIntegrationError(
    "feature-failed",
    "A chat feature could not update. Reopen the conversation and retry the feature.",
    true,
    cause,
  );
}

export function toRecoverableChatError(error: unknown): ChatIntegrationError {
  if (error instanceof ChatIntegrationError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const text =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "";
  const failure = (code: ChatIntegrationError["code"], message: string) =>
    new ChatIntegrationError(code, message, true, error);
  if (code === "web-research")
    return failure(
      "web-research",
      text ||
        "Web research could not finish. Try again or turn web access off.",
    );
  if (
    /missing-model|model-required|select-model|model binding is required/i.test(
      `${code} ${text}`,
    )
  )
    return failure(
      "missing-model",
      "Select or import a compatible model, then retry.",
    );
  if (/host-stopped|runtime-disposed|worker-stopped/i.test(`${code} ${text}`))
    return failure(
      "host-stopped",
      "The selected runtime stopped. Restart it and retry your saved message.",
    );
  if (
    /context[-_ ](?:full|window|length)|too[-_ ]many[-_ ]tokens/i.test(
      `${code} ${text}`,
    )
  )
    return failure(
      "context-full",
      "The persona, message, or history exceeds the input budget. Shorten it, increase context to match your model, or lower the output token limit, then retry.",
    );
  const httpStatus = /\bHTTP\s+([45]\d{2})\b/i.exec(text)?.[1];
  if (httpStatus && httpStatus !== "401" && httpStatus !== "403")
    return failure(
      "generation-failed",
      `The server returned HTTP ${httpStatus}. Review the response details and retry.`,
    );
  if (/returned (?:a stream error|an error response)/i.test(text))
    return failure(
      "generation-failed",
      "The server could not complete the request. Review the response details and retry.",
    );
  if (/unauthorized|forbidden|invalid.?key|401|403/i.test(`${code} ${text}`))
    return failure(
      "unauthorized",
      "The provider rejected its saved credential. Update provider setup and retry.",
    );
  if (/timeout|timed out/i.test(`${code} ${text}`))
    return failure(
      "network",
      "The provider took too long to respond. It may be busy; retry when ready.",
    );
  if (/network|offline|connection/i.test(`${code} ${text}`))
    return failure(
      "network",
      "The provider could not be reached. Check the connection and retry.",
    );
  return failure(
    "generation-failed",
    "The response could not be completed. Retry when ready.",
  );
}

/** Use with the app's credential-redacting error formatter, never a raw export. */
export function chatFailureCause(error: object): unknown {
  return localFailureCause(error);
}

function normalizeFailureEvent(event: RunEvent): RunEvent {
  if (event.type !== "RunFailed") return event;
  const error = toRecoverableChatError(event.error);
  const publicFailure = {
    code: error.code,
    message: error.message,
    recoverable: event.error.recoverable,
  };
  retainLocalFailureCause(publicFailure, localFailureCause(event.error));
  return {
    ...event,
    error: publicFailure,
  };
}
