import type { ArchiveConversation, ZipPort } from "@locallab/archives";
import type { BlobStore } from "@locallab/storage-blobs";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import type { ArchiveFeaturePorts } from "../../../features/archives";

export interface ArchiveAttachmentDescriptor {
  id: string;
  blobRef: string;
  name: string;
  mimeType: string;
  kind: "image" | "markdown" | "text" | "pdf" | "xlsx";
  byteLength: number;
  sha256: string;
  extractedText: string | null;
  previewRef?: string | undefined;
  metadata: Record<string, unknown>;
}

export interface ArchiveAttachmentsPort {
  withDatabase(
    db: SQLiteDatabasePort,
    blobs: BlobStore,
  ): ArchiveAttachmentsPort;
  get(id: string): Promise<ArchiveAttachmentDescriptor | undefined>;
  save(descriptor: ArchiveAttachmentDescriptor): Promise<void>;
  retain(ownerId: string, id: string): Promise<void>;
}

export interface ArchiveFilePort {
  /** Pickers copy the external document to cache and enforce maxBytes before reading. */
  pick(kind: "json" | "zip", maxBytes: number): Promise<Uint8Array | undefined>;
  share(file: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<void>;
}

export interface ArchivePdfPort {
  render(conversation: ArchiveConversation): Promise<Uint8Array>;
}

export interface MobileArchiveOptions {
  db: SQLiteDatabasePort;
  blobs: BlobStore;
  selectedConversationId(): string | undefined;
  files: ArchiveFilePort;
  zip: ZipPort;
  pdf?: ArchivePdfPort;
  attachments?: ArchiveAttachmentsPort;
  createId?: () => string;
  now?: () => string;
  onImported?: (conversationIds: readonly string[]) => Promise<void> | void;
}

export interface MobileArchivePorts extends ArchiveFeaturePorts {
  importAll(): Promise<number>;
}
