import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export interface HistoryConversation {
  id: string;
  title: string | null;
  modelId: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResponseVariant {
  id: string;
  messageId: string;
  generation: number;
  content: readonly unknown[];
  modelId: string;
  createdAt: string;
}

export interface ServerContinuation {
  messageId: string;
  providerId: string;
  modelId: string;
  handle: string;
  contextFingerprint: string;
  stale: boolean;
  updatedAt: string;
}

/** Tables are additive and independent of provider-specific continuation formats. */
export async function initializeChatHistory(
  db: SQLiteDatabasePort,
): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS chat_history_allocations (
      allocation_key TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_history_metadata (
      conversation_id TEXT PRIMARY KEY NOT NULL,
      model_id TEXT,
      last_used_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS response_variants (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      content_json TEXT NOT NULL CHECK (json_valid(content_json)),
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1)),
      UNIQUE (message_id, generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS response_variant_selected
      ON response_variants(message_id) WHERE selected = 1;
    CREATE TABLE IF NOT EXISTS server_continuations (
      message_id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      context_fingerprint TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
      updated_at TEXT NOT NULL
    );
  `);
}

type ConversationRow = {
  id: string;
  title: string | null;
  model_id: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};
function conversation(row: ConversationRow): HistoryConversation {
  return {
    id: row.id,
    title: row.title,
    modelId: row.model_id,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Idempotency key must be stable for one New Chat action across retries. */
export class SQLiteChatHistory {
  constructor(private readonly db: SQLiteDatabasePort) {}

  async allocateConversation(input: {
    allocationKey: string;
    id: string;
    now: string;
    title?: string | null;
  }): Promise<{ conversation: HistoryConversation; created: boolean }> {
    let result:
      | { conversation: HistoryConversation; created: boolean }
      | undefined;
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      const prior = await scopedDb.getFirstAsync<{ conversation_id: string }>(
        "SELECT conversation_id FROM chat_history_allocations WHERE allocation_key = ?",
        input.allocationKey,
      );
      if (prior) {
        const row = await scopedDb.getFirstAsync<ConversationRow>(
          `SELECT c.id,c.title,m.model_id,m.last_used_at,c.created_at,c.updated_at
           FROM conversations c LEFT JOIN chat_history_metadata m ON m.conversation_id=c.id WHERE c.id=?`,
          prior.conversation_id,
        );
        if (!row) throw new Error("Allocated conversation is missing");
        result = { conversation: conversation(row), created: false };
        return;
      }
      await scopedDb.runAsync(
        "INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)",
        input.id,
        input.title ?? null,
        input.now,
        input.now,
      );
      await scopedDb.runAsync(
        "INSERT INTO chat_history_allocations (allocation_key,conversation_id,created_at) VALUES (?,?,?)",
        input.allocationKey,
        input.id,
        input.now,
      );
      await scopedDb.runAsync(
        "INSERT INTO chat_history_metadata (conversation_id) VALUES (?)",
        input.id,
      );
      result = {
        conversation: {
          id: input.id,
          title: input.title ?? null,
          modelId: null,
          lastUsedAt: null,
          createdAt: input.now,
          updatedAt: input.now,
        },
        created: true,
      };
    });
    if (!result) throw new Error("Conversation allocation returned no result");
    return result;
  }

  async getConversation(id: string): Promise<HistoryConversation | undefined> {
    const row = await this.db.getFirstAsync<ConversationRow>(
      `SELECT c.id,c.title,m.model_id,m.last_used_at,c.created_at,c.updated_at
       FROM conversations c LEFT JOIN chat_history_metadata m ON m.conversation_id=c.id WHERE c.id=?`,
      id,
    );
    return row ? conversation(row) : undefined;
  }

  async recordModelUse(
    conversationId: string,
    modelId: string,
    usedAt: string,
  ): Promise<void> {
    await this.db.runAsync(
      `UPDATE chat_history_metadata SET model_id=?,last_used_at=? WHERE conversation_id=?`,
      modelId,
      usedAt,
      conversationId,
    );
    await this.db.runAsync(
      "UPDATE conversations SET updated_at=? WHERE id=?",
      usedAt,
      conversationId,
    );
  }

  /** First generation starts selected; regeneration appends a variant without mutating prior content. */
  async addVariant(input: {
    id: string;
    messageId: string;
    modelId: string;
    content: readonly unknown[];
    createdAt: string;
  }): Promise<ResponseVariant> {
    let variant!: ResponseVariant;
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      const row = await scopedDb.getFirstAsync<{ generation: number }>(
        "SELECT COALESCE(MAX(generation),-1)+1 AS generation FROM response_variants WHERE message_id=?",
        input.messageId,
      );
      const generation = row?.generation ?? 0;
      await scopedDb.runAsync(
        "INSERT INTO response_variants (id,message_id,generation,content_json,model_id,created_at,selected) VALUES (?,?,?,?,?,?,?)",
        input.id,
        input.messageId,
        generation,
        JSON.stringify(input.content),
        input.modelId,
        input.createdAt,
        generation === 0 ? 1 : 0,
      );
      variant = {
        id: input.id,
        messageId: input.messageId,
        generation,
        content: structuredClone(input.content),
        modelId: input.modelId,
        createdAt: input.createdAt,
      };
    });
    return variant;
  }

  async selectVariant(messageId: string, variantId: string): Promise<void> {
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      const target = await scopedDb.getFirstAsync<{ id: string }>(
        "SELECT id FROM response_variants WHERE message_id=? AND id=?",
        messageId,
        variantId,
      );
      if (!target)
        throw new Error("Response variant does not belong to message");
      await scopedDb.runAsync(
        "UPDATE response_variants SET selected=0 WHERE message_id=?",
        messageId,
      );
      await scopedDb.runAsync(
        "UPDATE response_variants SET selected=1 WHERE id=?",
        variantId,
      );
    });
  }

  async listVariants(
    messageId: string,
  ): Promise<Array<ResponseVariant & { selected: boolean }>> {
    const rows = await this.db.getAllAsync<{
      id: string;
      message_id: string;
      generation: number;
      content_json: string;
      model_id: string;
      created_at: string;
      selected: number;
    }>(
      "SELECT * FROM response_variants WHERE message_id=? ORDER BY generation",
      messageId,
    );
    return rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      generation: row.generation,
      content: JSON.parse(row.content_json) as unknown[],
      modelId: row.model_id,
      createdAt: row.created_at,
      selected: row.selected === 1,
    }));
  }

  async saveContinuation(
    value: Omit<ServerContinuation, "stale">,
  ): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO server_continuations (message_id,provider_id,model_id,handle,context_fingerprint,stale,updated_at)
      VALUES (?,?,?,?,?,0,?) ON CONFLICT(message_id) DO UPDATE SET provider_id=excluded.provider_id,model_id=excluded.model_id,
      handle=excluded.handle,context_fingerprint=excluded.context_fingerprint,stale=0,updated_at=excluded.updated_at`,
      value.messageId,
      value.providerId,
      value.modelId,
      value.handle,
      value.contextFingerprint,
      value.updatedAt,
    );
  }

  /** A continuation is usable only for the exact provider, model, and context snapshot. */
  async getContinuation(
    messageId: string,
    context: {
      providerId: string;
      modelId: string;
      contextFingerprint: string;
    },
  ): Promise<ServerContinuation | undefined> {
    const row = await this.db.getFirstAsync<{
      message_id: string;
      provider_id: string;
      model_id: string;
      handle: string;
      context_fingerprint: string;
      stale: number;
      updated_at: string;
    }>("SELECT * FROM server_continuations WHERE message_id=?", messageId);
    if (!row) return undefined;
    const stale =
      row.stale === 1 ||
      row.provider_id !== context.providerId ||
      row.model_id !== context.modelId ||
      row.context_fingerprint !== context.contextFingerprint;
    if (stale && row.stale !== 1) await this.invalidateContinuation(messageId);
    return stale
      ? undefined
      : {
          messageId: row.message_id,
          providerId: row.provider_id,
          modelId: row.model_id,
          handle: row.handle,
          contextFingerprint: row.context_fingerprint,
          stale: false,
          updatedAt: row.updated_at,
        };
  }

  async invalidateContinuation(messageId: string): Promise<void> {
    await this.db.runAsync(
      "UPDATE server_continuations SET stale=1 WHERE message_id=?",
      messageId,
    );
  }
}
