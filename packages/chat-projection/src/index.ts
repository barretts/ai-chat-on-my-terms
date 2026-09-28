import type { RunEvent } from "@locallab/contracts/run-events";

export type RunStatus =
  | "idle"
  | "running"
  | "completed"
  | "canceled"
  | "failed";

export type TranscriptPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; invocationId: string; name: string; input: unknown }
  | { type: "tool-result"; invocationId: string; output: unknown }
  | { type: "source"; url: string; title?: string }
  | { type: "media"; mediaId: string; mediaType: string };

export interface TranscriptMessage {
  id: string;
  role: "assistant";
  runId: string;
  participantId?: string;
  status: RunStatus;
  parts: TranscriptPart[];
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
  error?: { code: string; message: string; recoverable: boolean };
}

export interface ProjectionSnapshot {
  version: 1;
  messages: TranscriptMessage[];
  cursors: Array<{ runId: string; sequence: number; terminal: boolean }>;
}

export class ProjectionTerminalError extends Error {
  constructor(
    readonly runId: string,
    message = "Run is already terminal",
  ) {
    super(message);
    this.name = "ProjectionTerminalError";
  }
}

export class ProjectionIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionIdentityError";
  }
}

/** Stateful, serializable run-event projection. Sequence cursors are per run. */
export class RunEventProjection {
  private readonly messages = new Map<string, TranscriptMessage>();
  private readonly cursors = new Map<
    string,
    { sequence: number; terminal: boolean }
  >();

  constructor(snapshot?: ProjectionSnapshot) {
    if (!snapshot) return;
    if (snapshot.version !== 1)
      throw new Error(
        `Unsupported projection snapshot version: ${String(snapshot.version)}`,
      );
    for (const message of snapshot.messages)
      this.messages.set(message.runId, cloneMessage(message));
    for (const cursor of snapshot.cursors)
      this.cursors.set(cursor.runId, {
        sequence: cursor.sequence,
        terminal: cursor.terminal,
      });
  }

  apply(event: RunEvent): "applied" | "duplicate" {
    const cursor = this.cursors.get(event.runId);
    if (cursor && event.sequence <= cursor.sequence) return "duplicate";
    if (cursor?.terminal) throw new ProjectionTerminalError(event.runId);

    let message = this.messages.get(event.runId);
    if (!message) {
      message = {
        id: event.runId,
        role: "assistant",
        runId: event.runId,
        ...(event.participantId ? { participantId: event.participantId } : {}),
        status: "running",
        parts: [],
      };
      this.messages.set(event.runId, message);
    } else if (
      event.participantId &&
      message.participantId &&
      event.participantId !== message.participantId
    ) {
      throw new ProjectionIdentityError(
        `participantId changed within run ${event.runId}`,
      );
    } else if (event.participantId && !message.participantId) {
      message.participantId = event.participantId;
    }

    this.project(message, event);
    this.cursors.set(event.runId, {
      sequence: event.sequence,
      terminal: isTerminal(event),
    });
    return "applied";
  }

  getMessages(): TranscriptMessage[] {
    return [...this.messages.values()]
      .map(cloneMessage)
      .sort((a, b) => a.runId.localeCompare(b.runId));
  }

  getMessage(runId: string): TranscriptMessage | undefined {
    const message = this.messages.get(runId);
    return message && cloneMessage(message);
  }

  snapshot(): ProjectionSnapshot {
    return {
      version: 1,
      messages: this.getMessages(),
      cursors: [...this.cursors].map(([runId, cursor]) => ({
        runId,
        ...cursor,
      })),
    };
  }

  cancelActive(reason = "Canceled"): TranscriptMessage[] {
    const canceled: TranscriptMessage[] = [];
    for (const [runId, message] of this.messages) {
      const cursor = this.cursors.get(runId);
      if (message.status !== "running" || cursor?.terminal) continue;
      message.status = "canceled";
      message.error = { code: "canceled", message: reason, recoverable: true };
      this.cursors.set(runId, {
        sequence: (cursor?.sequence ?? -1) + 1,
        terminal: true,
      });
      canceled.push(cloneMessage(message));
    }
    return canceled;
  }

  private project(message: TranscriptMessage, event: RunEvent): void {
    switch (event.type) {
      case "RunStarted":
      case "LoadProgress":
      case "PromptProgress":
        message.status = "running";
        break;
      case "TextDelta":
        appendText(message, "text", event.text);
        break;
      case "ReasoningDelta":
        appendText(message, "reasoning", event.text);
        break;
      case "ToolCall":
        message.parts.push({
          type: "tool-call",
          invocationId: event.invocationId,
          name: event.name,
          input: event.input,
        });
        break;
      case "ToolResult":
        message.parts.push({
          type: "tool-result",
          invocationId: event.invocationId,
          output: event.output,
        });
        break;
      case "Source":
        message.parts.push({
          type: "source",
          url: event.url,
          ...(event.title !== undefined ? { title: event.title } : {}),
        });
        break;
      case "MediaReference":
        message.parts.push({
          type: "media",
          mediaId: event.mediaId,
          mediaType: event.mediaType,
        });
        break;
      case "Usage":
        message.usage = {
          ...(event.inputTokens !== undefined
            ? { inputTokens: event.inputTokens }
            : message.usage?.inputTokens !== undefined
              ? { inputTokens: message.usage.inputTokens }
              : {}),
          ...(event.outputTokens !== undefined
            ? { outputTokens: event.outputTokens }
            : message.usage?.outputTokens !== undefined
              ? { outputTokens: message.usage.outputTokens }
              : {}),
        };
        break;
      case "RunCompleted":
        message.status = "completed";
        if (event.finishReason !== undefined)
          message.finishReason = event.finishReason;
        break;
      case "RunCanceled":
        message.status = "canceled";
        if (event.reason)
          message.error = {
            code: "canceled",
            message: event.reason,
            recoverable: true,
          };
        break;
      case "RunFailed":
        message.status = "failed";
        message.error = event.error;
        break;
    }
  }
}

function appendText(
  message: TranscriptMessage,
  type: "text" | "reasoning",
  fragment: string,
): void {
  if (fragment.length === 0) return;
  const last = message.parts.at(-1);
  if (last?.type === type) last.text += fragment;
  else message.parts.push({ type, text: fragment });
}

function isTerminal(event: RunEvent): boolean {
  return (
    event.type === "RunCompleted" ||
    event.type === "RunCanceled" ||
    event.type === "RunFailed"
  );
}

function cloneMessage(message: TranscriptMessage): TranscriptMessage {
  return structuredClone(message);
}

/** AI SDK UIMessage-compatible view; domain parts stay available in transcript storage. */
export interface UIMessageView {
  id: string;
  role: "assistant";
  parts: Array<Record<string, unknown>>;
  metadata: {
    runId: string;
    participantId?: string;
    status: RunStatus;
    usage?: TranscriptMessage["usage"];
  };
}

export function toUIMessage(message: TranscriptMessage): UIMessageView {
  const toolNames = new Map(
    message.parts
      .filter(
        (part): part is Extract<TranscriptPart, { type: "tool-call" }> =>
          part.type === "tool-call",
      )
      .map((part) => [part.invocationId, part.name]),
  );
  const parts = message.parts.map((part): Record<string, unknown> => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "reasoning":
        return { type: "reasoning", text: part.text };
      case "source":
        return {
          type: "source-url",
          sourceId: part.url,
          url: part.url,
          ...(part.title ? { title: part.title } : {}),
        };
      case "tool-call":
        return {
          type: `tool-${part.name}`,
          toolCallId: part.invocationId,
          state: "input-available",
          input: part.input,
        };
      case "tool-result":
        return {
          type: `tool-${toolNames.get(part.invocationId) ?? "unknown"}`,
          toolCallId: part.invocationId,
          state: "output-available",
          output: part.output,
        };
      case "media":
        return {
          type: "data-media-reference",
          id: part.mediaId,
          data: { mediaId: part.mediaId, mediaType: part.mediaType },
        };
    }
  });
  return {
    id: message.id,
    role: "assistant",
    parts,
    metadata: {
      runId: message.runId,
      ...(message.participantId
        ? { participantId: message.participantId }
        : {}),
      status: message.status,
      ...(message.usage ? { usage: { ...message.usage } } : {}),
    },
  };
}

/** App-facing event transport facade; adapt its UIMessage stream to the SDK's chunk protocol. */
export interface ProjectionChatTransport {
  sendMessages(options: {
    events: AsyncIterable<RunEvent>;
    signal: AbortSignal;
  }): ReadableStream<UIMessageView>;
  reconnectToStream(options: {
    snapshot: ProjectionSnapshot;
  }): ReadableStream<UIMessageView>;
}

export function createChatTransport(): ProjectionChatTransport {
  return {
    sendMessages({ events, signal }) {
      const projection = new RunEventProjection();
      const iterator = events[Symbol.asyncIterator]();
      return new ReadableStream<UIMessageView>({
        async start(controller) {
          let aborted = false;
          const onAbort = () => {
            aborted = true;
            for (const message of projection.cancelActive("Stopped by user"))
              controller.enqueue(toUIMessage(message));
            void iterator.return?.();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            while (!aborted && !signal.aborted) {
              const next = await iterator.next();
              if (next.done || aborted) break;
              const event = next.value;
              if (projection.apply(event) === "applied") {
                const message = projection.getMessage(event.runId);
                if (message) controller.enqueue(toUIMessage(message));
              }
            }
            controller.close();
          } catch (error) {
            if (!aborted) controller.error(error);
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        },
        async cancel() {
          await iterator.return?.();
        },
      });
    },
    reconnectToStream({ snapshot }) {
      const projection = new RunEventProjection(snapshot);
      return new ReadableStream<UIMessageView>({
        start(controller) {
          for (const message of projection.getMessages())
            controller.enqueue(toUIMessage(message));
          controller.close();
        },
      });
    },
  };
}
