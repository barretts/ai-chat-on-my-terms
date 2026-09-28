import type { LocalEmbeddingRuntime } from "@locallab/embeddings";
import { embeddingIdentity, validateEmbedding } from "@locallab/embeddings";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export interface SearchTranscript {
  conversationId: string;
  messageId: string;
  variantId: string;
  role: string;
  text: string;
  active: boolean;
  updatedAt: string;
}
export interface SearchHit extends SearchTranscript {
  score: number;
  mode: "semantic" | "fts";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS semantic_search_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS semantic_search_documents (
  document_key TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  variant_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, active INTEGER NOT NULL,
  updated_at TEXT NOT NULL, vector_json TEXT NOT NULL, identity TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS semantic_search_conversation ON semantic_search_documents(conversation_id);
`;

/** Local-only transcript index. FTS5 is opportunistic; cosine scan is used when available. */
export class SQLiteSemanticSearch {
  private ftsAvailable = false;
  constructor(
    private readonly db: SQLiteDatabasePort,
    private readonly runtime: LocalEmbeddingRuntime,
    private readonly batchSize = 16,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 128)
      throw new RangeError("batchSize must be between 1 and 128");
  }

  async initialize(): Promise<void> {
    await this.db.execAsync(SCHEMA);
    const state = await this.db.getFirstAsync<{ identity: string }>(
      "SELECT identity FROM semantic_search_state WHERE singleton=1",
    );
    const identity = embeddingIdentity(this.runtime);
    if (state?.identity !== identity) {
      await this.db.withTransactionAsync(async (transaction) => {
        const db = transaction ?? this.db;
        await db.runAsync("DELETE FROM semantic_search_documents");
        await db.runAsync("DELETE FROM semantic_search_state");
        await db.runAsync(
          "INSERT INTO semantic_search_state(singleton,identity) VALUES(1,?)",
          identity,
        );
      });
    }
    try {
      await this.db.execAsync(
        "CREATE VIRTUAL TABLE IF NOT EXISTS semantic_search_fts USING fts5(document_key UNINDEXED, text, tokenize='unicode61')",
      );
      this.ftsAvailable = true;
      await this.db.execAsync("DELETE FROM semantic_search_fts");
      const docs = await this.db.getAllAsync<{
        document_key: string;
        text: string;
      }>("SELECT document_key,text FROM semantic_search_documents");
      for (const doc of docs)
        await this.db.runAsync(
          "INSERT INTO semantic_search_fts(document_key,text) VALUES(?,?)",
          doc.document_key,
          doc.text,
        );
    } catch {
      this.ftsAvailable = false;
    }
  }

  /** Replace the caller's current snapshot; deleted messages and superseded variants are purged. */
  async reindex(
    snapshot: readonly SearchTranscript[],
    signal?: AbortSignal,
  ): Promise<void> {
    const identity = embeddingIdentity(this.runtime);
    const keys = snapshot.map(documentKey);
    if (new Set(keys).size !== keys.length)
      throw new Error(
        "Transcript snapshot contains duplicate source references",
      );
    const retained = new Set(keys);
    const existing = await this.db.getAllAsync<{ document_key: string }>(
      "SELECT document_key FROM semantic_search_documents",
    );
    for (const row of existing)
      if (!retained.has(row.document_key)) await this.remove(row.document_key);
    for (let offset = 0; offset < snapshot.length; offset += this.batchSize) {
      if (signal?.aborted)
        throw new DOMException("Indexing canceled", "AbortError");
      const batch = snapshot.slice(offset, offset + this.batchSize);
      const vectors = await this.runtime.embed(
        batch.map((item) => item.text),
        signal,
      );
      if (vectors.length !== batch.length)
        throw new Error("Embedding runtime returned wrong vector count");
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i]!;
        const vector = vectors[i]!;
        validateEmbedding(vector, this.runtime.model.dimensions);
        const key = documentKey(item);
        await this.db.withTransactionAsync(async (transaction) => {
          const db = transaction ?? this.db;
          await db.runAsync(
            "INSERT OR REPLACE INTO semantic_search_documents(document_key,conversation_id,message_id,variant_id,role,text,active,updated_at,vector_json,identity) VALUES(?,?,?,?,?,?,?,?,?,?)",
            key,
            item.conversationId,
            item.messageId,
            item.variantId,
            item.role,
            item.text,
            item.active ? 1 : 0,
            item.updatedAt,
            JSON.stringify(vector),
            identity,
          );
          if (this.ftsAvailable) {
            await db.runAsync(
              "DELETE FROM semantic_search_fts WHERE document_key=?",
              key,
            );
            await db.runAsync(
              "INSERT INTO semantic_search_fts(document_key,text) VALUES(?,?)",
              key,
              item.text,
            );
          }
        });
      }
    }
  }

  async purgeConversation(conversationId: string): Promise<void> {
    const rows = await this.db.getAllAsync<{ document_key: string }>(
      "SELECT document_key FROM semantic_search_documents WHERE conversation_id=?",
      conversationId,
    );
    for (const row of rows) await this.remove(row.document_key);
  }

  async search(
    query: string,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError("limit must be between 1 and 100");
    try {
      const [vector] = await this.runtime.embed([query], signal);
      if (!vector) throw new Error("Embedding runtime returned no vector");
      validateEmbedding(vector, this.runtime.model.dimensions);
      const rows = await this.db.getAllAsync<{
        document_key: string;
        conversation_id: string;
        message_id: string;
        variant_id: string;
        role: string;
        text: string;
        active: number;
        updated_at: string;
        vector_json: string;
      }>(
        "SELECT * FROM semantic_search_documents WHERE identity=?",
        embeddingIdentity(this.runtime),
      );
      const ranked = rows
        .map((row) => ({
          row,
          score: cosine(vector, JSON.parse(row.vector_json) as number[]),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return ranked.map(({ row, score }) => hit(row, score, "semantic"));
    } catch (error) {
      if (signal?.aborted) throw error;
      return this.searchFts(query, limit);
    }
  }

  private async searchFts(query: string, limit: number): Promise<SearchHit[]> {
    if (!this.ftsAvailable) return [];
    try {
      const rows = await this.db.getAllAsync<{
        document_key: string;
        rank: number;
      }>(
        "SELECT document_key,bm25(semantic_search_fts) AS rank FROM semantic_search_fts WHERE semantic_search_fts MATCH ? ORDER BY rank LIMIT ?",
        quoteFts(query),
        limit,
      );
      const out: SearchHit[] = [];
      for (const row of rows) {
        const doc = await this.db.getFirstAsync<{
          document_key: string;
          conversation_id: string;
          message_id: string;
          variant_id: string;
          role: string;
          text: string;
          active: number;
          updated_at: string;
        }>(
          "SELECT * FROM semantic_search_documents WHERE document_key=?",
          row.document_key,
        );
        if (doc) out.push(hit(doc, -row.rank, "fts"));
      }
      return out;
    } catch {
      return [];
    }
  }
  private async remove(key: string): Promise<void> {
    await this.db.withTransactionAsync(async (transaction) => {
      const db = transaction ?? this.db;
      await db.runAsync(
        "DELETE FROM semantic_search_documents WHERE document_key=?",
        key,
      );
      if (this.ftsAvailable)
        await db.runAsync(
          "DELETE FROM semantic_search_fts WHERE document_key=?",
          key,
        );
    });
  }
}

function documentKey(item: SearchTranscript): string {
  return `${item.messageId}\u001f${item.variantId}`;
}
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length) return -1;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function hit(
  row: {
    conversation_id: string;
    message_id: string;
    variant_id: string;
    role: string;
    text: string;
    active: number;
    updated_at: string;
  },
  score: number,
  mode: SearchHit["mode"],
): SearchHit {
  return {
    conversationId: row.conversation_id,
    messageId: row.message_id,
    variantId: row.variant_id,
    role: row.role,
    text: row.text,
    active: row.active === 1,
    updatedAt: row.updated_at,
    score,
    mode,
  };
}
function quoteFts(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(" OR ");
}
