import {
  ArchiveValidationError,
  exportAllChatsZip,
  exportConversationPdf,
  exportConversationTxt,
  importAllChatsZip,
  type ArchiveAsset,
  type ArchiveConversation,
  type ArchiveMessage,
} from "@locallab/archives";
import { initializeChatHistory } from "@locallab/chat-history";
import { createChatId } from "../../first-run-chat";
import type {
  ArchiveAttachmentDescriptor,
  MobileArchiveOptions,
  MobileArchivePorts,
} from "./types";

export type {
  ArchiveAttachmentDescriptor,
  ArchiveAttachmentsPort,
  ArchiveFilePort,
  ArchivePdfPort,
  MobileArchiveOptions,
  MobileArchivePorts,
} from "./types";

const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BLOB_KEYS = new Set(["blobRef", "blobId", "previewRef", "blob_ref"]);
const SECRET_KEY =
  /(?:api.?key|access.?token|refresh.?token|credential|authorization|password|secret|pin|private.?key)/i;

type StoredConversation = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};
type StoredMessage = { id: string; role: string; parts_json: string };
type StoredVariant = { id: string; content_json: string; selected: number };

/** Shared SQLite rows and managed blobs are the only data sources; endpoint configuration is never exported. */
export function createMobileArchivePorts(
  options: MobileArchiveOptions,
): MobileArchivePorts {
  const { db, blobs, files, zip, attachments } = options;
  const createId = options.createId ?? createChatId;
  const now = options.now ?? (() => new Date().toISOString());
  const ready = initializeChatHistory(db);

  async function readConversations(
    selectedId?: string,
  ): Promise<ArchiveConversation[]> {
    await ready;
    const result: ArchiveConversation[] = [];
    await db.withTransactionAsync(async (transaction) => {
      const scopedDb = transaction ?? db;
      const rows = await scopedDb.getAllAsync<StoredConversation>(
        `SELECT id,title,created_at,updated_at FROM conversations${selectedId ? " WHERE id=?" : ""} ORDER BY created_at,id`,
        ...(selectedId ? [selectedId] : []),
      );
      for (const row of rows) {
        const messages = await scopedDb.getAllAsync<StoredMessage>(
          "SELECT id,role,parts_json FROM messages WHERE conversation_id=? ORDER BY sequence",
          row.id,
        );
        const archiveMessages: ArchiveMessage[] = [];
        for (const message of messages) {
          const variants = await scopedDb.getAllAsync<StoredVariant>(
            "SELECT id,content_json,selected FROM response_variants WHERE message_id=? ORDER BY generation",
            message.id,
          );
          archiveMessages.push({
            id: message.id,
            role: message.role,
            parts: clean(JSON.parse(message.parts_json)) as unknown[],
            ...(variants.length
              ? {
                  variants: variants.map((variant) => ({
                    id: variant.id,
                    parts: clean(JSON.parse(variant.content_json)) as unknown[],
                    selected: variant.selected === 1,
                  })),
                }
              : {}),
          });
        }
        result.push({
          id: row.id,
          title: row.title ?? "Untitled chat",
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          messages: archiveMessages,
        });
      }
    });
    return result;
  }

  async function requiredAssets(
    conversations: readonly ArchiveConversation[],
  ): Promise<ArchiveAsset[]> {
    const blobIds = new Set<string>();
    const attachmentIds = new Set<string>();
    visit(conversations, (key, value) => {
      if (typeof value !== "string") return;
      if (BLOB_KEYS.has(key)) blobIds.add(bareBlobId(value));
      if (key === "attachmentId") attachmentIds.add(value);
    });
    const assets: ArchiveAsset[] = [];
    for (const id of attachmentIds) {
      const descriptor = await attachments?.get(id);
      if (!descriptor)
        throw new ArchiveValidationError(
          "A required attachment is unavailable. Restore it before exporting.",
        );
      blobIds.add(descriptor.blobRef);
      if (descriptor.previewRef) blobIds.add(descriptor.previewRef);
      assets.push({
        path: `attachments/${id}.json`,
        mimeType: "application/json",
        bytes: encoder.encode(JSON.stringify(clean(descriptor))),
      });
    }
    let totalBytes = assets.reduce((sum, asset) => sum + asset.bytes.length, 0);
    for (const id of blobIds) {
      const lease = await blobs.acquireLease(id, "chat-archive-export", 60_000);
      try {
        const asset = await blobs.read(id);
        totalBytes += asset.bytes.length;
        if (totalBytes > MAX_ZIP_BYTES)
          throw new ArchiveValidationError(
            "Chat assets exceed the 512 MiB limit",
          );
        assets.push({
          path: `blobs/${id}`,
          mimeType: asset.metadata.mimeType,
          bytes: asset.bytes,
        });
      } finally {
        await blobs.releaseLease(lease.token);
      }
    }
    return assets;
  }

  async function save(
    input: readonly ArchiveConversation[],
    assets: readonly ArchiveAsset[] = [],
  ): Promise<string[]> {
    await ready;
    validateConversations(input);
    const importedIds: string[] = [];
    const ids = new Map<string, string>();
    const blobMap = new Map<string, string>();
    const attachmentMap = new Map<string, string>();
    const stagedBlobs: string[] = [];
    const stageOwner = {
      ownerType: "other" as const,
      ownerId: `archive-import:${createId()}`,
    };
    for (const conversation of input) {
      ids.set(conversation.id, createId());
      for (const message of conversation.messages) {
        ids.set(message.id, createId());
        for (const variant of message.variants ?? [])
          ids.set(variant.id, createId());
      }
    }
    const descriptors: ArchiveAttachmentDescriptor[] = [];
    try {
      for (const asset of assets) {
        const descriptorId = /^assets\/attachments\/([^/]+)\.json$/.exec(
          asset.path,
        )?.[1];
        if (descriptorId) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(decoder.decode(asset.bytes));
          } catch {
            throw new ArchiveValidationError(
              "Attachment descriptor is malformed JSON",
            );
          }
          const descriptor = validateDescriptor(parsed);
          if (
            descriptor.id !== descriptorId ||
            attachmentMap.has(descriptor.id)
          )
            throw new ArchiveValidationError(
              "Attachment descriptor identity is invalid",
            );
          if (!attachments)
            throw new ArchiveValidationError(
              "Attachment import is unavailable in this build",
            );
          attachmentMap.set(descriptor.id, createId());
          descriptors.push(descriptor);
          continue;
        }
        const oldId = /^assets\/blobs\/([^/]+)$/.exec(asset.path)?.[1];
        // Unknown asset layouts still receive a managed copy and can be referenced by their archive path.
        const metadata = await blobs.importBytes(asset.bytes, {
          mimeType: asset.mimeType,
          owner: stageOwner,
        });
        stagedBlobs.push(metadata.id);
        blobMap.set(asset.path, metadata.id);
        if (oldId) blobMap.set(oldId, metadata.id);
      }
      const remap = (value: unknown): unknown =>
        mapValue(value, (key, item) => {
          if (typeof item !== "string") return item;
          if (BLOB_KEYS.has(key)) {
            const mapped = blobMap.get(bareBlobId(item));
            if (!mapped)
              throw new ArchiveValidationError(
                "Archive is missing a required managed asset",
              );
            return item.startsWith("blob:") ? `blob:${mapped}` : mapped;
          }
          if (key === "attachmentId") {
            const mapped = attachmentMap.get(item);
            if (!mapped)
              throw new ArchiveValidationError(
                "Archive is missing a required attachment descriptor",
              );
            return mapped;
          }
          if (["messageId", "participantId", "runId"].includes(key))
            return ids.get(item) ?? null;
          return item;
        });
      const prepared = input.map((conversation) => ({
        ...conversation,
        id: ids.get(conversation.id)!,
        messages: conversation.messages.map((message) => ({
          ...message,
          id: ids.get(message.id)!,
          parts: remap(clean(message.parts)) as unknown[],
          variants: (message.variants ?? []).map((variant) => ({
            ...variant,
            id: ids.get(variant.id)!,
            parts: remap(clean(variant.parts)) as unknown[],
          })),
        })),
      }));
      const timestamp = now();
      await db.withTransactionAsync(async (transaction) => {
        const scopedDb = transaction ?? db;
        const scopedBlobs = blobs.withDatabase(scopedDb);
        const scopedAttachments = attachments!.withDatabase(
          scopedDb,
          scopedBlobs,
        );
        for (const descriptor of descriptors) {
          const blobRef = blobMap.get(descriptor.blobRef);
          if (!blobRef)
            throw new ArchiveValidationError(
              "Attachment bytes are missing from archive",
            );
          const stored = await scopedBlobs.read(blobRef);
          if (
            stored.metadata.byteLength !== descriptor.byteLength ||
            stored.metadata.sha256 !== descriptor.sha256
          )
            throw new ArchiveValidationError(
              "Attachment bytes do not match their descriptor",
            );
          const previewRef = descriptor.previewRef
            ? blobMap.get(descriptor.previewRef)
            : undefined;
          if (descriptor.previewRef && !previewRef)
            throw new ArchiveValidationError(
              "Attachment preview is missing from archive",
            );
          await scopedAttachments.save({
            ...descriptor,
            id: attachmentMap.get(descriptor.id)!,
            blobRef,
            ...(previewRef ? { previewRef } : {}),
          });
        }
        for (const conversation of prepared) {
          importedIds.push(conversation.id);
          await scopedDb.runAsync(
            "INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)",
            conversation.id,
            conversation.title,
            conversation.createdAt ?? timestamp,
            conversation.updatedAt ?? timestamp,
          );
          await scopedDb.runAsync(
            "INSERT INTO chat_history_metadata (conversation_id) VALUES (?)",
            conversation.id,
          );
          for (const [sequence, message] of conversation.messages.entries()) {
            await scopedDb.runAsync(
              "INSERT INTO messages (id,conversation_id,role,parts_json,sequence,created_at) VALUES (?,?,?,?,?,?)",
              message.id,
              conversation.id,
              message.role,
              JSON.stringify(message.parts),
              sequence,
              timestamp,
            );
            for (const [generation, variant] of message.variants.entries()) {
              await scopedDb.runAsync(
                "INSERT INTO response_variants (id,message_id,generation,content_json,model_id,created_at,selected) VALUES (?,?,?,?,?,?,?)",
                variant.id,
                message.id,
                generation,
                JSON.stringify(variant.parts),
                "archive:unknown",
                timestamp,
                variant.selected ? 1 : 0,
              );
            }
            const attachmentRefs = new Set<string>();
            const blobRefs = new Set<string>();
            visit([message.parts, message.variants], (key, value) => {
              if (typeof value !== "string") return;
              if (key === "attachmentId") attachmentRefs.add(value);
              if (BLOB_KEYS.has(key)) blobRefs.add(bareBlobId(value));
            });
            for (const id of attachmentRefs) {
              await scopedAttachments.retain(
                `conversation:${conversation.id}`,
                id,
              );
              await scopedAttachments.retain(`message:${message.id}`, id);
            }
            for (const id of blobRefs)
              await scopedBlobs.addReference(id, {
                ownerType: "message",
                ownerId: message.id,
              });
          }
        }
      });
    } finally {
      // Committed references keep imported bytes; rejected imports discard only their staged copies.
      for (const id of stagedBlobs) await blobs.removeReference(id, stageOwner);
    }
    await options.onImported?.(importedIds);
    return importedIds;
  }

  return {
    async readPickedJson() {
      const bytes = await files.pick("json", MAX_JSON_BYTES);
      if (!bytes) return undefined;
      if (bytes.byteLength > MAX_JSON_BYTES)
        throw new ArchiveValidationError(
          "LM Studio export exceeds the 32 MiB limit",
        );
      return decoder.decode(bytes);
    },
    async saveImported(conversations) {
      await save(conversations);
    },
    async exportSelected(kind) {
      const selectedId = options.selectedConversationId();
      if (!selectedId)
        throw new ArchiveValidationError("Select a chat to export");
      const conversation = (await readConversations(selectedId))[0];
      if (!conversation)
        throw new ArchiveValidationError("The selected chat is unavailable");
      const bytes =
        kind === "txt"
          ? exportConversationTxt(conversation)
          : options.pdf
            ? await options.pdf.render(conversation)
            : exportConversationPdf(conversation);
      await files.share({
        name: `chat-${selectedId}.${kind}`,
        mimeType: kind === "txt" ? "text/plain" : "application/pdf",
        bytes,
      });
    },
    async exportAll() {
      const conversations = await readConversations();
      const bytes = await exportAllChatsZip(
        conversations,
        await requiredAssets(conversations),
        zip,
        now(),
      );
      await files.share({
        name: "locallab-chats.zip",
        mimeType: "application/zip",
        bytes,
      });
    },
    async importAll() {
      const bytes = await files.pick("zip", MAX_ZIP_BYTES);
      if (!bytes) return 0;
      const imported = await importAllChatsZip(bytes, zip);
      return (await save(imported.conversations, imported.assets)).length;
    },
  };
}

function bareBlobId(value: string): string {
  return value.startsWith("blob:") ? value.slice(5) : value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function visit(
  value: unknown,
  fn: (key: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visit(item, fn));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    fn(key, item);
    visit(item, fn);
  }
}
function mapValue(
  value: unknown,
  fn: (key: string, value: unknown) => unknown,
): unknown {
  if (Array.isArray(value)) return value.map((item) => mapValue(item, fn));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      mapValue(fn(key, item), fn),
    ]),
  );
}
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, item]) => [key, clean(item)]),
  );
}
function validateConversations(
  input: unknown,
): asserts input is readonly ArchiveConversation[] {
  if (!Array.isArray(input) || input.length > 20_000)
    throw new ArchiveValidationError("Invalid archive conversation list");
  const ids = new Set<string>();
  const checkId = (id: unknown) => {
    if (typeof id !== "string" || !id || id.length > 512 || ids.has(id))
      throw new ArchiveValidationError(
        "Archive identifiers are missing or duplicated",
      );
    ids.add(id);
  };
  let messages = 0;
  for (const conversation of input) {
    if (
      !isRecord(conversation) ||
      typeof conversation.title !== "string" ||
      !Array.isArray(conversation.messages)
    )
      throw new ArchiveValidationError("Invalid archived conversation");
    checkId(conversation.id);
    for (const message of conversation.messages) {
      if (
        !isRecord(message) ||
        !["system", "developer", "user", "assistant", "tool"].includes(
          String(message.role),
        ) ||
        !Array.isArray(message.parts)
      )
        throw new ArchiveValidationError("Invalid archived message");
      checkId(message.id);
      if (++messages > 200_000)
        throw new ArchiveValidationError("Archive has too many messages");
      if (message.variants === undefined) continue;
      if (!Array.isArray(message.variants))
        throw new ArchiveValidationError("Invalid response variants");
      let selected = 0;
      for (const variant of message.variants) {
        if (
          !isRecord(variant) ||
          !Array.isArray(variant.parts) ||
          (variant.selected !== undefined &&
            typeof variant.selected !== "boolean")
        )
          throw new ArchiveValidationError("Invalid response variant");
        checkId(variant.id);
        if (variant.selected && ++selected > 1)
          throw new ArchiveValidationError(
            "A message has multiple selected variants",
          );
      }
    }
  }
}
function validateDescriptor(value: unknown): ArchiveAttachmentDescriptor {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.blobRef !== "string" ||
    typeof value.name !== "string" ||
    typeof value.mimeType !== "string" ||
    !["image", "markdown", "text", "pdf", "xlsx"].includes(
      String(value.kind),
    ) ||
    !Number.isSafeInteger(value.byteLength) ||
    Number(value.byteLength) < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(value.sha256) ||
    !(
      value.extractedText === null || typeof value.extractedText === "string"
    ) ||
    !isRecord(value.metadata) ||
    (value.previewRef !== undefined && typeof value.previewRef !== "string")
  )
    throw new ArchiveValidationError("Invalid archived attachment descriptor");
  return clean(value) as unknown as ArchiveAttachmentDescriptor;
}
