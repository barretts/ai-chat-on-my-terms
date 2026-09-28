import {
  AttachmentDescriptorSchema,
  AttachmentError,
  DEFAULT_LIMITS,
  ingestAttachment,
  retainAttachments,
  type AttachmentBlobPort,
  type AttachmentDescriptor,
  type AttachmentLimits,
  type ExtractionPort,
  type PickedAttachment,
} from "@locallab/attachments";
import type { CapabilityMap } from "@locallab/contracts/ports";
import type { RunEvent, RunRequest } from "@locallab/contracts/run-events";
import type { BlobStore } from "@locallab/storage-blobs";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type {
  SQLiteSemanticSearch,
  SearchTranscript,
} from "@locallab/search-semantic";
import type { SQLiteGenerationLifecycle } from "@locallab/generation-lifecycle-ios";
import type { ChatFeatureBindings, IntegratedRunHandle } from "./index";

export type ChatUserPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image" | "file"; readonly attachmentId: string };
export interface ChatContextPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export class ChatAttachmentIntakeError extends Error {
  constructor(
    readonly code: "canceled" | "extract-failed" | "import-failed",
    message: string,
    readonly attachment?: AttachmentDescriptor,
  ) {
    super(message);
    this.name = "ChatAttachmentIntakeError";
  }
}

/** Durable attachment descriptors and owners over the same managed BlobStore as models. */
export class SQLiteChatAttachments implements AttachmentBlobPort {
  constructor(
    private readonly db: SQLiteDatabasePort,
    private readonly blobs: BlobStore,
    private readonly options: {
      createId?: () => string;
      managedUri?: (managedPath: string) => string;
    } = {},
  ) {}

  /** Bind helper calls to the explicit connection owned by an archive transaction. */
  withDatabase(
    db: SQLiteDatabasePort,
    blobs: BlobStore,
  ): SQLiteChatAttachments {
    return new SQLiteChatAttachments(db, blobs, this.options);
  }

  async initialize(): Promise<void> {
    await this.db.execAsync(`
      CREATE TABLE IF NOT EXISTS chat_attachments (
        id TEXT PRIMARY KEY NOT NULL,
        blob_ref TEXT NOT NULL REFERENCES managed_blobs(id) ON DELETE CASCADE,
        descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json))
      );
      CREATE TABLE IF NOT EXISTS chat_attachment_owners (
        owner_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL REFERENCES chat_attachments(id) ON DELETE CASCADE,
        PRIMARY KEY(owner_id,attachment_id)
      );
      CREATE INDEX IF NOT EXISTS chat_attachment_blob ON chat_attachments(blob_ref);
    `);
  }

  async importManaged(sourceUri: string, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const blob = await this.blobs.importExternal(sourceUri, {
      owner: { ownerType: "other", ownerId: `attachment:${id}` },
    });
    return {
      blobRef: blob.id,
      sha256: blob.sha256,
      byteLength: blob.byteLength,
    };
  }

  async getManaged(ref: string) {
    const metadata = (await this.blobs.list()).find((blob) => blob.id === ref);
    if (!metadata) return undefined;
    return {
      uri:
        this.options.managedUri?.(metadata.managedPath) ?? metadata.managedPath,
      mimeType: metadata.mimeType,
      byteLength: metadata.byteLength,
    };
  }

  async save(value: AttachmentDescriptor): Promise<void> {
    const descriptor = AttachmentDescriptorSchema.parse(value);
    const blob = (await this.blobs.list()).find(
      (item) => item.id === descriptor.blobRef,
    );
    if (
      !blob ||
      blob.byteLength !== descriptor.byteLength ||
      blob.sha256 !== descriptor.sha256
    )
      throw new AttachmentError(
        "Attachment does not match its managed blob",
        "invalid",
      );
    if (
      descriptor.previewRef &&
      !(await this.getManaged(descriptor.previewRef))
    )
      throw new AttachmentError("Attachment preview is unavailable", "missing");
    const existing = await this.get(descriptor.id);
    if (existing && existing.blobRef !== descriptor.blobRef)
      throw new AttachmentError(
        "An attachment ID cannot replace its managed blob",
        "invalid",
      );
    await this.db.runAsync(
      "INSERT INTO chat_attachments(id,blob_ref,descriptor_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET descriptor_json=excluded.descriptor_json",
      descriptor.id,
      descriptor.blobRef,
      JSON.stringify(descriptor),
    );
  }

  async get(id: string): Promise<AttachmentDescriptor | undefined> {
    const row = await this.db.getFirstAsync<{ descriptor_json: string }>(
      "SELECT descriptor_json FROM chat_attachments WHERE id=?",
      id,
    );
    return row
      ? AttachmentDescriptorSchema.parse(JSON.parse(row.descriptor_json))
      : undefined;
  }

  async listForOwner(ownerId: string): Promise<AttachmentDescriptor[]> {
    const rows = await this.db.getAllAsync<{ descriptor_json: string }>(
      "SELECT a.descriptor_json FROM chat_attachments a JOIN chat_attachment_owners o ON o.attachment_id=a.id WHERE o.owner_id=? ORDER BY a.id",
      ownerId,
    );
    return rows.map((row) =>
      AttachmentDescriptorSchema.parse(JSON.parse(row.descriptor_json)),
    );
  }

  async retain(ownerId: string, id: string): Promise<void> {
    if (!ownerId.trim() || ownerId.length > 512)
      throw new AttachmentError(
        "A durable attachment owner is required",
        "invalid",
      );
    const descriptor = await this.get(id);
    if (!descriptor)
      throw new AttachmentError("Attachment is unavailable", "missing");
    await this.blobs.addReference(descriptor.blobRef, blobOwner(ownerId));
    if (descriptor.previewRef)
      await this.blobs.addReference(descriptor.previewRef, blobOwner(ownerId));
    await this.db.runAsync(
      "INSERT INTO chat_attachment_owners(owner_id,attachment_id) VALUES(?,?) ON CONFLICT DO NOTHING",
      ownerId,
      id,
    );
    await this.blobs.removeReference(descriptor.blobRef, {
      ownerType: "other",
      ownerId: `attachment:${id}`,
    });
  }

  async release(ownerId: string, id: string): Promise<void> {
    const descriptor = await this.get(id);
    if (!descriptor) return;
    await this.db.runAsync(
      "DELETE FROM chat_attachment_owners WHERE owner_id=? AND attachment_id=?",
      ownerId,
      id,
    );
    // Another descriptor or preview sharing these bytes may still have the same owner.
    for (const ref of new Set([
      descriptor.blobRef,
      ...(descriptor.previewRef ? [descriptor.previewRef] : []),
    ])) {
      const remaining = await this.db.getFirstAsync<{ id: string }>(
        "SELECT a.id FROM chat_attachments a JOIN chat_attachment_owners o ON o.attachment_id=a.id WHERE (a.blob_ref=? OR json_extract(a.descriptor_json,'$.previewRef')=?) AND o.owner_id=? LIMIT 1",
        ref,
        ref,
        ownerId,
      );
      if (!remaining) await this.blobs.removeReference(ref, blobOwner(ownerId));
    }
  }

  async read(id: string) {
    const descriptor = await this.get(id);
    if (!descriptor)
      throw new AttachmentError("Attachment is unavailable", "missing");
    return this.blobs.read(descriptor.blobRef);
  }

  /** Import owns the bytes before any cancellable parser runs; failed parses return the retained descriptor. */
  async importPicked(
    picked: PickedAttachment,
    ownerId: string,
    extraction: ExtractionPort,
    options: { signal?: AbortSignal; limits?: AttachmentLimits } = {},
  ): Promise<AttachmentDescriptor> {
    if (!ownerId.trim() || ownerId.length > 512)
      throw new AttachmentError(
        "A durable attachment owner is required",
        "invalid",
      );
    let id: string | undefined;
    const ports = {
      ids: {
        next: () =>
          (id = this.options.createId?.() ?? globalThis.crypto.randomUUID()),
      },
      extraction,
      blobs: {
        importManaged: async (
          uri: string,
          attachmentId: string,
          signal?: AbortSignal,
        ) => {
          signal?.throwIfAborted();
          const blob = await this.blobs.importExternal(uri, {
            mimeType: picked.mimeType,
            owner: blobOwner(ownerId),
          });
          void attachmentId;
          return {
            blobRef: blob.id,
            sha256: blob.sha256,
            byteLength: blob.byteLength,
          };
        },
        getManaged: (ref: string) => this.getManaged(ref),
        save: async (descriptor: AttachmentDescriptor) => {
          await this.save(descriptor);
          await this.retain(ownerId, descriptor.id);
        },
        get: (attachmentId: string) => this.get(attachmentId),
        retain: (owner: string, attachmentId: string) =>
          this.retain(owner, attachmentId),
        release: (owner: string, attachmentId: string) =>
          this.release(owner, attachmentId),
      } satisfies AttachmentBlobPort,
    };
    try {
      return await ingestAttachment(picked, ports, options);
    } catch (error) {
      const attachment = id ? await this.get(id) : undefined;
      if (!attachment) throw error;
      throw new ChatAttachmentIntakeError(
        options.signal?.aborted ? "canceled" : "extract-failed",
        options.signal?.aborted
          ? "Attachment processing was canceled. The original file is retained."
          : "Attachment text could not be read. The original file is retained; retry or remove it before sending.",
        attachment,
      );
    }
  }
}

export interface PrepareChatAttachmentsInput {
  readonly refs: readonly string[];
  readonly text: string;
  readonly capabilities: CapabilityMap;
  readonly transport: "openai-responses" | "chat-completions" | "text";
  readonly signal?: AbortSignal;
  readonly maxAttachments?: number;
  readonly maxExtractedCharacters?: number;
  readonly maxImageBytes?: number;
  readonly maxCombinedImageBytes?: number;
  readonly acceptedImageMimeTypes?: readonly string[];
}

export interface PreparedChatAttachments {
  readonly attachmentRefs: readonly string[];
  readonly userParts: readonly ChatUserPart[];
  readonly contextParts: readonly ChatContextPart[];
  readonly providerContext: RunRequest["context"];
  readonly truncatedAttachmentIds: readonly string[];
}

/** Preserve display parts and refs while preparing bounded, explicit provider context. */
export async function prepareChatAttachments(
  attachments: Pick<SQLiteChatAttachments, "get" | "read">,
  input: PrepareChatAttachmentsInput,
): Promise<PreparedChatAttachments> {
  const refs = [...new Set(input.refs)];
  const maxAttachments = positiveBound(
    input.maxAttachments ?? 12,
    32,
    "attachment count",
  );
  const maxCharacters = positiveBound(
    input.maxExtractedCharacters ?? 64_000,
    DEFAULT_LIMITS.maxExtractedCharacters,
    "extracted text limit",
  );
  const maxImageBytes = positiveBound(
    input.maxImageBytes ?? 10 * 1024 * 1024,
    DEFAULT_LIMITS.maxImageBytes,
    "image size limit",
  );
  const maxTotal = positiveBound(
    input.maxCombinedImageBytes ?? 30 * 1024 * 1024,
    100 * 1024 * 1024,
    "combined image size limit",
  );
  if (refs.length > maxAttachments)
    throw new AttachmentError(
      `Attach up to ${maxAttachments} files per message`,
      "too-large",
    );
  const userParts: ChatUserPart[] = input.text
    ? [{ type: "text", text: input.text }]
    : [];
  const contextParts: ChatContextPart[] = input.text
    ? [{ type: "text", text: input.text }]
    : [];
  const providerParts: Record<string, unknown>[] = input.text
    ? [textPart(input.text, input.transport)]
    : [];
  const truncatedAttachmentIds: string[] = [];
  let remainingCharacters = maxCharacters;
  let imageBytes = 0;
  for (const ref of refs) {
    input.signal?.throwIfAborted();
    const item = await attachments.get(ref);
    if (!item)
      throw new AttachmentError("An attached file is unavailable", "missing");
    userParts.push({
      type: item.kind === "image" ? "image" : "file",
      attachmentId: item.id,
    });
    if (item.kind === "image") {
      if (input.capabilities.vision !== "yes" || input.transport === "text")
        throw new AttachmentError(
          "This model has no verified image support. Select an image-capable model or remove the image.",
          "vision-unsupported",
        );
      const accepted = input.acceptedImageMimeTypes ?? [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
      ];
      if (!accepted.includes(item.mimeType))
        throw new AttachmentError(
          "Convert the image to a format supported by the selected model",
          "vision-unsupported",
        );
      imageBytes += item.byteLength;
      if (item.byteLength > maxImageBytes || imageBytes > maxTotal)
        throw new AttachmentError(
          "Images exceed the selected model size limit. Compress a copy or remove an image.",
          "too-large",
        );
      const stored = await attachments.read(item.id);
      input.signal?.throwIfAborted();
      if (stored.bytes.byteLength !== item.byteLength)
        throw new AttachmentError(
          "Attachment bytes no longer match the saved image",
          "invalid",
        );
      const dataUrl = `data:${item.mimeType};base64,${base64(stored.bytes)}`;
      contextParts.push({
        type: "image",
        attachmentId: item.id,
        byteLength: item.byteLength,
      });
      providerParts.push(
        input.transport === "openai-responses"
          ? { type: "input_image", image_url: dataUrl, detail: "auto" }
          : { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
      );
    } else {
      if (item.extractedText === null)
        throw new AttachmentError(
          "Attachment text is unavailable. Retry processing or remove the file before sending.",
          "extract-failed",
        );
      const text = item.extractedText.slice(0, remainingCharacters);
      if (text.length < item.extractedText.length)
        truncatedAttachmentIds.push(item.id);
      remainingCharacters -= text.length;
      const content = `[Attachment: ${item.name}]\n${text}`;
      contextParts.push({ type: "text", text: content, attachmentId: item.id });
      providerParts.push(textPart(content, input.transport));
    }
  }
  const content =
    input.transport === "text"
      ? contextParts
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n\n")
      : { content: providerParts };
  return {
    attachmentRefs: refs,
    userParts,
    contextParts,
    providerContext: [{ kind: "user", value: content }],
    truncatedAttachmentIds,
  };
}

function positiveBound(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`Invalid ${label}`);
  return value;
}

function textPart(
  text: string,
  transport: PrepareChatAttachmentsInput["transport"],
) {
  return {
    type: transport === "openai-responses" ? "input_text" : "text",
    text,
  };
}

function base64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: string[] = [];
  let chunk: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!,
      b = bytes[i + 1],
      c = bytes[i + 2];
    chunk.push(
      alphabet[a >>> 2]! +
        alphabet[((a & 3) << 4) | ((b ?? 0) >>> 4)]! +
        (b === undefined
          ? "="
          : alphabet[((b & 15) << 2) | ((c ?? 0) >>> 6)]!) +
        (c === undefined ? "=" : alphabet[c & 63]!),
    );
    if (chunk.length === 8192) {
      out.push(chunk.join(""));
      chunk = [];
    }
  }
  if (chunk.length) out.push(chunk.join(""));
  return out.join("");
}

function blobOwner(ownerId: string) {
  return {
    ownerType: ownerId.startsWith("message:")
      ? ("message" as const)
      : ("other" as const),
    ownerId,
  };
}

/** Only the currently selected saved variant contributes user-visible text to search. */
export async function readSelectedSearchSnapshot(
  db: SQLiteDatabasePort,
  signal?: AbortSignal,
  maximumMessages = 50_000,
): Promise<SearchTranscript[]> {
  positiveBound(maximumMessages, 1_000_000, "search snapshot limit");
  signal?.throwIfAborted();
  const rows = await db.getAllAsync<{
    conversation_id: string;
    message_id: string;
    role: string;
    parts_json: string;
    variant_id: string | null;
    variant_json: string | null;
    updated_at: string;
  }>(
    `SELECT m.conversation_id,m.id AS message_id,m.role,m.parts_json,
      v.id AS variant_id,v.content_json AS variant_json,
      COALESCE(v.created_at,c.updated_at) AS updated_at
     FROM messages m JOIN conversations c ON c.id=m.conversation_id
     LEFT JOIN response_variants v ON v.message_id=m.id AND v.selected=1
     LEFT JOIN runs r ON r.id=m.run_id
     WHERE m.role IN ('user','assistant')
       AND (m.role='user' OR m.run_id IS NULL OR r.status IN ('completed','canceled','failed'))
     ORDER BY c.id,m.sequence LIMIT ?`,
    maximumMessages + 1,
  );
  if (rows.length > maximumMessages)
    throw new RangeError(
      "Search snapshot exceeds its message limit; existing index is preserved",
    );
  const snapshot: SearchTranscript[] = [];
  for (const row of rows) {
    signal?.throwIfAborted();
    const parts: unknown = JSON.parse(row.variant_json ?? row.parts_json);
    const text = Array.isArray(parts)
      ? parts
          .flatMap((part: unknown) => {
            if (!part || typeof part !== "object") return [];
            const value = part as { type?: unknown; text?: unknown };
            return value.type === "text" && typeof value.text === "string"
              ? [value.text]
              : [];
          })
          .join("\n")
      : "";
    if (!text.trim()) continue;
    snapshot.push({
      conversationId: row.conversation_id,
      messageId: row.message_id,
      variantId: row.variant_id ?? row.message_id,
      role: row.role,
      text,
      active: true,
      updatedAt: row.updated_at,
    });
  }
  return snapshot;
}

export interface SQLiteChatFeatureOptions {
  readonly db: SQLiteDatabasePort;
  readonly attachments: SQLiteChatAttachments;
  readonly search?: Pick<SQLiteSemanticSearch, "reindex">;
  readonly lifecycle?: Pick<
    SQLiteGenerationLifecycle,
    "start" | "get" | "record"
  >;
  readonly onEvent?: ChatFeatureBindings["onEvent"];
}

/** Concrete bindings are shared by sends, reopened messages, and explicit variant selection. */
export function createSQLiteChatFeatureBindings(
  options: SQLiteChatFeatureOptions,
) {
  let indexWork = Promise.resolve();
  const bindings: ChatFeatureBindings = {
    retainAttachments: (ownerId, refs) =>
      retainAttachments(options.attachments, ownerId, refs),
    async onEvent(conversationId, event) {
      if (options.lifecycle) {
        const existing = await options.lifecycle.get(event.runId);
        if (!existing)
          await options.lifecycle.start({
            runId: event.runId,
            conversationId,
            execution: "local",
          });
        await options.lifecycle.record(event);
      }
      await options.onEvent?.(conversationId, event);
    },
    async indexConversation(_conversationId) {
      if (!options.search) return;
      // reindex replaces a global snapshot, so rebuilding one conversation would erase other chats.
      indexWork = indexWork
        .catch(() => {})
        .then(async () => {
          await options.search!.reindex(
            await readSelectedSearchSnapshot(options.db),
          );
        });
      await indexWork;
    },
  };
  return {
    ...bindings,
    async beginRun(
      handle: IntegratedRunHandle,
      conversationId: string,
      execution: "local" | "remote" = "local",
      remoteJobId?: string,
    ) {
      if (!options.lifecycle) return;
      await options.lifecycle.start({
        runId: handle.runId,
        conversationId,
        execution,
        ...(remoteJobId ? { remoteJobId } : {}),
        stop: () => handle.stop(),
      });
    },
  };
}
