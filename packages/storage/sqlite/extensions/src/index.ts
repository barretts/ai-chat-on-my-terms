import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import {
  EntityIdSchema,
  IsoTimestampSchema,
} from "@locallab/contracts/identity";
import { TombstoneSchema } from "@locallab/contracts/entities";

export interface MemoryEntry {
  id: string;
  namespace: string;
  content: string;
  metadata: Readonly<Record<string, unknown>>;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

type MemoryRow = {
  id: string;
  namespace: string;
  content: string;
  metadata_json: string;
  source_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

function decodeMemory(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    namespace: row.namespace,
    content: row.content,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    sourceConversationId: row.source_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/** Repositories for optional, local-only records added by the 0002 migration. */
export class ExtensionSQLiteRepositories {
  constructor(private readonly db: SQLiteDatabasePort) {}

  async savePersona(input: {
    id: string;
    name: string;
    description?: string | null;
    prompt: string;
    isDefault?: boolean;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<void> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;
    await this.db.runAsync(
      `INSERT INTO personas (id, name, description, prompt, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
       prompt=excluded.prompt, is_default=excluded.is_default, updated_at=excluded.updated_at`,
      input.id,
      input.name,
      input.description ?? null,
      input.prompt,
      input.isDefault ? 1 : 0,
      createdAt,
      updatedAt,
    );
  }

  async listPersonas(): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      prompt: string;
      isDefault: boolean;
      createdAt: string;
      updatedAt: string;
    }>
  > {
    const rows = await this.db.getAllAsync<{
      id: string;
      name: string;
      description: string | null;
      prompt: string;
      is_default: number;
      created_at: string;
      updated_at: string;
    }>(
      "SELECT id, name, description, prompt, is_default, created_at, updated_at FROM personas ORDER BY created_at, id",
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      prompt: row.prompt,
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async saveMemory(input: {
    id: string;
    namespace?: string;
    content: string;
    metadata?: Readonly<Record<string, unknown>>;
    sourceConversationId?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<MemoryEntry> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;
    EntityIdSchema.parse(input.id);
    IsoTimestampSchema.parse(createdAt);
    IsoTimestampSchema.parse(updatedAt);
    if (
      input.sourceConversationId !== undefined &&
      input.sourceConversationId !== null
    ) {
      EntityIdSchema.parse(input.sourceConversationId);
    }
    await this.db.runAsync(
      `INSERT INTO memory_items (id, namespace, content, metadata_json, source_conversation_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET namespace=excluded.namespace, content=excluded.content,
       metadata_json=excluded.metadata_json, source_conversation_id=excluded.source_conversation_id,
       updated_at=excluded.updated_at, deleted_at=NULL`,
      input.id,
      input.namespace ?? "default",
      input.content,
      JSON.stringify(input.metadata ?? {}),
      input.sourceConversationId ?? null,
      createdAt,
      updatedAt,
    );
    return (await this.getMemory(input.id))!;
  }

  async getMemory(
    id: string,
    includeDeleted = false,
  ): Promise<MemoryEntry | null> {
    const row = await this.db.getFirstAsync<MemoryRow>(
      `SELECT id, namespace, content, metadata_json, source_conversation_id, created_at, updated_at, deleted_at
       FROM memory_items WHERE id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`,
      id,
    );
    return row ? decodeMemory(row) : null;
  }

  async listMemory(namespace = "default"): Promise<MemoryEntry[]> {
    const rows = await this.db.getAllAsync<MemoryRow>(
      `SELECT id, namespace, content, metadata_json, source_conversation_id, created_at, updated_at, deleted_at
       FROM memory_items WHERE namespace = ? AND deleted_at IS NULL ORDER BY updated_at, id`,
      namespace,
    );
    return rows.map(decodeMemory);
  }

  /** A tombstone is a soft-delete so an opted-in sync peer can observe it. */
  async tombstoneMemory(
    tombstone: unknown,
    deletedAt = new Date().toISOString(),
  ): Promise<boolean> {
    const parsed = TombstoneSchema.parse(tombstone);
    if (parsed.entityType !== "memory")
      throw new Error("Expected a memory tombstone");
    const result = await this.db.runAsync(
      "UPDATE memory_items SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      deletedAt,
      deletedAt,
      parsed.entityId,
    );
    return changedRows(result) > 0;
  }

  async createGroup(input: {
    id: string;
    name: string;
    createdAt?: string;
  }): Promise<void> {
    await this.db.runAsync(
      "INSERT INTO local_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      input.id,
      input.name,
      input.createdAt ?? new Date().toISOString(),
      input.createdAt ?? new Date().toISOString(),
    );
  }

  async addGroupMember(input: {
    groupId: string;
    participantId: string;
    displayName: string;
    role: "owner" | "member" | "guest";
    joinedAt?: string;
  }): Promise<void> {
    await this.db.runAsync(
      "INSERT INTO group_members (group_id, participant_id, display_name, role, joined_at) VALUES (?, ?, ?, ?, ?)",
      input.groupId,
      input.participantId,
      input.displayName,
      input.role,
      input.joinedAt ?? new Date().toISOString(),
    );
  }

  async createArenaSession(input: {
    id: string;
    conversationId?: string | null;
    status: "ready" | "running" | "completed" | "failed" | "canceled";
    config?: Readonly<Record<string, unknown>>;
    createdAt?: string;
  }): Promise<void> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    await this.db.runAsync(
      `INSERT INTO arena_sessions (id, conversation_id, status, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.id,
      input.conversationId ?? null,
      input.status,
      JSON.stringify(input.config ?? {}),
      createdAt,
      createdAt,
    );
  }

  async createPairingSession(input: {
    id: string;
    state: "pending" | "paired" | "expired" | "revoked";
    peerDeviceId?: string | null;
    peerFingerprint?: string | null;
    expiresAt: string;
    createdAt?: string;
  }): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO pairing_sessions (id, state, peer_device_id, peer_fingerprint, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.id,
      input.state,
      input.peerDeviceId ?? null,
      input.peerFingerprint ?? null,
      input.expiresAt,
      input.createdAt ?? new Date().toISOString(),
    );
  }

  async advanceSyncCursor(
    peerDeviceId: string,
    sequence: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error(
        "Sync cursor sequence must be a nonnegative safe integer",
      );
    }
    await this.db.runAsync(
      `INSERT INTO sync_cursors (peer_device_id, last_sequence) VALUES (?, ?)
       ON CONFLICT(peer_device_id) DO UPDATE SET
         last_sequence = MAX(sync_cursors.last_sequence, excluded.last_sequence),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      peerDeviceId,
      sequence,
    );
  }

  async recordSyncOperation(input: {
    id: string;
    peerDeviceId: string;
    sequence: number;
    entityType: string;
    entityId: string;
    operation: "upsert" | "tombstone";
    revision: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
      throw new Error(
        "Sync operation sequence must be a positive safe integer",
      );
    }
    await this.db.runAsync(
      `INSERT INTO sync_operations
        (id, peer_device_id, sequence, entity_type, entity_id, operation, revision_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.peerDeviceId,
      input.sequence,
      input.entityType,
      input.entityId,
      input.operation,
      JSON.stringify(input.revision),
    );
  }

  async saveConsent(input: {
    id: string;
    accountId: string | null;
    purpose: string;
    granted: boolean;
    policyVersion: string;
    decidedAt?: string;
  }): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO consent_records (id, account_id, purpose, granted, policy_version, decided_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, purpose, policy_version) DO UPDATE SET
         granted = excluded.granted, decided_at = excluded.decided_at`,
      input.id,
      input.accountId,
      input.purpose,
      input.granted ? 1 : 0,
      input.policyVersion,
      input.decidedAt ?? new Date().toISOString(),
    );
  }

  async saveLocalAccount(input: {
    id: string;
    accountType: "local" | "cloud";
    subject?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<void> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    await this.db.runAsync(
      `INSERT INTO local_accounts (id, account_type, subject, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET account_type = excluded.account_type,
         subject = excluded.subject, updated_at = excluded.updated_at`,
      input.id,
      input.accountType,
      input.subject ?? null,
      createdAt,
      input.updatedAt ?? createdAt,
    );
  }

  /** Couple an attachment row to its media metadata in one transaction. */
  async saveMediaAsset(input: {
    id: string;
    mediaType: "image" | "audio" | "video" | "file";
    localUri: string;
    mimeType: string;
    byteLength: number;
    sha256?: string | null;
    metadata?: Readonly<Record<string, unknown>>;
    createdAt?: string;
    attachment?: { id: string; extractedText?: string | null };
  }): Promise<void> {
    await this.db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? this.db;
      const createdAt = input.createdAt ?? new Date().toISOString();
      if (input.attachment) EntityIdSchema.parse(input.attachment.id);
      const metadata = {
        ...(input.metadata ?? {}),
        ...(input.attachment ? { attachment: input.attachment } : {}),
      };
      await scopedDb.runAsync(
        `INSERT INTO media_assets (id, media_type, local_uri, mime_type, byte_length, sha256, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.mediaType,
        input.localUri,
        input.mimeType,
        input.byteLength,
        input.sha256 ?? null,
        JSON.stringify(metadata),
        createdAt,
      );
    });
  }
}

function changedRows(result: unknown): number {
  if (typeof result === "object" && result !== null && "changes" in result) {
    const changes = (result as { changes?: unknown }).changes;
    return typeof changes === "number" ? changes : 0;
  }
  return 0;
}
