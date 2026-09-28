import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  ChatEngine,
  type ChatBinding,
  type ChatRunHandle,
  type ChatGenerationOwner,
  type SendInput,
} from "@locallab/chat-engine-core";
import {
  packContext,
  type ContextMessage,
  type ContextPolicy,
} from "@locallab/context";
import {
  initializeChatHistory,
  SQLiteChatHistory,
} from "@locallab/chat-history";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export interface AdvancedContextOptions {
  /** Total model window, including reserved output tokens. */
  readonly tokenBudget: number;
  readonly reservedOutputTokens: number;
  readonly policy: ContextPolicy;
  readonly countTokens?: (messages: readonly ContextMessage[]) => number;
  readonly summarize?: (
    messages: readonly ContextMessage[],
    signal?: AbortSignal,
  ) => Promise<string>;
}

export interface AdvancedChatEngineOptions {
  readonly db: SQLiteDatabasePort;
  readonly context: AdvancedContextOptions;
  /** Resolves the saved per-conversation model when send has no explicit binding. */
  readonly resolveBinding?: (
    conversationId: string,
    savedModelRecordId: string | null | undefined,
  ) => Promise<ChatBinding>;
  readonly generateTitle?: (
    firstUserText: string,
  ) => Promise<string | undefined>;
  readonly createId?: () => string;
  readonly now?: () => string;
  readonly generationOwner?: ChatGenerationOwner;
  /** Expand managed attachment references for context without changing stored user content. */
  readonly resolveContextParts?: (
    parts: readonly import("@locallab/context").ContextPart[],
  ) => Promise<readonly import("@locallab/context").ContextPart[]>;
  readonly resolveProviderContext?: (
    message: ContextMessage,
  ) => Promise<RunRequest["context"]>;
}

export interface AdvancedSendInput extends Omit<SendInput, "binding"> {
  readonly binding?: ChatBinding;
  readonly contextParts?: readonly import("@locallab/context").ContextPart[];
  readonly pendingContext?: RunRequest["context"];
  readonly systemPrompt?: string;
}

export interface ContextUsageSnapshot {
  readonly inputTokens: number;
  readonly tokenBudget: number;
  readonly reservedOutputTokens: number;
  readonly omittedMessageIds: readonly string[];
  readonly compactedMessageIds: readonly string[];
}

export interface AdvancedChatRunHandle extends ChatRunHandle {
  readonly contextUsage: ContextUsageSnapshot;
}

/** Adds conversation settings, bounded context construction, first-turn titles, and safe continuation retry. */
export class AdvancedChatEngine {
  private readonly history: SQLiteChatHistory;
  private readonly core: ChatEngine;
  private initialized?: Promise<void>;

  constructor(private readonly options: AdvancedChatEngineOptions) {
    this.history = new SQLiteChatHistory(options.db);
    this.core = new ChatEngine(options);
  }

  async send(input: AdvancedSendInput): Promise<AdvancedChatRunHandle> {
    return this.execute(input);
  }

  async regenerate(
    input: Omit<AdvancedSendInput, "text"> & { userMessageId: string },
  ): Promise<AdvancedChatRunHandle> {
    await this.ensureInitialized();
    const row = await this.options.db.getFirstAsync<{
      parts_json: string;
      sequence: number;
    }>(
      "SELECT parts_json,sequence FROM messages WHERE id=? AND conversation_id=? AND role='user'",
      input.userMessageId,
      input.conversationId,
    );
    if (!row) throw new Error("Original user message is unavailable");
    const parts = JSON.parse(
      row.parts_json,
    ) as import("@locallab/context").ContextPart[];
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    return this.execute(
      { ...input, text, userParts: parts },
      input.userMessageId,
      row.sequence,
    );
  }

  private async execute(
    input: AdvancedSendInput,
    userMessageId?: string,
    beforeSequence?: number,
  ): Promise<AdvancedChatRunHandle> {
    await this.ensureInitialized();
    const conversation = await this.history.getConversation(
      input.conversationId,
    );
    if (!conversation) throw new Error("Conversation does not exist");
    const binding =
      input.binding ??
      (await this.resolveSavedBinding(
        input.conversationId,
        conversation.modelId,
      ));
    await this.history.recordModelUse(
      input.conversationId,
      binding.modelRecordId,
      this.now(),
    );
    const packed = await this.buildContext(input, beforeSequence);
    const port = retryingPort(binding.port);
    const coreInput = {
      ...input,
      binding: {
        ...binding,
        port: contextualPort(
          port,
          packed.messages,
          input.pendingContext,
          this.options.resolveProviderContext,
        ),
      },
    };
    const run = userMessageId
      ? await this.core.regenerate({ ...coreInput, userMessageId })
      : await this.core.send(coreInput);
    if (!userMessageId) await this.maybeTitle(input);
    return {
      ...run,
      contextUsage: {
        inputTokens: packed.estimatedInputTokens,
        tokenBudget: packed.tokenBudget,
        reservedOutputTokens: packed.outputReservation,
        omittedMessageIds: packed.omittedMessageIds,
        compactedMessageIds: packed.compactedMessageIds,
      },
    };
  }

  getProjection(conversationId: string) {
    return this.core.getProjection(conversationId);
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= initializeChatHistory(this.options.db);
    await this.initialized;
  }

  private async resolveSavedBinding(
    conversationId: string,
    modelId: string | null,
  ): Promise<ChatBinding> {
    if (!this.options.resolveBinding)
      throw new Error("A conversation model binding is required");
    return this.options.resolveBinding(conversationId, modelId);
  }

  private async buildContext(
    input: AdvancedSendInput,
    beforeSequence?: number,
  ) {
    const rows = await this.options.db.getAllAsync<{
      id: string;
      role: string;
      parts_json: string;
      run_id: string | null;
    }>(
      "SELECT m.id,m.role,COALESCE(v.content_json,m.parts_json) AS parts_json,m.run_id FROM messages m LEFT JOIN response_variants v ON v.message_id=m.id AND v.selected=1 WHERE m.conversation_id=? AND (? IS NULL OR m.sequence < ?) ORDER BY m.sequence",
      input.conversationId,
      beforeSequence ?? null,
      beforeSequence ?? null,
    );
    const messages: ContextMessage[] = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        role: normalizeRole(row.role),
        parts: this.options.resolveContextParts
          ? await this.options.resolveContextParts(
              JSON.parse(row.parts_json) as ContextMessage["parts"],
            )
          : (JSON.parse(row.parts_json) as ContextMessage["parts"]),
        ...(row.run_id ? { runId: row.run_id } : {}),
      })),
    );
    if (input.systemPrompt?.trim())
      messages.unshift({
        id: "current-system-prompt",
        role: "system",
        parts: [{ type: "text", text: input.systemPrompt }],
      });
    messages.push({
      id: "pending-user-turn",
      role: "user",
      parts: input.contextParts ??
        input.userParts ?? [{ type: "text", text: input.text }],
    });
    return packContext({ ...this.options.context, messages });
  }

  private async maybeTitle(input: AdvancedSendInput): Promise<void> {
    const text = input.text.trim();
    if (!isTitleWorthy(text)) return;
    const generated = this.options.generateTitle
      ? await this.options.generateTitle(text)
      : defaultTitle(text);
    const title = generated?.trim().replace(/\s+/g, " ").slice(0, 100);
    if (!title) return;
    await this.options.db.runAsync(
      "UPDATE conversations SET title=?,updated_at=? WHERE id=? AND (title IS NULL OR trim(title)='')",
      title,
      this.now(),
      input.conversationId,
    );
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }
}

function contextualPort(
  port: ProviderPort,
  messages: readonly ContextMessage[],
  pendingContext?: RunRequest["context"],
  resolveProviderContext?: AdvancedChatEngineOptions["resolveProviderContext"],
): ProviderPort {
  const context = messages.flatMap((message) =>
    message.id === "pending-user-turn" && pendingContext
      ? [...pendingContext]
      : [
          {
            kind: message.role,
            value: message.parts
              .filter(
                (part) => part.type === "text" && typeof part.text === "string",
              )
              .map((part) => part.text)
              .join("\n"),
          },
        ],
  );
  return {
    listModels: (...args) => port.listModels(...args),
    getCapabilities: (...args) => port.getCapabilities(...args),
    dispose: () => port.dispose?.(),
    async *startRun(request, signal) {
      const resolved = resolveProviderContext
        ? (
            await Promise.all(
              messages.map((message) =>
                message.id === "pending-user-turn" && pendingContext
                  ? Promise.resolve(pendingContext)
                  : resolveProviderContext(message),
              ),
            )
          ).flat()
        : context;
      yield* port.startRun({ ...request, context: resolved }, signal);
    },
  };
}

function retryingPort(port: ProviderPort): ProviderPort {
  return {
    listModels: (...args) => port.listModels(...args),
    getCapabilities: (...args) => port.getCapabilities(...args),
    dispose: () => port.dispose?.(),
    startRun: (request, signal) => retryAbruptRun(port, request, signal),
  };
}

/** Retry exactly once, only before a tool call, and continue from emitted partial text. */
async function* retryAbruptRun(
  port: ProviderPort,
  request: RunRequest,
  signal: AbortSignal,
): AsyncIterable<RunEvent> {
  let sequence = 0;
  let toolUsed = false;
  let partial = "";
  let firstTerminal: RunEvent | undefined;
  let caught: unknown;
  try {
    for await (const event of port.startRun(request, signal)) {
      if (signal.aborted) return;
      if (event.type === "ToolCall" || event.type === "ToolResult")
        toolUsed = true;
      if (event.type === "TextDelta") partial += event.text;
      if (event.type === "RunCompleted" && isAbruptFinish(event.finishReason)) {
        firstTerminal = event;
        break;
      }
      if (isTerminal(event)) {
        firstTerminal = event;
        break;
      }
      yield { ...event, sequence: sequence++ } as RunEvent;
    }
  } catch (error) {
    caught = error;
  }

  const abrupt =
    !firstTerminal ||
    (firstTerminal.type === "RunCompleted" &&
      isAbruptFinish(firstTerminal.finishReason));
  if (!signal.aborted && abrupt && !toolUsed) {
    const continuation = withContinuation(request, partial);
    try {
      for await (const event of port.startRun(continuation, signal)) {
        if (signal.aborted) return;
        if (event.type === "RunStarted") continue;
        if (event.type === "ToolCall" || event.type === "ToolResult")
          toolUsed = true;
        yield { ...event, sequence: sequence++ } as RunEvent;
        if (isTerminal(event)) return;
      }
      return;
    } catch (error) {
      throw error;
    }
  }
  if (firstTerminal)
    yield { ...firstTerminal, sequence: sequence++ } as RunEvent;
  else if (caught) throw caught;
}

function withContinuation(request: RunRequest, partial: string): RunRequest {
  return {
    ...request,
    context: [
      ...request.context,
      ...(partial ? [{ kind: "assistant", value: partial }] : []),
      {
        kind: "user",
        value:
          "Continue the response from where it stopped. Do not repeat the preceding text.",
      },
    ],
  };
}

function isTerminal(event: RunEvent): boolean {
  return (
    event.type === "RunCompleted" ||
    event.type === "RunCanceled" ||
    event.type === "RunFailed"
  );
}
function isAbruptFinish(reason: string | undefined): boolean {
  return (
    !!reason &&
    /length|max[_ -]?tokens|token[_ -]?limit|incomplete/i.test(reason)
  );
}
function normalizeRole(role: string): ContextMessage["role"] {
  return role === "system" ||
    role === "developer" ||
    role === "assistant" ||
    role === "tool"
    ? role
    : "user";
}
function isTitleWorthy(text: string): boolean {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return (
    words.length >= 3 &&
    !/^(hi|hello|hey|thanks|thank you|ok|okay|yo)[!.?\s]*$/i.test(text)
  );
}
function defaultTitle(text: string): string {
  const sentence = text.split(/[\r\n.!?]/, 1)[0]?.trim() ?? text;
  return sentence.length > 80
    ? `${sentence.slice(0, 77).trimEnd()}…`
    : sentence;
}
