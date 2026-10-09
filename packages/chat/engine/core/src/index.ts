import type { ProviderPort } from "@locallab/contracts/ports";
import {
  RunEventSchema,
  RunRequestSchema,
} from "@locallab/contracts/run-events";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import {
  localFailureCause,
  retainLocalFailureCause,
} from "@locallab/contracts/local-failure-details";
import {
  RunEventProjection,
  type ProjectionSnapshot,
  type TranscriptMessage,
} from "@locallab/chat-projection";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export interface ChatBinding {
  readonly providerConnectionId: string;
  readonly providerId: string;
  /** ID of the local models table row, used for its FK. */
  readonly modelRecordId: string;
  /** Exact model identifier understood by the provider. */
  readonly modelId: string;
  readonly port: ProviderPort;
}

export interface SendInput {
  conversationId: string;
  text: string;
  /** Original text and managed attachment references; never encoded image bytes. */
  userParts?: readonly {
    type: string;
    text?: string;
    [key: string]: unknown;
  }[];
  binding: ChatBinding;
  parameters?: Readonly<Record<string, unknown>>;
  permittedTools?: readonly string[];
  attachmentRefs?: readonly string[];
  reasoning?: boolean;
  json?: boolean;
}

export interface ChatRunHandle {
  readonly runId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly events: AsyncIterable<RunEvent>;
  stop(reason?: string): Promise<void>;
}

export interface ChatEngineOptions {
  readonly db: SQLiteDatabasePort;
  readonly createId?: () => string;
  readonly now?: () => string;
  /** App session holding a platform lease; used only for durable interruption recovery. */
  readonly generationOwner?: ChatGenerationOwner;
}

export interface ChatGenerationOwner {
  readonly id: string;
  readonly scope: "mobile-chat";
  readonly platform: "native" | "web";
}

type StoredBinding = Pick<
  ChatBinding,
  "providerConnectionId" | "providerId" | "modelRecordId" | "modelId"
>;
interface ActiveRun {
  readonly controller: AbortController;
  readonly assistantMessageId: string;
  cancellation: Promise<RunEvent> | undefined;
}
/** Durable send/stream/stop orchestration over the shared SQLite schema. */
export class ChatEngine {
  private readonly active = new Map<string, ActiveRun>();
  private persistenceWork = Promise.resolve();
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(private readonly options: ChatEngineOptions) {
    this.createId = options.createId ?? uuid7;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async send(input: SendInput): Promise<ChatRunHandle> {
    const runId = this.createId();
    const userMessageId = this.createId();
    const assistantMessageId = this.createId();
    const createdAt = this.now();
    const request: RunRequest = RunRequestSchema.parse({
      runId,
      conversationId: input.conversationId,
      messageId: assistantMessageId,
      providerConnectionId: input.binding.providerConnectionId,
      modelId: input.binding.modelId,
      context: [{ kind: "text", value: input.text }],
      parameters: safeParameters(input.parameters ?? {}),
      permittedTools: [...(input.permittedTools ?? [])],
      attachmentRefs: [...(input.attachmentRefs ?? [])],
      reasoning: input.reasoning ?? false,
      json: input.json ?? false,
    });
    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      assistantMessageId,
      cancellation: undefined,
    };
    this.active.set(runId, active);
    try {
      await this.begin(input, {
        runId,
        userMessageId,
        assistantMessageId,
        createdAt,
      });
    } catch (error) {
      this.active.delete(runId);
      throw error;
    }
    const events = this.durableEvents({
      input,
      request,
      runId,
      userMessageId,
      assistantMessageId,
      createdAt,
      controller,
      active,
    });
    return {
      runId,
      userMessageId,
      assistantMessageId,
      events,
      stop: async (reason = "Stopped by user") => {
        await this.stop(runId, reason);
      },
    };
  }

  /** Regeneration reuses the original user row while creating a new run and response variant. */
  async regenerate(
    input: Omit<SendInput, "text"> & { userMessageId: string },
  ): Promise<ChatRunHandle> {
    const row = await this.options.db.getFirstAsync<{
      parts_json: string;
      role: string;
      conversation_id: string;
    }>(
      "SELECT parts_json, role, conversation_id FROM messages WHERE id = ?",
      input.userMessageId,
    );
    if (
      !row ||
      row.role !== "user" ||
      row.conversation_id !== input.conversationId
    )
      throw new Error("Original user message is unavailable");
    const parts = JSON.parse(row.parts_json) as Array<{
      type?: string;
      text?: string;
    }>;
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    return this.startExistingUser({ ...input, text }, text);
  }

  async stop(runId: string, reason?: string): Promise<boolean> {
    const active = this.active.get(runId);
    if (!active) return false;
    if (active.cancellation) {
      await active.cancellation;
      return false;
    }
    active.controller.abort(
      new DOMException(reason ?? "Stopped by user", "AbortError"),
    );
    active.cancellation = this.cancelPersistedRun(
      runId,
      active.assistantMessageId,
    );
    const terminal = await active.cancellation;
    this.active.delete(runId);
    return terminal.type === "RunCanceled";
  }

  async getProjection(conversationId: string): Promise<ProjectionSnapshot> {
    const rows = await this.options.db.getAllAsync<{ parameters_json: string }>(
      "SELECT parameters_json FROM runs WHERE conversation_id = ? ORDER BY created_at, id",
      conversationId,
    );
    const projection = new RunEventProjection();
    for (const row of rows) {
      const persisted = JSON.parse(row.parameters_json) as {
        events?: RunEvent[];
      };
      for (const event of persisted.events ?? []) projection.apply(event);
    }
    return projection.snapshot();
  }

  private async startExistingUser(
    input: SendInput & { userMessageId: string },
    text: string,
  ): Promise<ChatRunHandle> {
    const runId = this.createId();
    const assistantMessageId = this.createId();
    const createdAt = this.now();
    const request: RunRequest = RunRequestSchema.parse({
      runId,
      conversationId: input.conversationId,
      messageId: assistantMessageId,
      providerConnectionId: input.binding.providerConnectionId,
      modelId: input.binding.modelId,
      context: [{ kind: "text", value: text }],
      parameters: safeParameters(input.parameters ?? {}),
      permittedTools: [...(input.permittedTools ?? [])],
      attachmentRefs: [...(input.attachmentRefs ?? [])],
      reasoning: input.reasoning ?? false,
      json: input.json ?? false,
    });
    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      assistantMessageId,
      cancellation: undefined,
    };
    this.active.set(runId, active);
    try {
      await this.begin(input, {
        runId,
        userMessageId: input.userMessageId,
        assistantMessageId,
        createdAt,
        insertUser: false,
      });
    } catch (error) {
      this.active.delete(runId);
      throw error;
    }
    return {
      runId,
      userMessageId: input.userMessageId,
      assistantMessageId,
      events: this.durableEvents({
        input,
        request,
        runId,
        userMessageId: input.userMessageId,
        assistantMessageId,
        createdAt,
        controller,
        active,
      }),
      stop: async (reason = "Stopped by user") => {
        await this.stop(runId, reason);
      },
    };
  }

  private async begin(
    input: SendInput,
    ids: {
      runId: string;
      userMessageId: string;
      assistantMessageId: string;
      createdAt: string;
      insertUser?: boolean;
    },
  ): Promise<void> {
    const db = this.options.db;
    await this.serializePersistence(() =>
      db.withTransactionAsync(async (transaction) => {
        const scopedDb = transaction ?? db;
        const exists = await scopedDb.getFirstAsync<{ id: string }>(
          "SELECT id FROM conversations WHERE id = ?",
          input.conversationId,
        );
        if (!exists) throw new Error("Conversation does not exist");
        const next = await scopedDb.getFirstAsync<{ n: number }>(
          "SELECT COALESCE(MAX(sequence) + 1, 0) AS n FROM messages WHERE conversation_id = ?",
          input.conversationId,
        );
        let sequence = next?.n ?? 0;
        if (ids.insertUser !== false) {
          await scopedDb.runAsync(
            "INSERT INTO messages (id, conversation_id, role, parts_json, sequence, run_id, created_at) VALUES (?, ?, 'user', ?, ?, ?, ?)",
            ids.userMessageId,
            input.conversationId,
            JSON.stringify(
              input.userParts ?? [{ type: "text", text: input.text }],
            ),
            sequence++,
            ids.runId,
            ids.createdAt,
          );
        }
        await scopedDb.runAsync(
          "INSERT INTO runs (id, conversation_id, model_id, status, parameters_json, started_at) VALUES (?, ?, ?, 'running', ?, ?)",
          ids.runId,
          input.conversationId,
          input.binding.modelRecordId,
          JSON.stringify({
            parameters: safeParameters(input.parameters ?? {}),
            binding: storedBinding(input.binding),
            userMessageId: ids.userMessageId,
            assistantMessageId: ids.assistantMessageId,
            ...(this.options.generationOwner
              ? {
                  generationOwner: {
                    id: this.options.generationOwner.id,
                    scope: this.options.generationOwner.scope,
                    platform: this.options.generationOwner.platform,
                  },
                }
              : {}),
            events: [],
          }),
          ids.createdAt,
        );
        await scopedDb.runAsync(
          "INSERT INTO messages (id, conversation_id, role, parts_json, sequence, run_id, created_at) VALUES (?, ?, 'assistant', '[]', ?, ?, ?)",
          ids.assistantMessageId,
          input.conversationId,
          sequence,
          ids.runId,
          ids.createdAt,
        );
        await scopedDb.runAsync(
          "UPDATE conversations SET updated_at = ? WHERE id = ?",
          ids.createdAt,
          input.conversationId,
        );
      }),
    );
  }

  private durableEvents(args: {
    input: SendInput;
    request: RunRequest;
    runId: string;
    userMessageId: string;
    assistantMessageId: string;
    createdAt: string;
    controller: AbortController;
    active: ActiveRun;
  }): AsyncIterable<RunEvent> {
    const iterator = this.stream(args)[Symbol.asyncIterator]();
    const engine = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => iterator.next(),
          async return(value?: unknown) {
            await engine.stop(args.runId, "Stream consumer closed");
            return iterator.return
              ? iterator.return(value)
              : { done: true as const, value };
          },
          async throw(error?: unknown) {
            await engine.stop(args.runId, "Stream consumer failed");
            if (iterator.throw) return iterator.throw(error);
            throw error;
          },
        };
      },
    };
  }

  private async *stream(args: {
    input: SendInput;
    request: RunRequest;
    runId: string;
    userMessageId: string;
    assistantMessageId: string;
    createdAt: string;
    controller: AbortController;
    active: ActiveRun;
  }): AsyncIterable<RunEvent> {
    const { input, request, runId, assistantMessageId, controller } = args;
    const projection = new RunEventProjection();
    let iterator: AsyncIterator<RunEvent> | undefined;
    let sequence = -1;
    let terminal = false;
    try {
      if (args.active.cancellation) {
        terminal = true;
        yield await args.active.cancellation;
        return;
      }
      iterator = input.binding.port
        .startRun(request, controller.signal)
        [Symbol.asyncIterator]();
      while (!terminal) {
        if (controller.signal.aborted) break;
        let next: IteratorResult<RunEvent>;
        try {
          next = await iterator.next();
        } catch (error) {
          if (controller.signal.aborted) break;
          throw error;
        }
        if (controller.signal.aborted || next.done) break;
        const parsed = RunEventSchema.safeParse(next.value);
        if (
          !parsed.success ||
          parsed.data.runId !== runId ||
          parsed.data.sequence <= sequence ||
          terminal
        )
          throw new Error("Provider emitted an invalid or out-of-order event");
        if (parsed.data.type === "RunFailed" && next.value.type === "RunFailed")
          retainLocalFailureCause(
            parsed.data.error,
            localFailureCause(next.value.error),
          );
        sequence = parsed.data.sequence;
        terminal =
          parsed.data.type === "RunCompleted" ||
          parsed.data.type === "RunCanceled" ||
          parsed.data.type === "RunFailed";
        projection.apply(parsed.data);
        await this.persistProjection(
          runId,
          assistantMessageId,
          projection.getMessage(runId),
          parsed.data,
        );
        yield parsed.data;
      }
      if (!terminal) {
        const event: RunEvent = controller.signal.aborted
          ? await (args.active.cancellation ??
              this.cancelPersistedRun(runId, assistantMessageId))
          : {
              type: "RunFailed",
              runId,
              sequence: sequence + 1,
              timestamp: this.now(),
              error: {
                code: "missing-terminal-event",
                message: "Provider stream ended without a terminal event",
                recoverable: true,
              },
            };
        terminal = true;
        if (!controller.signal.aborted) {
          projection.apply(event);
          await this.persistProjection(
            runId,
            assistantMessageId,
            projection.getMessage(runId),
            event,
          );
        }
        yield event;
      }
    } catch (error) {
      const event: RunEvent = controller.signal.aborted
        ? await (args.active.cancellation ??
            this.cancelPersistedRun(runId, assistantMessageId))
        : {
            type: "RunFailed",
            runId,
            sequence: sequence + 1,
            timestamp: this.now(),
            error: safeProviderFailure(error),
          };
      if (event.type === "RunFailed")
        retainLocalFailureCause(event.error, error);
      terminal = true;
      if (!controller.signal.aborted) {
        projection.apply(event);
        await this.persistProjection(
          runId,
          assistantMessageId,
          projection.getMessage(runId),
          event,
        );
      }
      yield event;
    } finally {
      if (!terminal) await this.stop(runId, "Stream consumer closed");
      try {
        await iterator?.return?.();
      } catch {
        /* provider cleanup is best effort */
      }
      this.active.delete(runId);
    }
  }

  private async persistProjection(
    runId: string,
    assistantMessageId: string,
    message: TranscriptMessage | undefined,
    event: RunEvent,
  ): Promise<void> {
    if (!message) return;
    await this.serializePersistence(() =>
      this.writeProjection(runId, assistantMessageId, message, event),
    );
  }

  private async writeProjection(
    runId: string,
    assistantMessageId: string,
    message: TranscriptMessage,
    event: RunEvent,
  ): Promise<void> {
    const db = this.options.db;
    const finishedAt = this.now();
    await db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? db;
      const run = await scopedDb.getFirstAsync<{
        parameters_json: string;
        status: string;
      }>("SELECT parameters_json,status FROM runs WHERE id = ?", runId);
      if (!run) throw new Error("Run disappeared while persisting its event");
      if (run.status !== "running") return;
      await scopedDb.runAsync(
        "UPDATE messages SET parts_json = ? WHERE id = ? AND run_id = ?",
        JSON.stringify(message.parts),
        assistantMessageId,
        runId,
      );
      const metadata = JSON.parse(run.parameters_json) as {
        events?: RunEvent[];
      };
      await scopedDb.runAsync(
        "UPDATE runs SET parameters_json = ? WHERE id = ? AND status = 'running'",
        JSON.stringify({
          ...metadata,
          events: [...(metadata.events ?? []), event],
        }),
        runId,
      );
      await scopedDb.runAsync(
        "UPDATE runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        message.status,
        message.status === "running" ? null : finishedAt,
        runId,
      );
      await scopedDb.runAsync(
        "UPDATE conversations SET updated_at = ? WHERE id = (SELECT conversation_id FROM runs WHERE id = ?)",
        finishedAt,
        runId,
      );
    });
  }

  private serializePersistence<T>(work: () => Promise<T>): Promise<T> {
    const result = this.persistenceWork.catch(() => {}).then(work);
    this.persistenceWork = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private cancelPersistedRun(
    runId: string,
    assistantMessageId: string,
  ): Promise<RunEvent> {
    return this.serializePersistence(async () => {
      const row = await this.options.db.getFirstAsync<{
        status: string;
        parameters_json: string;
      }>("SELECT status,parameters_json FROM runs WHERE id=?", runId);
      if (!row) throw new Error("Run disappeared while stopping generation");
      const metadata = JSON.parse(row.parameters_json) as {
        events?: RunEvent[];
      };
      const events = metadata.events ?? [];
      const last = events.at(-1);
      if (row.status !== "running" && last && isTerminal(last)) return last;
      if (row.status !== "running")
        throw new Error("A finished run has no terminal event");
      const event: RunEvent = {
        type: "RunCanceled",
        runId,
        sequence: (last?.sequence ?? -1) + 1,
        timestamp: this.now(),
        reason: "Generation stopped",
      };
      const projection = new RunEventProjection();
      for (const saved of events) projection.apply(saved);
      projection.apply(event);
      await this.writeProjection(
        runId,
        assistantMessageId,
        projection.getMessage(runId)!,
        event,
      );
      return event;
    });
  }
}

function isTerminal(event: RunEvent): boolean {
  return (
    event.type === "RunCompleted" ||
    event.type === "RunCanceled" ||
    event.type === "RunFailed"
  );
}

function safeProviderFailure(
  error: unknown,
): Extract<RunEvent, { type: "RunFailed" }>["error"] {
  const value =
    error && typeof error === "object"
      ? (error as { code?: unknown; recoverable?: unknown })
      : {};
  const code = typeof value.code === "string" ? value.code : "provider-error";
  const recoverable =
    typeof value.recoverable === "boolean" ? value.recoverable : true;
  const messages: Record<string, string> = {
    unauthorized:
      "The provider rejected its saved credential. Update provider setup and retry.",
    forbidden:
      "The provider rejected its saved credential. Update provider setup and retry.",
    "missing-model": "Select or import a compatible model, then retry.",
    "host-stopped":
      "The selected runtime stopped. Restart it and retry your saved message.",
    "context-full":
      "This conversation exceeds the model context. Shorten or compact it, then retry.",
    offline:
      "The provider could not be reached. Check the connection and retry.",
    network:
      "The provider could not be reached. Check the connection and retry.",
    timeout: "The provider did not respond in time. Retry when ready.",
    permission:
      "The provider requires permission before generation can continue.",
    unsupported:
      "The selected provider does not support this request. Update chat settings and retry.",
    quota:
      "The provider quota was exceeded. Review provider setup before retrying.",
    malformed:
      "The provider returned an invalid response. Review provider setup and retry.",
  };
  return {
    code:
      code === "forbidden"
        ? "unauthorized"
        : Object.hasOwn(messages, code)
          ? code
          : "provider-error",
    message: messages[code] ?? "The provider could not complete the response",
    recoverable,
  };
}

function storedBinding(binding: ChatBinding): StoredBinding {
  return {
    providerConnectionId: binding.providerConnectionId,
    providerId: binding.providerId,
    modelRecordId: binding.modelRecordId,
    modelId: binding.modelId,
  };
}

function safeParameters(
  parameters: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (
      /(?:api.?key|secret|authorization|credential|password|^(?:access[_-]?|refresh[_-]?)?token$)/i.test(
        key,
      )
    )
      continue;
    if (value && typeof value === "object" && !Array.isArray(value))
      safe[key] = safeParameters(value as Record<string, unknown>);
    else safe[key] = value;
  }
  return safe;
}

function uuid7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = Date.now();
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
