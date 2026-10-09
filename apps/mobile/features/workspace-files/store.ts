import { strToU8 } from "fflate";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export interface WorkspaceStorageLimits {
  readonly fileBytes: number;
  readonly chatBytes: number;
  readonly fileCount: number;
}

export const WORKSPACE_LIMITS: WorkspaceStorageLimits = Object.freeze({
  fileBytes: 256 * 1024,
  chatBytes: 8 * 1024 * 1024,
  fileCount: 128,
});

export const WORKSPACE_FILES_SQL = `
  CREATE TABLE IF NOT EXISTS chat_workspace_files (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    path TEXT NOT NULL COLLATE NOCASE,
    content TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length >= 0 AND byte_length <= 262144),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(conversation_id, path)
  );
`;

export interface WorkspaceFileMetadata {
  readonly path: string;
  readonly kind: "markdown" | "text";
  readonly byteLength: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceFile extends WorkspaceFileMetadata {
  readonly content: string;
}

export interface WorkspaceWriteInput {
  readonly path: string;
  readonly content: string;
  /** Omit for a new file. Replacing a file requires its current revision. */
  readonly expectedRevision?: number;
}

export interface WorkspaceFilesStore {
  readonly conversationId: string;
  initialize(): Promise<void>;
  list(): Promise<readonly WorkspaceFileMetadata[]>;
  read(path: string): Promise<WorkspaceFile | undefined>;
  /** A single SQLite snapshot for a consistent whole-workspace export. */
  snapshot(): Promise<readonly WorkspaceFile[]>;
  write(
    input: WorkspaceWriteInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceFile>;
}

export class WorkspaceFileError extends Error {
  readonly name = "WorkspaceFileError";
  constructor(
    readonly code:
      | "malformed"
      | "quota"
      | "canceled"
      | "conflict"
      | "missing-chat"
      | "missing-file",
    message: string,
  ) {
    super(message);
  }
}

/** Logical names only: model arguments never become native filesystem paths. */
export function validateWorkspacePath(input: unknown): string {
  if (typeof input !== "string" || !input || input.length > 255)
    throw new WorkspaceFileError(
      "malformed",
      "Enter a relative Markdown or text filename of up to 255 characters, for example notes/plan.md.",
    );
  const parts = input.split("/");
  if (
    parts.some(
      (part) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(part) ||
        part.endsWith(".") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    ) ||
    !/\.(?:md|txt)$/i.test(parts.at(-1) ?? "")
  )
    throw new WorkspaceFileError(
      "malformed",
      "Use a relative .md or .txt path with letters, numbers, dots, underscores or hyphens, for example notes/plan.md. Absolute paths, parent folders and reserved device names are not allowed.",
    );
  return input;
}

type FileRow = {
  path: string;
  content: string;
  byte_length: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

function metadata(row: Omit<FileRow, "content">): WorkspaceFileMetadata {
  return {
    path: row.path,
    kind: /\.md$/i.test(row.path) ? "markdown" : "text",
    byteLength: row.byte_length,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function file(row: FileRow): WorkspaceFile {
  return { ...metadata(row), content: row.content };
}

function assertNotCanceled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new WorkspaceFileError(
      "canceled",
      "File writing was canceled. The previous saved file has been kept.",
    );
}

/** Uses the app's shared SQLite connection; files live exactly as long as their chat. */
export class SQLiteWorkspaceFiles implements WorkspaceFilesStore {
  private initialized: Promise<void> | undefined;
  private readonly limits: WorkspaceStorageLimits;
  private readonly now: () => string;

  constructor(
    private readonly db: SQLiteDatabasePort,
    readonly conversationId: string,
    options: {
      limits?: Partial<WorkspaceStorageLimits>;
      now?: () => string;
    } = {},
  ) {
    if (!conversationId.trim())
      throw new WorkspaceFileError(
        "malformed",
        "A chat is required to open its files.",
      );
    const limits = { ...WORKSPACE_LIMITS, ...options.limits };
    for (const key of ["fileBytes", "chatBytes", "fileCount"] as const)
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > WORKSPACE_LIMITS[key]
      )
        throw new WorkspaceFileError(
          "malformed",
          "The workspace storage limits are invalid.",
        );
    this.limits = limits;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  initialize(): Promise<void> {
    this.initialized ??= this.db
      .execAsync(WORKSPACE_FILES_SQL)
      .catch((cause) => {
        this.initialized = undefined;
        throw cause;
      });
    return this.initialized;
  }

  async list(): Promise<readonly WorkspaceFileMetadata[]> {
    await this.initialize();
    const rows = await this.db.getAllAsync<Omit<FileRow, "content">>(
      "SELECT path,byte_length,revision,created_at,updated_at FROM chat_workspace_files WHERE conversation_id=? ORDER BY path COLLATE NOCASE",
      this.conversationId,
    );
    return rows.map(metadata);
  }

  async read(input: string): Promise<WorkspaceFile | undefined> {
    const path = validateWorkspacePath(input);
    await this.initialize();
    const row = await this.db.getFirstAsync<FileRow>(
      "SELECT path,content,byte_length,revision,created_at,updated_at FROM chat_workspace_files WHERE conversation_id=? AND path=? COLLATE NOCASE",
      this.conversationId,
      path,
    );
    return row ? file(row) : undefined;
  }

  async snapshot(): Promise<readonly WorkspaceFile[]> {
    await this.initialize();
    const rows = await this.db.getAllAsync<FileRow>(
      "SELECT path,content,byte_length,revision,created_at,updated_at FROM chat_workspace_files WHERE conversation_id=? ORDER BY path COLLATE NOCASE",
      this.conversationId,
    );
    return rows.map(file);
  }

  async write(
    input: WorkspaceWriteInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceFile> {
    assertNotCanceled(signal);
    const path = validateWorkspacePath(input.path);
    if (typeof input.content !== "string")
      throw new WorkspaceFileError(
        "malformed",
        "File content must be complete text.",
      );
    if (
      input.expectedRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1)
    )
      throw new WorkspaceFileError(
        "malformed",
        "The expected file revision must be a positive integer.",
      );
    const byteLength = strToU8(input.content).byteLength;
    if (byteLength > this.limits.fileBytes)
      throw new WorkspaceFileError(
        "quota",
        `The file contains ${byteLength.toLocaleString("en-US")} UTF-8 bytes; one file can contain at most ${this.limits.fileBytes.toLocaleString("en-US")} bytes. Shorten it or split it into several files.`,
      );
    await this.initialize();
    let saved: WorkspaceFile | undefined;
    await this.db.withTransactionAsync(async (transaction) => {
      const db = transaction ?? this.db;
      assertNotCanceled(signal);
      const chat = await db.getFirstAsync<{ id: string }>(
        "SELECT id FROM conversations WHERE id=?",
        this.conversationId,
      );
      if (!chat)
        throw new WorkspaceFileError(
          "missing-chat",
          "This chat is no longer available. Files cannot be saved after the chat is deleted.",
        );
      const existing = await db.getFirstAsync<FileRow>(
        "SELECT path,content,byte_length,revision,created_at,updated_at FROM chat_workspace_files WHERE conversation_id=? AND path=? COLLATE NOCASE",
        this.conversationId,
        path,
      );
      if (existing && input.expectedRevision !== existing.revision)
        throw new WorkspaceFileError(
          "conflict",
          `The file ${existing.path} already exists at revision ${existing.revision}. Read the current file, then use that revision to replace it. Your unsaved text has been kept.`,
        );
      if (!existing && input.expectedRevision !== undefined)
        throw new WorkspaceFileError(
          "conflict",
          `The file ${path} does not exist. Omit expectedRevision to create a new file.`,
        );
      const usage = await db.getFirstAsync<{
        file_count: number;
        total_bytes: number;
      }>(
        "SELECT COUNT(*) AS file_count,COALESCE(SUM(byte_length),0) AS total_bytes FROM chat_workspace_files WHERE conversation_id=?",
        this.conversationId,
      );
      if (!existing && (usage?.file_count ?? 0) >= this.limits.fileCount)
        throw new WorkspaceFileError(
          "quota",
          `This chat already has ${this.limits.fileCount} files. Update an existing file or start a new chat.`,
        );
      if (
        (usage?.total_bytes ?? 0) - (existing?.byte_length ?? 0) + byteLength >
        this.limits.chatBytes
      )
        throw new WorkspaceFileError(
          "quota",
          `Files in this chat can use at most ${this.limits.chatBytes.toLocaleString("en-US")} UTF-8 bytes. Shorten an existing file or start a new chat.`,
        );
      assertNotCanceled(signal);
      const timestamp = this.now();
      const row: FileRow = {
        path: existing?.path ?? path,
        content: input.content,
        byte_length: byteLength,
        revision: (existing?.revision ?? 0) + 1,
        created_at: existing?.created_at ?? timestamp,
        updated_at: timestamp,
      };
      await db.runAsync(
        "INSERT INTO chat_workspace_files(conversation_id,path,content,byte_length,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(conversation_id,path) DO UPDATE SET content=excluded.content,byte_length=excluded.byte_length,revision=excluded.revision,updated_at=excluded.updated_at",
        this.conversationId,
        row.path,
        row.content,
        row.byte_length,
        row.revision,
        row.created_at,
        row.updated_at,
      );
      assertNotCanceled(signal);
      saved = file(row);
    });
    return saved!;
  }
}
