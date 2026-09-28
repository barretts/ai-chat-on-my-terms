import type { RunEvent } from "@locallab/contracts/run-events";
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
      | "feature-failed"
      | "generation-failed",
    message: string,
    readonly recoverable = true,
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
      } catch {
        featureFailed = true;
        throw featureError();
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

function featureError(): ChatIntegrationError {
  return new ChatIntegrationError(
    "feature-failed",
    "A chat feature could not update. Reopen the conversation and retry the feature.",
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
  if (
    /missing-model|model-required|select-model|model binding is required/i.test(
      `${code} ${text}`,
    )
  )
    return new ChatIntegrationError(
      "missing-model",
      "Select or import a compatible model, then retry.",
    );
  if (/host-stopped|runtime-disposed|worker-stopped/i.test(`${code} ${text}`))
    return new ChatIntegrationError(
      "host-stopped",
      "The selected runtime stopped. Restart it and retry your saved message.",
    );
  if (
    /context[-_ ](?:full|window|length)|too[-_ ]many[-_ ]tokens/i.test(
      `${code} ${text}`,
    )
  )
    return new ChatIntegrationError(
      "context-full",
      "This conversation exceeds the model context. Shorten or compact it, then retry.",
    );
  if (/unauthorized|forbidden|invalid.?key|401|403/i.test(`${code} ${text}`))
    return new ChatIntegrationError(
      "unauthorized",
      "The provider rejected its saved credential. Update provider setup and retry.",
    );
  if (/timeout|timed out/i.test(`${code} ${text}`))
    return new ChatIntegrationError(
      "network",
      "The provider took too long to respond. It may be busy; retry when ready.",
    );
  if (/network|offline|connection/i.test(`${code} ${text}`))
    return new ChatIntegrationError(
      "network",
      "The provider could not be reached. Check the connection and retry.",
    );
  return new ChatIntegrationError(
    "generation-failed",
    "The response could not be completed. Retry when ready.",
  );
}

function normalizeFailureEvent(event: RunEvent): RunEvent {
  if (event.type !== "RunFailed") return event;
  const error = toRecoverableChatError(event.error);
  return {
    ...event,
    error: {
      code: error.code,
      message: error.message,
      recoverable: event.error.recoverable,
    },
  };
}
