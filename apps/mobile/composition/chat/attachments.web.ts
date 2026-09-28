import {
  ChatAttachmentIntakeError,
  SQLiteChatAttachments,
  prepareChatAttachments,
  type PrepareChatAttachmentsInput,
} from "@locallab/chat-integration";
import {
  AttachmentError,
  type AttachmentDescriptor,
  type ExtractionPort,
  type PickedAttachment,
} from "@locallab/attachments";
import type { BlobStore } from "@locallab/storage-blobs";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { MobileChatAttachmentIntake } from "./attachments";
import { browserFileMime, pickBrowserFile } from "./attachments-browser";

const MANAGED_URI = "locallab-attachment:";
const pickedUrls = new Set<string>();
const DOCUMENT_TYPES =
  "text/plain,text/markdown,text/x-markdown,.txt,.md,application/pdf,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,image/*";

/** The chooser supplies real File bytes; intake owns them before this temporary URL is revoked. */
export function createExpoChatAttachmentSource() {
  async function pick(
    accept: string,
    signal?: AbortSignal,
    capture?: string,
  ): Promise<PickedAttachment | undefined> {
    const file = await pickBrowserFile(accept, signal, capture);
    signal?.throwIfAborted();
    if (!file) return undefined;
    const sourceUri = URL.createObjectURL(file);
    pickedUrls.add(sourceUri);
    return {
      name: file.name,
      mimeType: file.type || browserFileMime(file.name),
      byteLength: file.size,
      sourceUri,
      metadata: {
        source: capture ? "camera" : "browser-file-picker",
        lastModified: file.lastModified,
      },
    };
  }
  return {
    pickFile: (signal?: AbortSignal) => pick(DOCUMENT_TYPES, signal),
    pickImage: (signal?: AbortSignal) => pick("image/*", signal),
    takePhoto: (signal?: AbortSignal) => pick("image/*", signal, "environment"),
  };
}

export function createExpoChatAttachmentExtraction(
  codecs: Partial<Pick<ExtractionPort, "pdf" | "xlsx">> = {},
  readManaged?: (id: string) => Promise<Uint8Array>,
): ExtractionPort {
  return {
    async text(uri, maximumBytes, maximumCharacters, signal) {
      signal.throwIfAborted();
      let bytes: Uint8Array;
      if (uri.startsWith(MANAGED_URI) && readManaged) {
        bytes = await readManaged(uri.slice(MANAGED_URI.length));
      } else {
        if (!/^(blob:|data:)/.test(uri))
          throw new AttachmentError("Attachment URL is unavailable", "missing");
        const response = await fetch(uri, { signal });
        if (!response.ok)
          throw new AttachmentError(
            "Attachment bytes are unavailable",
            "missing",
          );
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      signal.throwIfAborted();
      if (bytes.length > maximumBytes)
        throw new AttachmentError(
          "Attachment exceeds its extraction size limit",
          "too-large",
        );
      try {
        return new TextDecoder("utf-8", { fatal: true })
          .decode(bytes)
          .slice(0, maximumCharacters);
      } catch {
        throw new AttachmentError(
          "Save the document as UTF-8 text and retry",
          "extract-failed",
        );
      }
    },
    pdf:
      codecs.pdf ??
      (async () => {
        throw new AttachmentError(
          "PDF text extraction is unavailable in this app build",
          "extract-failed",
        );
      }),
    xlsx:
      codecs.xlsx ??
      (async () => {
        throw new AttachmentError(
          "Spreadsheet text extraction is unavailable in this app build",
          "extract-failed",
        );
      }),
  };
}

/** Internal managed URIs are resolved from BlobStore, never from a device filesystem path. */
class BrowserChatAttachments extends SQLiteChatAttachments {
  constructor(
    db: SQLiteDatabasePort,
    private readonly browserBlobs: BlobStore,
    private readonly createId?: () => string,
    private readonly onCollected?: (ref: string) => void,
  ) {
    super(db, browserBlobs, createId ? { createId } : {});
  }
  override withDatabase(
    db: SQLiteDatabasePort,
    blobs: BlobStore,
  ): BrowserChatAttachments {
    return new BrowserChatAttachments(
      db,
      blobs,
      this.createId,
      this.onCollected,
    );
  }
  override async release(ownerId: string, id: string): Promise<void> {
    const descriptor = await this.get(id);
    await super.release(ownerId, id);
    if (descriptor) {
      for (const ref of new Set([
        descriptor.blobRef,
        ...(descriptor.previewRef ? [descriptor.previewRef] : []),
      ])) {
        if (!(await this.getManaged(ref))) this.onCollected?.(ref);
      }
    }
  }
  override async getManaged(ref: string) {
    const metadata = (await this.browserBlobs.list()).find(
      (blob) => blob.id === ref,
    );
    return metadata
      ? {
          uri: `${MANAGED_URI}${ref}`,
          mimeType: metadata.mimeType,
          byteLength: metadata.byteLength,
        }
      : undefined;
  }
}

export async function createMobileChatAttachmentIntake(options: {
  readonly db: SQLiteDatabasePort;
  readonly blobs: BlobStore;
  readonly extraction?: ExtractionPort;
  readonly source?: ReturnType<typeof createExpoChatAttachmentSource>;
  readonly createId?: () => string;
}): Promise<MobileChatAttachmentIntake> {
  const previews = new Map<string, { uri: string; bytes: number }>();
  const attachments = new BrowserChatAttachments(
    options.db,
    options.blobs,
    options.createId,
    (ref) => {
      const preview = previews.get(ref);
      if (preview) URL.revokeObjectURL(preview.uri);
      previews.delete(ref);
    },
  );
  await attachments.initialize();
  const source = options.source ?? createExpoChatAttachmentSource();
  const withReadableUri = async <T>(
    uri: string,
    signal: AbortSignal,
    work: (uri: string) => Promise<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    if (!uri.startsWith(MANAGED_URI)) return work(uri);
    const saved = await options.blobs.read(uri.slice(MANAGED_URI.length));
    signal.throwIfAborted();
    const temporary = URL.createObjectURL(
      new Blob([Uint8Array.from(saved.bytes)], {
        type: saved.metadata.mimeType,
      }),
    );
    try {
      return await work(temporary);
    } finally {
      URL.revokeObjectURL(temporary);
    }
  };
  const extraction = options.extraction
    ? {
        text: (
          uri: string,
          maxBytes: number,
          maxCharacters: number,
          signal: AbortSignal,
        ) =>
          withReadableUri(uri, signal, (readable) =>
            options.extraction!.text(readable, maxBytes, maxCharacters, signal),
          ),
        pdf: (
          uri: string,
          bounds: Parameters<ExtractionPort["pdf"]>[1],
          signal: AbortSignal,
        ) =>
          withReadableUri(uri, signal, (readable) =>
            options.extraction!.pdf(readable, bounds, signal),
          ),
        xlsx: (
          uri: string,
          bounds: Parameters<ExtractionPort["xlsx"]>[1],
          signal: AbortSignal,
        ) =>
          withReadableUri(uri, signal, (readable) =>
            options.extraction!.xlsx(readable, bounds, signal),
          ),
      }
    : createExpoChatAttachmentExtraction(
        {},
        async (id) => (await options.blobs.read(id)).bytes,
      );
  let disposed = false;
  const assertOpen = () => {
    if (disposed)
      throw new AttachmentError(
        "Attachment intake is closed. Reopen the chat and try again.",
        "missing",
      );
  };
  const clearPreviews = () => {
    for (const preview of previews.values()) URL.revokeObjectURL(preview.uri);
    previews.clear();
  };
  const dispose = () => {
    disposed = true;
    clearPreviews();
    globalThis.removeEventListener?.("pagehide", clearPreviews);
  };
  globalThis.addEventListener?.("pagehide", clearPreviews);
  const intake = async (
    picked: PickedAttachment | undefined,
    ownerId: string,
    signal?: AbortSignal,
  ) => {
    if (!picked) return undefined;
    try {
      assertOpen();
      return await attachments.importPicked(
        picked,
        ownerId,
        extraction,
        signal ? { signal } : {},
      );
    } catch (cause) {
      if (
        cause instanceof ChatAttachmentIntakeError &&
        cause.code === "extract-failed" &&
        cause.attachment &&
        !options.extraction
      ) {
        const kind = cause.attachment.kind;
        const detail =
          kind === "pdf"
            ? "PDF text extraction is unavailable in this browser build."
            : kind === "xlsx"
              ? "Spreadsheet text extraction is unavailable in this browser build."
              : "Save the document as UTF-8 text and choose it again.";
        throw new ChatAttachmentIntakeError(
          "extract-failed",
          `${detail} The original file is retained; remove it before sending.`,
          cause.attachment,
        );
      }
      throw cause;
    } finally {
      if (pickedUrls.delete(picked.sourceUri))
        URL.revokeObjectURL(picked.sourceUri);
    }
  };
  return {
    attachments,
    dispose,
    isManagedPreviewUri: (uri) =>
      [...previews.values()].some((preview) => preview.uri === uri),
    pickFile: async (owner, signal) =>
      intake(await source.pickFile(signal), owner, signal),
    pickImage: async (owner, signal) =>
      intake(await source.pickImage(signal), owner, signal),
    takePhoto: async (owner, signal) =>
      intake(await source.takePhoto(signal), owner, signal),
    prepare: (input: PrepareChatAttachmentsInput) =>
      prepareChatAttachments(attachments, input),
    async preview(id) {
      assertOpen();
      const descriptor = await attachments.get(id);
      if (!descriptor)
        throw new AttachmentError("Attachment is unavailable", "missing");
      const ref = descriptor.previewRef ?? descriptor.blobRef;
      let preview = previews.get(ref);
      if (!preview) {
        const saved = await options.blobs.read(ref);
        assertOpen();
        // Preview URLs are bounded and can always be rebuilt from persistent bytes.
        let retained = [...previews.values()].reduce(
          (sum, item) => sum + item.bytes,
          0,
        );
        for (const [oldRef, old] of previews) {
          if (
            previews.size < 12 &&
            retained + saved.bytes.length <= 64 * 1024 * 1024
          )
            break;
          URL.revokeObjectURL(old.uri);
          previews.delete(oldRef);
          retained -= old.bytes;
        }
        preview = {
          uri: URL.createObjectURL(
            new Blob([Uint8Array.from(saved.bytes)], {
              type: descriptor.mimeType,
            }),
          ),
          bytes: saved.bytes.length,
        };
        previews.set(ref, preview);
      }
      return {
        uri: preview.uri,
        mimeType: descriptor.mimeType,
        name: descriptor.name,
      };
    },
  };
}

export type { MobileChatAttachmentIntake } from "./attachments";
