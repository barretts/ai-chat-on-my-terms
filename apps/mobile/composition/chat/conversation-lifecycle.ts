import type { BlobOwnerType } from "@locallab/storage-blobs";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

/**
 * Permanent conversation delete.
 *
 * Phase 1 (one SQL transaction): record every attachment/blob owner the conversation
 * could hold in `conversation_delete_cleanups`, then delete the conversation and every
 * row that points at it, its messages, or its runs. Memories and arena sessions are kept
 * but unlinked. Nothing is half-deleted: the transaction commits or rolls back.
 *
 * Phase 2 (`runConversationCleanups`): release those owners through the attachment and
 * blob stores so managed files are garbage-collected by the store that owns them. The
 * cleanup rows survive a crash between phases and are resumed on the next launch.
 */

export interface ConversationCleanupPorts {
  /** SQLiteChatAttachments.release: drops the owner row and the blob reference it held. */
  releaseAttachment(ownerId: string, attachmentId: string): Promise<void>;
  /** BlobStore.removeReference: drops one reference and deletes unowned bytes. */
  removeBlobReference(
    blobId: string,
    owner: { ownerType: BlobOwnerType; ownerId: string },
  ): Promise<unknown>;
}

export interface DeleteConversationOptions {
  /**
   * Conversation that inherits app-level pointers (active chat, the per-mode model choice,
   * the first-run chat slot) so deleting a chat does not reset the user's setup.
   */
  reassignTo?: string | null;
}

/** Owner ids used when attachments/blobs are retained for a conversation. */
export function conversationOwnerIds(input: {
  conversationId: string;
  messageIds: readonly string[];
  runIds: readonly string[];
}): string[] {
  return [
    `draft:${input.conversationId}`,
    `conversation:${input.conversationId}`,
    ...input.messageIds.flatMap((id) => [`message:${id}`, id]),
    ...input.runIds.map((id) => `persona-run:${id}`),
  ];
}

async function existingTables(db: SQLiteDatabasePort): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table'",
  );
  return new Set(rows.map((row) => row.name));
}

/** Returns false when the conversation was already gone (idempotent). */
export async function deleteConversation(
  db: SQLiteDatabasePort,
  conversationId: string,
  options: DeleteConversationOptions = {},
): Promise<boolean> {
  if (!conversationId.trim()) throw new TypeError("Conversation ID is required");
  const reassignTo =
    options.reassignTo && options.reassignTo !== conversationId
      ? options.reassignTo
      : null;
  let deleted = false;
  await db.withTransactionAsync(async (transaction) => {
    const tx = transaction ?? db;
    const exists = await tx.getFirstAsync<{ id: string }>(
      "SELECT id FROM conversations WHERE id=?",
      conversationId,
    );
    if (!exists) return;
    const replacement = reassignTo
      ? ((await tx.getFirstAsync<{ id: string }>(
          "SELECT id FROM conversations WHERE id=?",
          reassignTo,
        ))?.id ?? null)
      : null;
    const tables = await existingTables(tx);
    const has = (name: string) => tables.has(name);
    const run = (sql: string, ...params: string[]) => tx.runAsync(sql, ...params);
    const messages = "SELECT id FROM messages WHERE conversation_id=?";
    const runs = has("persona_run_snapshots")
      ? "SELECT id FROM runs WHERE conversation_id=? UNION SELECT run_id FROM persona_run_snapshots WHERE conversation_id=?"
      : "SELECT id FROM runs WHERE conversation_id=?";
    const runParams = has("persona_run_snapshots")
      ? [conversationId, conversationId]
      : [conversationId];

    const messageIds = (
      await tx.getAllAsync<{ id: string }>(messages, conversationId)
    ).map((row) => row.id);
    const runIds = (await tx.getAllAsync<{ id: string }>(runs, ...runParams)).map(
      (row) => row.id,
    );
    for (const ownerId of conversationOwnerIds({ conversationId, messageIds, runIds }))
      await run(
        "INSERT INTO conversation_delete_cleanups(owner_id,conversation_id) VALUES(?,?) ON CONFLICT(owner_id) DO NOTHING",
        ownerId,
        conversationId,
      );

    // Rows keyed by message or run ids carry no foreign key; remove them before their parents.
    if (has("response_variants"))
      await run(`DELETE FROM response_variants WHERE message_id IN (${messages})`, conversationId);
    if (has("server_continuations"))
      await run(`DELETE FROM server_continuations WHERE message_id IN (${messages})`, conversationId);
    if (has("memory_extraction_runs"))
      await run(`DELETE FROM memory_extraction_runs WHERE run_id IN (${runs})`, ...runParams);
    if (has("generation_lifecycle"))
      await run(
        `DELETE FROM generation_lifecycle WHERE conversation_id=? OR run_id IN (${runs})`,
        conversationId,
        ...runParams,
      );
    if (has("tool_engine_invocations"))
      await run("DELETE FROM tool_engine_invocations WHERE conversation_id=?", conversationId);
    if (has("semantic_search_documents")) {
      if (has("semantic_search_fts"))
        await run(
          "DELETE FROM semantic_search_fts WHERE document_key IN (SELECT document_key FROM semantic_search_documents WHERE conversation_id=?)",
          conversationId,
        );
      await run("DELETE FROM semantic_search_documents WHERE conversation_id=?", conversationId);
    }
    if (has("chat_parameter_presets"))
      await run(
        "DELETE FROM chat_parameter_presets WHERE scope='chat' AND conversation_id=?",
        conversationId,
      );

    // App-level pointers move to the replacement chat instead of resetting the user's setup.
    if (has("chat_view_state"))
      await tx.runAsync(
        "UPDATE chat_view_state SET conversation_id=? WHERE conversation_id=?",
        replacement,
        conversationId,
      );
    if (replacement && has("first_run_chat_settings"))
      await run(
        "UPDATE first_run_chat_settings SET conversation_id=? WHERE conversation_id=?",
        replacement,
        conversationId,
      );
    if (has("chat_history_allocations")) {
      // A missing allocation target makes allocateConversation throw on next launch, and a
      // deleted first-run slot would resurrect an empty "Offline chat". Hand the slot over.
      if (replacement) {
        await run(
          "DELETE FROM chat_history_allocations WHERE conversation_id=? AND allocation_key LIKE 'new-chat:%'",
          replacement,
        );
        const taken = await tx.getFirstAsync<{ n: number }>(
          "SELECT COUNT(*) AS n FROM chat_history_allocations WHERE conversation_id=?",
          replacement,
        );
        if (!taken?.n)
          await run(
            "UPDATE chat_history_allocations SET conversation_id=? WHERE conversation_id=? AND allocation_key LIKE 'first-run-chat:%'",
            replacement,
            conversationId,
          );
      }
      await run("DELETE FROM chat_history_allocations WHERE conversation_id=?", conversationId);
    }
    for (const table of [
      "chat_history_metadata",
      "chat_appearance",
      "chat_context_policies",
      "chat_provider_selections",
      "first_run_chat_settings",
      "conversation_personas",
      "persona_run_snapshots",
      "conversation_folder_memberships",
      "conversation_archive_state",
    ])
      if (has(table))
        await run(`DELETE FROM ${table} WHERE conversation_id=?`, conversationId);

    // Memories and arena results outlive the transcript they came from.
    if (has("memory_items"))
      await run(
        "UPDATE memory_items SET source_conversation_id=NULL WHERE source_conversation_id=?",
        conversationId,
      );
    if (has("arena_sessions"))
      await run(
        "UPDATE arena_sessions SET conversation_id=NULL WHERE conversation_id=?",
        conversationId,
      );

    await run(
      "DELETE FROM jobs WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=?)",
      conversationId,
    );
    await run("DELETE FROM messages WHERE conversation_id=?", conversationId);
    await run("DELETE FROM runs WHERE conversation_id=?", conversationId);
    await run("DELETE FROM conversations WHERE id=?", conversationId);
    deleted = true;
  });
  return deleted;
}

/**
 * Releases attachment and blob owners left by deleted conversations. Safe to call
 * repeatedly; a failed owner stays queued and is retried on the next call.
 */
export async function runConversationCleanups(
  db: SQLiteDatabasePort,
  ports: ConversationCleanupPorts,
): Promise<{ released: number; failed: number }> {
  const tables = await existingTables(db);
  if (!tables.has("conversation_delete_cleanups")) return { released: 0, failed: 0 };
  const pending = await db.getAllAsync<{ owner_id: string }>(
    "SELECT owner_id FROM conversation_delete_cleanups ORDER BY created_at,owner_id",
  );
  let released = 0;
  let failed = 0;
  for (const { owner_id: ownerId } of pending) {
    try {
      if (tables.has("chat_attachment_owners")) {
        const attachments = await db.getAllAsync<{ attachment_id: string }>(
          "SELECT attachment_id FROM chat_attachment_owners WHERE owner_id=?",
          ownerId,
        );
        for (const { attachment_id } of attachments)
          await ports.releaseAttachment(ownerId, attachment_id);
        // Descriptors that vanished still leave an owner row; drop it directly.
        await db.runAsync("DELETE FROM chat_attachment_owners WHERE owner_id=?", ownerId);
      }
      if (tables.has("blob_references")) {
        const references = await db.getAllAsync<{
          blob_id: string;
          owner_type: BlobOwnerType;
        }>(
          "SELECT blob_id,owner_type FROM blob_references WHERE owner_id=?",
          ownerId,
        );
        for (const reference of references)
          await ports.removeBlobReference(reference.blob_id, {
            ownerType: reference.owner_type,
            ownerId,
          });
      }
      await db.runAsync("DELETE FROM conversation_delete_cleanups WHERE owner_id=?", ownerId);
      released += 1;
    } catch {
      failed += 1;
    }
  }
  return { released, failed };
}
