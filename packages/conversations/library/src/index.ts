import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export interface ConversationFolder {
  id: string;
  name: string;
  color: string;
  coverBlobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryConversation {
  id: string;
  title: string | null;
  folderId: string | null;
  modelId: string | null;
  lastUsedAt: string | null;
  /** Set while the conversation is archived (hidden from Recent). */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  snippet?: string;
}

export interface ConversationListOptions {
  /** false (default) lists Recent conversations; true lists only archived ones. */
  archived?: boolean;
}

export interface HistoryConversation extends LibraryConversation {
  /** Latest visible user or assistant text, trimmed for a list row; null when empty. */
  preview: string | null;
}

export interface LibrarySearchResult {
  conversations: LibraryConversation[];
  folders: ConversationFolder[];
  query: string;
  emptyState: "query-no-results" | "library-empty" | null;
}

export interface ConversationLibraryPort {
  listFolders(): Promise<ConversationFolder[]>;
  listConversations(
    folderId?: string | null,
    options?: ConversationListOptions,
  ): Promise<LibraryConversation[]>;
  search(
    query: string,
    folderId?: string | null,
    options?: ConversationListOptions,
  ): Promise<LibrarySearchResult>;
}

/** Recent/archived conversation history with previews; archive is reversible. */
export interface ConversationHistoryPort {
  listHistory(options?: {
    archived?: boolean;
    query?: string;
  }): Promise<HistoryConversation[]>;
  countArchived(): Promise<number>;
  archiveConversation(conversationId: string, now: string): Promise<void>;
  unarchiveConversation(conversationId: string): Promise<void>;
}

/** Additive library tables; conversations and managed assets remain independently owned. */
export async function initializeConversationLibrary(
  db: SQLiteDatabasePort,
): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS conversation_folders (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      color TEXT NOT NULL DEFAULT '#6750A4',
      cover_blob_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS conversation_folder_memberships (
      conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES conversation_folders(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS conversation_folder_memberships_folder
      ON conversation_folder_memberships(folder_id);
    -- Same DDL as schema migration 0008; kept here so the library works on
    -- databases opened before that migration ran (idempotent).
    CREATE TABLE IF NOT EXISTS conversation_archive_state (
      conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      archived_at TEXT NOT NULL
    );
  `);
}

type FolderRow = {
  id: string;
  name: string;
  color: string;
  cover_blob_id: string | null;
  created_at: string;
  updated_at: string;
};
type ConversationRow = {
  id: string;
  title: string | null;
  folder_id: string | null;
  model_id: string | null;
  last_used_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};
const fromFolder = (row: FolderRow): ConversationFolder => ({
  id: row.id,
  name: row.name,
  color: row.color,
  coverBlobId: row.cover_blob_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const fromConversation = (row: ConversationRow): LibraryConversation => ({
  id: row.id,
  title: row.title,
  folderId: row.folder_id,
  modelId: row.model_id,
  lastUsedAt: row.last_used_at,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Local conversation organization and text search; folder deletion is a sync-ready tombstone. */
export class SQLiteConversationLibrary
  implements ConversationLibraryPort, ConversationHistoryPort
{
  constructor(private readonly db: SQLiteDatabasePort) {}

  async createFolder(input: {
    id: string;
    name: string;
    now: string;
    color?: string;
    coverBlobId?: string | null;
  }): Promise<ConversationFolder> {
    const name = normalizeName(input.name);
    await this.db.runAsync(
      "INSERT INTO conversation_folders (id,name,color,cover_blob_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      input.id,
      name,
      normalizeColor(input.color),
      input.coverBlobId ?? null,
      input.now,
      input.now,
    );
    return {
      id: input.id,
      name,
      color: normalizeColor(input.color),
      coverBlobId: input.coverBlobId ?? null,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  async updateFolder(
    id: string,
    input: {
      name?: string;
      color?: string;
      coverBlobId?: string | null;
      now: string;
    },
  ): Promise<ConversationFolder> {
    const current = await this.getFolder(id);
    if (!current) throw new Error("Folder not found");
    const value = {
      name: input.name === undefined ? current.name : normalizeName(input.name),
      color:
        input.color === undefined ? current.color : normalizeColor(input.color),
      coverBlobId:
        input.coverBlobId === undefined
          ? current.coverBlobId
          : input.coverBlobId,
    };
    await this.db.runAsync(
      "UPDATE conversation_folders SET name=?,color=?,cover_blob_id=?,updated_at=? WHERE id=? AND deleted_at IS NULL",
      value.name,
      value.color,
      value.coverBlobId,
      input.now,
      id,
    );
    return { ...current, ...value, updatedAt: input.now };
  }

  async deleteFolder(id: string, now: string): Promise<void> {
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      const folder = await scopedDb.getFirstAsync<{ id: string }>(
        "SELECT id FROM conversation_folders WHERE id=? AND deleted_at IS NULL",
        id,
      );
      if (!folder) return;
      // Keep the folder row and all asset metadata for synchronization/recovery.
      await scopedDb.runAsync(
        "UPDATE conversation_folder_memberships SET folder_id=NULL WHERE folder_id=?",
        id,
      );
      await scopedDb.runAsync(
        "UPDATE conversation_folders SET deleted_at=?,updated_at=? WHERE id=?",
        now,
        now,
        id,
      );
    });
  }

  async moveConversation(
    conversationId: string,
    folderId: string | null,
  ): Promise<void> {
    if (folderId !== null) {
      const folder = await this.db.getFirstAsync<{ id: string }>(
        "SELECT id FROM conversation_folders WHERE id=? AND deleted_at IS NULL",
        folderId,
      );
      if (!folder) throw new Error("Folder not found");
    }
    const conversation = await this.db.getFirstAsync<{ id: string }>(
      "SELECT id FROM conversations WHERE id=?",
      conversationId,
    );
    if (!conversation) throw new Error("Conversation not found");
    await this.db.runAsync(
      `INSERT INTO conversation_folder_memberships (conversation_id,folder_id) VALUES (?,?)
       ON CONFLICT(conversation_id) DO UPDATE SET folder_id=excluded.folder_id`,
      conversationId,
      folderId,
    );
  }

  async getFolder(id: string): Promise<ConversationFolder | undefined> {
    const row = await this.db.getFirstAsync<FolderRow>(
      "SELECT id,name,color,cover_blob_id,created_at,updated_at FROM conversation_folders WHERE id=? AND deleted_at IS NULL",
      id,
    );
    return row ? fromFolder(row) : undefined;
  }

  async listFolders(): Promise<ConversationFolder[]> {
    const rows = await this.db.getAllAsync<FolderRow>(
      "SELECT id,name,color,cover_blob_id,created_at,updated_at FROM conversation_folders WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE,id",
    );
    return rows.map(fromFolder);
  }

  async listConversations(
    folderId?: string | null,
    options: ConversationListOptions = {},
  ): Promise<LibraryConversation[]> {
    const rows = await this.db.getAllAsync<ConversationRow>(
      `${conversationSelect}
       WHERE (? IS NULL OR f.folder_id=?)
         AND ${options.archived ? "a.archived_at IS NOT NULL" : "a.archived_at IS NULL"}
       ORDER BY COALESCE(h.last_used_at,c.updated_at) DESC,c.created_at DESC,c.id`,
      folderId ?? null,
      folderId ?? null,
    );
    return rows.map(fromConversation);
  }

  /** Reversible: hides the conversation from Recent without touching its messages. */
  async archiveConversation(conversationId: string, now: string): Promise<void> {
    const conversation = await this.db.getFirstAsync<{ id: string }>(
      "SELECT id FROM conversations WHERE id=?",
      conversationId,
    );
    if (!conversation) throw new Error("Conversation not found");
    await this.db.runAsync(
      `INSERT INTO conversation_archive_state (conversation_id,archived_at) VALUES (?,?)
       ON CONFLICT(conversation_id) DO NOTHING`,
      conversationId,
      now,
    );
  }

  async unarchiveConversation(conversationId: string): Promise<void> {
    await this.db.runAsync(
      "DELETE FROM conversation_archive_state WHERE conversation_id=?",
      conversationId,
    );
  }

  async countArchived(): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>(
      "SELECT COUNT(*) AS count FROM conversation_archive_state a JOIN conversations c ON c.id=a.conversation_id",
    );
    return row?.count ?? 0;
  }

  /** History rows for one view (Recent or Archived), optionally filtered by text. */
  async listHistory(
    options: { archived?: boolean; query?: string } = {},
  ): Promise<HistoryConversation[]> {
    const listOptions = { archived: options.archived ?? false };
    const conversations = options.query?.trim()
      ? (await this.search(options.query, null, listOptions)).conversations
      : await this.listConversations(null, listOptions);
    if (!conversations.length) return [];
    const hasVariants = await this.hasResponseVariants();
    // Only the newest few visible messages per conversation are needed for a preview.
    const rows = await this.db.getAllAsync<{
      id: string;
      parts_json: string;
      rank: number;
    }>(
      `SELECT id,parts_json,rank FROM (
         SELECT m.conversation_id AS id,
           ${hasVariants ? "COALESCE(v.content_json,m.parts_json)" : "m.parts_json"} AS parts_json,
           ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.sequence DESC) AS rank
         FROM messages m
         ${hasVariants ? "LEFT JOIN response_variants v ON v.message_id=m.id AND v.selected=1" : ""}
         WHERE m.role IN ('user','assistant')
       ) WHERE rank <= 4 ORDER BY id,rank`,
    );
    const previews = new Map<string, string>();
    for (const row of rows) {
      if (previews.has(row.id)) continue;
      const text = visibleText(parseJson(row.parts_json)).replace(/\s+/g, " ").trim();
      if (text) previews.set(row.id, text.slice(0, 160));
    }
    return conversations.map((conversation) => ({
      ...conversation,
      preview: previews.get(conversation.id) ?? null,
    }));
  }

  private async hasResponseVariants(): Promise<boolean> {
    return !!(await this.db.getFirstAsync<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='response_variants'",
    ));
  }

  async search(
    query: string,
    folderId?: string | null,
    options: ConversationListOptions = {},
  ): Promise<LibrarySearchResult> {
    const normalized = query.trim().toLocaleLowerCase();
    const [folders, all] = await Promise.all([
      this.listFolders(),
      this.listConversations(folderId, options),
    ]);
    if (!normalized)
      return {
        query,
        folders,
        conversations: all,
        emptyState: all.length || folders.length ? null : "library-empty",
      };
    const hasVariants = await this.hasResponseVariants();
    const rows = await this.db.getAllAsync<{
      id: string;
      role: string;
      parts_json: string;
    }>(
      `SELECT m.conversation_id AS id,m.role,${hasVariants ? "COALESCE(v.content_json,m.parts_json)" : "m.parts_json"} AS parts_json FROM messages m
       JOIN conversations c ON c.id=m.conversation_id
       ${hasVariants ? "LEFT JOIN response_variants v ON v.message_id=m.id AND v.selected=1" : ""}
       LEFT JOIN conversation_folder_memberships f ON f.conversation_id=c.id
       WHERE m.role IN ('user','assistant') AND (? IS NULL OR f.folder_id=?) ORDER BY m.conversation_id,m.sequence`,
      folderId ?? null,
      folderId ?? null,
    );
    const textById = new Map<string, string[]>();
    for (const row of rows) {
      const text = visibleText(parseJson(row.parts_json));
      if (text) textById.set(row.id, [...(textById.get(row.id) ?? []), text]);
    }
    const conversations = all.flatMap((conversation) => {
      const texts = textById.get(conversation.id) ?? [];
      const matched = texts.find((text) =>
        text.toLocaleLowerCase().includes(normalized),
      );
      const title = conversation.title ?? "";
      if (
        !title.toLocaleLowerCase().includes(normalized) &&
        matched === undefined
      )
        return [];
      return [
        {
          ...conversation,
          ...(matched === undefined
            ? {}
            : {
                snippet: matched.slice(
                  Math.max(
                    0,
                    matched.toLocaleLowerCase().indexOf(normalized) - 60,
                  ),
                  Math.max(
                    0,
                    matched.toLocaleLowerCase().indexOf(normalized) - 60,
                  ) + 180,
                ),
              }),
        },
      ];
    });
    const matchingFolders = folders.filter((folder) =>
      folder.name.toLocaleLowerCase().includes(normalized),
    );
    return {
      query,
      folders: matchingFolders,
      conversations,
      emptyState:
        conversations.length || matchingFolders.length
          ? null
          : "query-no-results",
    };
  }
}

/** Requires schema migration 0008 (conversation_archive_state). */
const conversationSelect = `SELECT c.id,c.title,f.folder_id,h.model_id,h.last_used_at,a.archived_at,c.created_at,c.updated_at
  FROM conversations c
  LEFT JOIN conversation_folder_memberships f ON f.conversation_id=c.id
  LEFT JOIN chat_history_metadata h ON h.conversation_id=c.id
  LEFT JOIN conversation_archive_state a ON a.conversation_id=c.id`;

function normalizeName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Folder name cannot be empty");
  if (name.length > 80)
    throw new Error("Folder name must be 80 characters or fewer");
  return name;
}
function normalizeColor(value?: string): string {
  const color = value ?? "#6750A4";
  if (!/^#[0-9a-f]{6}$/i.test(color))
    throw new Error("Folder color must be a six-digit hex color");
  return color.toUpperCase();
}
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
/** Match the displayed ordinary text projection; never inspect nested tool or reasoning payloads. */
function visibleText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part: unknown) => {
      if (!part || typeof part !== "object") return [];
      const object = part as Record<string, unknown>;
      return (object.type === "text" || object.kind === "text") &&
        typeof object.text === "string"
        ? [object.text]
        : [];
    })
    .join("");
}
