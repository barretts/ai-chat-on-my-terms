import { migrateEmbeddedSQLite } from "@locallab/schema/embedded";
import { sharedMobileDatabase } from "../../platform/database";
import { mobileMigrationDatabase } from "../../platform/migrations";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent } from "@locallab/contracts/run-events";
import { ChatEngine } from "@locallab/chat-engine-core";
import { SQLiteChatHistory } from "@locallab/chat-history";
import { initializeChatHistory } from "@locallab/chat-history";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type {
  AssistantTranscriptPart,
  AssistantTranscriptMessage,
  UserTranscriptMessage,
} from "../../features/transcript/core";

export type FirstRunMode = "local" | "openai";

/** Stored model IDs include the runtime scheme; blob readers accept only the bare UUID. */
export function managedBlobIdFromModelId(
  modelId: string | null | undefined,
): string {
  return modelId?.startsWith("blob:") ? modelId.slice(5) : (modelId ?? "");
}
export interface StoredChatRow {
  id: string;
  role: string;
  parts_json: string;
  sequence: number;
  run_id: string | null;
}

/** Apply the versioned embedded schema before opening any feature store. */
export async function initializeFirstRunChat(database: SQLiteDatabasePort) {
  const db = sharedMobileDatabase(database);
  await migrateEmbeddedSQLite(mobileMigrationDatabase(db));
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS first_run_chat_settings (
      mode TEXT PRIMARY KEY NOT NULL CHECK (mode IN ('local', 'openai')),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      model_record_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
      connection_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS first_run_chat_settings_conversation ON first_run_chat_settings(conversation_id);
  `);
  const history = new SQLiteChatHistory(db);
  await initializeChatHistory(db);
  return history;
}

export async function allocateChatConversation(
  history: SQLiteChatHistory,
  mode: FirstRunMode,
  createId: () => string,
) {
  return history.allocateConversation({
    allocationKey: `first-run-chat:${mode}:v1`,
    id: createId(),
    now: new Date().toISOString(),
    title: mode === "local" ? "Offline chat" : "OpenAI chat",
  });
}

export function createFirstRunChatEngine(db: SQLiteDatabasePort) {
  return new ChatEngine({ db });
}

export function createProviderBinding(input: {
  connectionId: string;
  providerId: string;
  modelRecordId: string;
  modelId: string;
  port: ProviderPort<any>;
}) {
  return {
    providerConnectionId: input.connectionId,
    providerId: input.providerId,
    modelRecordId: input.modelRecordId,
    modelId: input.modelId,
    port: input.port,
  } as const;
}

/** Rebuild display rows from durable SQLite messages plus the engine event projection. */
export async function readTranscript(
  db: SQLiteDatabasePort,
  engine: Pick<ChatEngine, "getProjection">,
  conversationId: string,
): Promise<{
  users: UserTranscriptMessage[];
  assistants: AssistantTranscriptMessage[];
}> {
  const rows = await db.getAllAsync<
    StoredChatRow & {
      selected_parts_json: string | null;
      run_status: string | null;
    }
  >(
    `SELECT m.id,m.role,m.parts_json,m.sequence,m.run_id,
      v.content_json AS selected_parts_json,r.status AS run_status
     FROM messages m
     LEFT JOIN response_variants v ON v.message_id=m.id AND v.selected=1
     LEFT JOIN runs r ON r.id=m.run_id
     WHERE m.conversation_id=? ORDER BY m.sequence`,
    conversationId,
  );
  const users = rows.flatMap((row) => {
    if (row.role !== "user") return [];
    const parts = JSON.parse(row.parts_json) as Array<{
      type?: string;
      text?: string;
    }>;
    return [
      {
        id: row.id,
        role: "user" as const,
        text: parts
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join(""),
        order: row.sequence,
      },
    ];
  });
  const snapshot = await engine.getProjection(conversationId);
  const projected = new Map(
    snapshot.messages.map((message) => [message.runId, message]),
  );
  const assistants: AssistantTranscriptMessage[] = rows.flatMap((row) => {
    if (row.role !== "assistant") return [];
    const message = row.run_id ? projected.get(row.run_id) : undefined;
    if (message) {
      // A running projection owns live deltas; selected saved content applies once the response is terminal.
      return [
        {
          ...message,
          id: row.id,
          order: row.sequence,
          ...(row.selected_parts_json && message.status !== "running"
            ? { parts: storedAssistantParts(row.selected_parts_json) }
            : {}),
        },
      ];
    }
    const status: AssistantTranscriptMessage["status"] =
      row.run_status === "running"
        ? "running"
        : row.run_status === "canceled"
          ? "canceled"
          : row.run_status === "failed"
            ? "failed"
            : row.run_status === "queued"
              ? "idle"
              : "completed";
    return [
      {
        id: row.id,
        role: "assistant",
        runId: row.run_id ?? row.id,
        order: row.sequence,
        status,
        parts: storedAssistantParts(row.selected_parts_json ?? row.parts_json),
      },
    ];
  });
  return { users, assistants };
}

/** Imported rows have durable parts without an event log; admit only parts understood by the renderer. */
function storedAssistantParts(json: string): AssistantTranscriptPart[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) return [];
  const parts: AssistantTranscriptPart[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const part = item as Record<string, unknown>;
    if (
      (part.type === "text" || part.type === "reasoning") &&
      typeof part.text === "string"
    )
      parts.push({ type: part.type, text: part.text });
    else if (
      part.type === "tool-call" &&
      typeof part.invocationId === "string" &&
      typeof part.name === "string"
    )
      parts.push({
        type: "tool-call",
        invocationId: part.invocationId,
        name: part.name,
        input: part.input,
      });
    else if (
      part.type === "tool-result" &&
      typeof part.invocationId === "string"
    )
      parts.push({
        type: "tool-result",
        invocationId: part.invocationId,
        output: part.output,
      });
    else if (part.type === "source" && typeof part.url === "string")
      parts.push({
        type: "source",
        url: part.url,
        ...(typeof part.title === "string" ? { title: part.title } : {}),
      });
    else if (
      part.type === "media" &&
      typeof part.mediaId === "string" &&
      typeof part.mediaType === "string"
    )
      parts.push({
        type: "media",
        mediaId: part.mediaId,
        mediaType: part.mediaType,
      });
  }
  return parts;
}

export async function consumeRun(
  events: AsyncIterable<RunEvent>,
  onEvent: (event: RunEvent) => void,
) {
  for await (const event of events) onEvent(event);
}

export function createChatId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const now = Date.now();
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Never expose transport exception bodies because they may include request details. */
export function recoverableChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/key|unauthorized|401|403/i.test(message))
    return "OpenAI rejected the saved key. Update it in OpenAI setup and try again.";
  if (/network|offline|fetch|timeout|connection/i.test(message))
    return "The request could not reach its endpoint. Check connectivity and retry.";
  return "The response could not be completed. Your message is saved; retry when ready.";
}
