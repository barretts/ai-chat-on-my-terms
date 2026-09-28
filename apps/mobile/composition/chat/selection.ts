import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { FirstRunMode } from "../first-run-chat";

export async function readActiveChat(db: SQLiteDatabasePort) {
  await db.execAsync(`CREATE TABLE IF NOT EXISTS chat_view_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL
  )`);
  const row = await db.getFirstAsync<{ conversation_id: string | null }>(
    "SELECT conversation_id FROM chat_view_state WHERE singleton=1",
  );
  return row?.conversation_id ?? undefined;
}

export async function saveActiveChat(
  db: SQLiteDatabasePort,
  conversationId: string,
) {
  await db.runAsync(
    "INSERT INTO chat_view_state(singleton,conversation_id) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET conversation_id=excluded.conversation_id",
    conversationId,
  );
}

/** Restore the last durable fallback binding, independent of the previously open chat. */
export async function readFallbackChatSelection(
  db: SQLiteDatabasePort,
  conversationId: string,
): Promise<
  | {
      mode: FirstRunMode;
      modelId: string;
      connectionId: string;
    }
  | undefined
> {
  const row = await db.getFirstAsync<{ parameters_json: string }>(
    "SELECT parameters_json FROM runs WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
    conversationId,
  );
  if (!row) return undefined;
  const { binding } = JSON.parse(row.parameters_json) as {
    binding?: Record<string, unknown>;
  };
  if (
    !binding ||
    typeof binding.modelId !== "string" ||
    typeof binding.providerConnectionId !== "string"
  )
    return undefined;
  const mode =
    binding.providerId === "00000000-0000-7000-8000-000000000026" &&
    binding.modelId.startsWith("blob:")
      ? "local"
      : binding.providerId === "00000000-0000-7000-8000-000000000021"
        ? "openai"
        : undefined;
  return mode
    ? {
        mode,
        modelId: binding.modelId,
        connectionId: binding.providerConnectionId,
      }
    : undefined;
}
