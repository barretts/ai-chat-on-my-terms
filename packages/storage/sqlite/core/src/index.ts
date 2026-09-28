export type SqliteBindValue = string | number | null | Uint8Array;

/** Small common subset shared by Expo SQLite and the native test adapter. */
export interface SQLiteDatabasePort {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: SqliteBindValue[]): Promise<unknown>;
  getFirstAsync<T>(
    sql: string,
    ...params: SqliteBindValue[]
  ): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: SqliteBindValue[]): Promise<T[]>;
  /** Native adapters pass a transaction-scoped port; use it for every operation
   * inside the callback. Legacy adapters may omit it and use their own connection. */
  withTransactionAsync(
    work: (transaction?: SQLiteDatabasePort) => Promise<void>,
  ): Promise<void>;
}

export interface LocalConversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalMessage {
  id: string;
  conversationId: string;
  role: "system" | "developer" | "user" | "assistant" | "tool";
  parts: readonly unknown[];
  sequence: number;
  runId: string | null;
  participantId: string | null;
  createdAt: string;
}

export interface NewMessage {
  id: string;
  role: LocalMessage["role"];
  parts: readonly unknown[];
  runId?: string | null;
  participantId?: string | null;
  createdAt?: string;
}

export interface NewConversation {
  id: string;
  title?: string | null;
  createdAt?: string;
}

export interface NewRun {
  id: string;
  modelId: string;
  parameters?: Readonly<Record<string, unknown>>;
  startedAt?: string;
}

type ConversationRow = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: LocalMessage["role"];
  parts_json: string;
  sequence: number;
  run_id: string | null;
  participant_id: string | null;
  created_at: string;
};

function conversationFromRow(row: ConversationRow): LocalConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageFromRow(row: MessageRow): LocalMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    parts: JSON.parse(row.parts_json) as unknown[],
    sequence: row.sequence,
    runId: row.run_id,
    participantId: row.participant_id,
    createdAt: row.created_at,
  };
}

export class CoreSQLiteRepositories {
  constructor(private readonly db: SQLiteDatabasePort) {}

  async createConversation(input: NewConversation): Promise<LocalConversation> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    await this.db.runAsync(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      input.id,
      input.title ?? null,
      createdAt,
      createdAt,
    );
    return {
      id: input.id,
      title: input.title ?? null,
      createdAt,
      updatedAt: createdAt,
    };
  }

  async getConversation(id: string): Promise<LocalConversation | null> {
    const row = await this.db.getFirstAsync<ConversationRow>(
      "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?",
      id,
    );
    return row ? conversationFromRow(row) : null;
  }

  async listMessages(conversationId: string): Promise<LocalMessage[]> {
    const rows = await this.db.getAllAsync<MessageRow>(
      "SELECT id, conversation_id, role, parts_json, sequence, run_id, participant_id, created_at FROM messages WHERE conversation_id = ? ORDER BY sequence",
      conversationId,
    );
    return rows.map(messageFromRow);
  }

  /** Save a user message and queued run together; neither can be half-written. */
  async beginRun(
    conversationId: string,
    run: NewRun,
    userMessage: NewMessage,
  ): Promise<void> {
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      const timestamp = userMessage.createdAt ?? new Date().toISOString();
      const sequence = await this.nextSequence(conversationId, scopedDb);
      await scopedDb.runAsync(
        "INSERT INTO messages (id, conversation_id, role, parts_json, sequence, run_id, participant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        userMessage.id,
        conversationId,
        userMessage.role,
        JSON.stringify(userMessage.parts),
        sequence,
        run.id,
        userMessage.participantId ?? null,
        timestamp,
      );
      await scopedDb.runAsync(
        "INSERT INTO runs (id, conversation_id, model_id, status, parameters_json, started_at) VALUES (?, ?, ?, 'running', ?, ?)",
        run.id,
        conversationId,
        run.modelId,
        JSON.stringify(run.parameters ?? {}),
        run.startedAt ?? timestamp,
      );
      await scopedDb.runAsync(
        "UPDATE conversations SET updated_at = ? WHERE id = ?",
        timestamp,
        conversationId,
      );
    });
  }

  /** Insert final assistant content and complete the run atomically. */
  async completeRun(
    runId: string,
    assistantMessage: NewMessage,
  ): Promise<void> {
    if (assistantMessage.role !== "assistant") {
      throw new Error("A completed run requires an assistant message");
    }
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      const run = await scopedDb.getFirstAsync<{
        conversation_id: string;
        status: string;
      }>("SELECT conversation_id, status FROM runs WHERE id = ?", runId);
      if (!run || run.status !== "running") {
        throw new Error("Run is missing or is not running");
      }
      if (assistantMessage.parts.length === 0) {
        throw new Error("A completed run requires persisted assistant content");
      }
      const timestamp = assistantMessage.createdAt ?? new Date().toISOString();
      const sequence = await this.nextSequence(run.conversation_id, scopedDb);
      await scopedDb.runAsync(
        "INSERT INTO messages (id, conversation_id, role, parts_json, sequence, run_id, participant_id, created_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)",
        assistantMessage.id,
        run.conversation_id,
        JSON.stringify(assistantMessage.parts),
        sequence,
        runId,
        assistantMessage.participantId ?? null,
        timestamp,
      );
      await scopedDb.runAsync(
        "UPDATE runs SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'running'",
        timestamp,
        runId,
      );
      await scopedDb.runAsync(
        "UPDATE conversations SET updated_at = ? WHERE id = ?",
        timestamp,
        run.conversation_id,
      );
    });
  }

  async interruptRun(runId: string): Promise<void> {
    await this.db.runAsync(
      "UPDATE runs SET status = 'canceled', finished_at = ? WHERE id = ? AND status = 'running'",
      new Date().toISOString(),
      runId,
    );
  }

  private async nextSequence(
    conversationId: string,
    db = this.db,
  ): Promise<number> {
    const row = await db.getFirstAsync<{ next_sequence: number }>(
      "SELECT COALESCE(MAX(sequence) + 1, 0) AS next_sequence FROM messages WHERE conversation_id = ?",
      conversationId,
    );
    return row?.next_sequence ?? 0;
  }
}
