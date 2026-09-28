import assert from "node:assert/strict";
import test from "node:test";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import type { LocalEmbeddingRuntime } from "@locallab/embeddings";
import { SQLiteSemanticSearch, type SearchTranscript } from "../src/index.js";

type Doc = SearchTranscript & {
  key: string;
  vector: number[];
  identity: string;
};
class MemoryDb implements SQLiteDatabasePort {
  docs = new Map<string, Doc>();
  state: string | undefined;
  async execAsync(sql: string): Promise<void> {
    if (sql.includes("VIRTUAL TABLE"))
      throw new Error("FTS unavailable in fixture");
  }
  async runAsync(sql: string, ...p: SqliteBindValue[]): Promise<unknown> {
    if (sql.includes("DELETE FROM semantic_search_documents")) {
      this.docs.clear();
      return;
    }
    if (sql.includes("DELETE FROM semantic_search_state")) {
      this.state = undefined;
      return;
    }
    if (sql.includes("INSERT INTO semantic_search_state")) {
      this.state = String(p[0]);
      return;
    }
    if (sql.includes("INSERT OR REPLACE INTO semantic_search_documents")) {
      const [
        key,
        conversationId,
        messageId,
        variantId,
        role,
        text,
        active,
        updatedAt,
        vector,
        identity,
      ] = p as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        string,
        string,
      ];
      this.docs.set(key, {
        key,
        conversationId,
        messageId,
        variantId,
        role,
        text,
        active: active === 1,
        updatedAt,
        vector: JSON.parse(vector) as number[],
        identity,
      });
      return;
    }
    if (
      sql.includes("DELETE FROM semantic_search_documents WHERE document_key")
    ) {
      this.docs.delete(String(p[0]));
      return;
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  async getFirstAsync<T>(
    sql: string,
    ...p: SqliteBindValue[]
  ): Promise<T | null> {
    if (sql.includes("semantic_search_state"))
      return (this.state ? { identity: this.state } : null) as T | null;
    return null;
  }
  async getAllAsync<T>(sql: string, ...p: SqliteBindValue[]): Promise<T[]> {
    const rows = [...this.docs.values()];
    if (
      sql.includes(
        "SELECT document_key FROM semantic_search_documents WHERE conversation_id",
      )
    )
      return rows
        .filter((x) => x.conversationId === p[0])
        .map((x) => ({ document_key: x.key }) as T);
    if (sql.includes("SELECT document_key FROM semantic_search_documents"))
      return rows.map((x) => ({ document_key: x.key }) as T);
    if (sql.includes("WHERE identity=?"))
      return rows
        .filter((x) => x.identity === p[0])
        .map(
          (x) =>
            ({
              document_key: x.key,
              conversation_id: x.conversationId,
              message_id: x.messageId,
              variant_id: x.variantId,
              role: x.role,
              text: x.text,
              active: x.active ? 1 : 0,
              updated_at: x.updatedAt,
              vector_json: JSON.stringify(x.vector),
            }) as T,
        );
    return [];
  }
  async withTransactionAsync(work: () => Promise<void>): Promise<void> {
    await work();
  }
}
function fixture(
  id = "local-embed",
  revision = "rev1",
  tracker?: { max: number; calls: number },
): LocalEmbeddingRuntime {
  return {
    model: { id, revision, dimensions: 2, local: true, installed: true },
    embed: async (texts) => {
      if (tracker) {
        tracker.max = Math.max(tracker.max, texts.length);
        tracker.calls++;
      }
      return texts.map((text) =>
        text.toLowerCase().includes("cat") ? [1, 0] : [0, 1],
      );
    },
  };
}
const transcript = (
  variantId: string,
  text: string,
  messageId = "m1",
): SearchTranscript => ({
  conversationId: "c1",
  messageId,
  variantId,
  role: "assistant",
  text,
  active: true,
  updatedAt: "2026-01-01",
});

test("indexes bounded batches, returns source-linked variants, and purges stale snapshot results", async () => {
  const db = new MemoryDb();
  const tracker = { max: 0, calls: 0 };
  const search = new SQLiteSemanticSearch(
    db,
    fixture("local-embed", "rev1", tracker),
    2,
  );
  await search.initialize();
  await search.reindex([
    transcript("v1", "a cat answer"),
    transcript("v2", "a dog answer", "m2"),
    transcript("v1", "another cat", "m3"),
  ]);
  assert.equal(tracker.max, 2);
  assert.equal(tracker.calls, 2);
  assert.equal((await search.search("cat"))[0]?.messageId, "m1");
  await search.reindex([
    transcript("v2", "a dog answer", "m2"),
    transcript("v2", "revised cat variant"),
  ]);
  const hits = await search.search("cat");
  assert.deepEqual(
    hits.map((h) => `${h.messageId}:${h.variantId}`),
    ["m1:v2", "m2:v2"],
  );
  assert.equal(db.docs.has("m1\u001fv1"), false);
});

test("purges deleted conversation content and rebuilds vectors after embedding identity changes", async () => {
  const db = new MemoryDb();
  const first = new SQLiteSemanticSearch(db, fixture("model-a", "rev1"));
  await first.initialize();
  await first.reindex([transcript("v1", "a cat answer")]);
  const changed = new SQLiteSemanticSearch(db, fixture("model-a", "rev2"));
  await changed.initialize();
  assert.equal(db.docs.size, 0);
  await changed.reindex([transcript("v3", "a cat answer")]);
  assert.equal(db.docs.size, 1);
  await changed.purgeConversation("c1");
  assert.equal(db.docs.size, 0);
});
