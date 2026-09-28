import { z } from "zod";

export const AttachmentKindSchema = z.enum([
  "image",
  "markdown",
  "text",
  "pdf",
  "xlsx",
]);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;
export const AttachmentDescriptorSchema = z.object({
  id: z.string().uuid(),
  blobRef: z.string().uuid(),
  name: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(128),
  kind: AttachmentKindSchema,
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f\d]{64}$/i),
  extractedText: z.string().nullable(),
  previewRef: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptorSchema>;
export interface AttachmentLimits {
  readonly maxImageBytes: number;
  readonly maxDocumentBytes: number;
  readonly maxExtractedCharacters: number;
  readonly maxPdfPages: number;
  readonly maxXlsxEntries: number;
  readonly maxXlsxUncompressedBytes: number;
}
export const DEFAULT_LIMITS: AttachmentLimits = Object.freeze({
  maxImageBytes: 30 * 1024 * 1024,
  maxDocumentBytes: 50 * 1024 * 1024,
  maxExtractedCharacters: 1_000_000,
  maxPdfPages: 500,
  maxXlsxEntries: 20_000,
  maxXlsxUncompressedBytes: 256 * 1024 * 1024,
});
const MIME_KIND: Readonly<Record<string, AttachmentKind>> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "image/heic": "image",
  "image/heif": "image",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/plain": "text",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};
const EXTENSION_MIME: Readonly<Record<string, string>> = {
  md: "text/markdown",
  txt: "text/plain",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unsupported-type"
      | "too-large"
      | "invalid"
      | "extract-failed"
      | "vision-unsupported"
      | "missing",
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}
export function classifyAttachment(
  mimeType: string,
  name = "",
): AttachmentKind {
  const mime = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const ext = name.toLowerCase().split(".").pop();
  const kind =
    MIME_KIND[mime] ??
    (mime === "application/octet-stream"
      ? MIME_KIND[EXTENSION_MIME[ext ?? ""] ?? ""]
      : undefined);
  if (!kind)
    throw new AttachmentError(
      "Unsupported attachment type: " + (mime || "unknown"),
      "unsupported-type",
    );
  return kind;
}

export interface PickedAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sourceUri: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface AttachmentBlobPort {
  importManaged(
    sourceUri: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<{ blobRef: string; sha256: string; byteLength: number }>;
  getManaged(
    ref: string,
  ): Promise<{ uri: string; mimeType: string; byteLength: number } | undefined>;
  save(descriptor: AttachmentDescriptor): Promise<void>;
  get(id: string): Promise<AttachmentDescriptor | undefined>;
  /** Durable owner links are message/conversation/draft IDs, never transient run IDs. */
  retain(ownerId: string, attachmentId: string): Promise<void>;
  release(ownerId: string, attachmentId: string): Promise<void>;
}
export interface ExtractionPort {
  pdf(
    uri: string,
    bounds: { maxPages: number; maxCharacters: number; maxBytes: number },
    signal: AbortSignal,
  ): Promise<{ text: string; pages: number }>;
  xlsx(
    uri: string,
    bounds: {
      maxEntries: number;
      maxUncompressedBytes: number;
      maxCharacters: number;
    },
    signal: AbortSignal,
  ): Promise<{ text: string; entries: number; uncompressedBytes: number }>;
  text(
    uri: string,
    maxBytes: number,
    maxCharacters: number,
    signal: AbortSignal,
  ): Promise<string>;
}
export interface AttachmentIds {
  next(): string;
}
export interface IngestOptions {
  readonly signal?: AbortSignal;
  readonly limits?: AttachmentLimits;
}

/** Copy into managed storage before extraction; aborting extraction never removes the imported blob. */
export async function ingestAttachment(
  picked: PickedAttachment,
  ports: {
    blobs: AttachmentBlobPort;
    extraction: ExtractionPort;
    ids: AttachmentIds;
  },
  options: IngestOptions = {},
): Promise<AttachmentDescriptor> {
  const kind = classifyAttachment(picked.mimeType, picked.name);
  const limits = options.limits ?? DEFAULT_LIMITS;
  const max = kind === "image" ? limits.maxImageBytes : limits.maxDocumentBytes;
  if (!Number.isSafeInteger(picked.byteLength) || picked.byteLength < 0)
    throw new AttachmentError("Invalid attachment size", "invalid");
  if (picked.byteLength > max)
    throw new AttachmentError(
      "Attachment exceeds the " + Math.round(max / 1048576) + " MB limit",
      "too-large",
    );
  options.signal?.throwIfAborted();
  const id = ports.ids.next();
  const managed = await ports.blobs.importManaged(
    picked.sourceUri,
    id,
    options.signal,
  );
  if (managed.byteLength > max)
    throw new AttachmentError(
      "Attachment exceeds the " + Math.round(max / 1048576) + " MB limit",
      "too-large",
    );
  // Commit a usable managed reference before running cancellable extractors.
  // A canceled parse leaves the original file attached and reopenable.
  const base = AttachmentDescriptorSchema.parse({
    id,
    blobRef: managed.blobRef,
    name: picked.name,
    mimeType: picked.mimeType,
    kind,
    byteLength: managed.byteLength,
    sha256: managed.sha256,
    extractedText: null,
    metadata: picked.metadata ?? {},
  });
  await ports.blobs.save(base);
  let extractedText: string | null = null;
  if (kind !== "image") {
    const stored = await ports.blobs.getManaged(managed.blobRef);
    if (!stored)
      throw new AttachmentError("Managed attachment disappeared", "missing");
    const signal = options.signal ?? new AbortController().signal;
    try {
      if (kind === "pdf") {
        const result = await ports.extraction.pdf(
          stored.uri,
          {
            maxPages: limits.maxPdfPages,
            maxCharacters: limits.maxExtractedCharacters,
            maxBytes: max,
          },
          signal,
        );
        if (result.pages > limits.maxPdfPages)
          throw new Error("PDF page limit exceeded");
        extractedText = result.text.slice(0, limits.maxExtractedCharacters);
      } else if (kind === "xlsx") {
        const result = await ports.extraction.xlsx(
          stored.uri,
          {
            maxEntries: limits.maxXlsxEntries,
            maxUncompressedBytes: limits.maxXlsxUncompressedBytes,
            maxCharacters: limits.maxExtractedCharacters,
          },
          signal,
        );
        if (
          result.entries > limits.maxXlsxEntries ||
          result.uncompressedBytes > limits.maxXlsxUncompressedBytes
        )
          throw new Error("XLSX expansion limit exceeded");
        extractedText = result.text.slice(0, limits.maxExtractedCharacters);
      } else
        extractedText = (
          await ports.extraction.text(
            stored.uri,
            max,
            limits.maxExtractedCharacters,
            signal,
          )
        ).slice(0, limits.maxExtractedCharacters);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AttachmentError(
        error instanceof Error ? error.message : "Attachment extraction failed",
        "extract-failed",
      );
    }
  }
  const descriptor = AttachmentDescriptorSchema.parse({
    ...base,
    extractedText,
  });
  await ports.blobs.save(descriptor);
  return descriptor;
}

export async function retainAttachments(
  blobs: AttachmentBlobPort,
  ownerId: string,
  refs: readonly string[],
): Promise<void> {
  if (!ownerId.trim()) throw new TypeError("Attachment owner is required");
  for (const id of new Set(refs)) {
    if (!(await blobs.get(id)))
      throw new AttachmentError(
        "Attachment " + id + " is unavailable",
        "missing",
      );
    await blobs.retain(ownerId, id);
  }
}
export async function releaseAttachments(
  blobs: AttachmentBlobPort,
  ownerId: string,
  refs: readonly string[],
): Promise<void> {
  for (const id of new Set(refs)) await blobs.release(ownerId, id);
}

export interface VisionCapability {
  readonly images: boolean;
  readonly maxImageBytes?: number;
  readonly acceptedMimeTypes?: readonly string[];
}
export interface VisionImagePart {
  readonly type: "image";
  readonly attachmentId: string;
  readonly blobRef: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly detail: "auto";
}
export async function mapVisionAttachments(
  refs: readonly string[],
  blobs: AttachmentBlobPort,
  capability: VisionCapability,
): Promise<readonly VisionImagePart[]> {
  const images: VisionImagePart[] = [];
  for (const id of refs) {
    const item = await blobs.get(id);
    if (!item)
      throw new AttachmentError(
        "Attachment " + id + " is unavailable",
        "missing",
      );
    if (item.kind !== "image") continue;
    if (!capability.images)
      throw new AttachmentError(
        "The selected model does not accept images",
        "vision-unsupported",
      );
    if (
      capability.maxImageBytes !== undefined &&
      item.byteLength > capability.maxImageBytes
    )
      throw new AttachmentError(
        "Image exceeds this model's size limit",
        "too-large",
      );
    if (
      capability.acceptedMimeTypes &&
      !capability.acceptedMimeTypes.includes(item.mimeType)
    )
      throw new AttachmentError(
        "The model does not accept " + item.mimeType,
        "vision-unsupported",
      );
    images.push({
      type: "image",
      attachmentId: id,
      blobRef: item.blobRef,
      mimeType: item.mimeType,
      byteLength: item.byteLength,
      detail: "auto",
    });
  }
  return images;
}
export interface ImageCompressionPort {
  /** Native implementations preserve orientation, color profile and capture time unless the user opts out. */
  compress(input: {
    uri: string;
    mimeType: string;
    targetBytes: number;
    preserveMetadata: true;
    signal?: AbortSignal;
  }): Promise<{
    uri: string;
    mimeType: string;
    byteLength: number;
    metadataPreserved: boolean;
  }>;
  /** Stores output as a new attachment; original must remain retained and unchanged. */
  replaceManaged(
    originalId: string,
    compressed: { uri: string; mimeType: string; byteLength: number },
    signal?: AbortSignal,
  ): Promise<AttachmentDescriptor>;
}
export type OversizeRetry =
  | {
      readonly state: "retry-offered";
      readonly targetBytes: number;
      readonly attachmentId: string;
      readonly message: string;
    }
  | { readonly state: "ready"; readonly attachment: AttachmentDescriptor };
export async function prepareOversizedImageRetry(input: {
  attachment: AttachmentDescriptor;
  modelMaxBytes: number;
}): Promise<OversizeRetry> {
  if (input.attachment.kind !== "image")
    throw new AttachmentError(
      "Only images can use image compression retry",
      "invalid",
    );
  if (!Number.isSafeInteger(input.modelMaxBytes) || input.modelMaxBytes < 1)
    throw new TypeError("A positive model image limit is required");
  if (input.attachment.byteLength <= input.modelMaxBytes)
    return { state: "ready", attachment: input.attachment };
  return {
    state: "retry-offered",
    targetBytes: input.modelMaxBytes,
    attachmentId: input.attachment.id,
    message:
      "This image is too large for the selected model. Compress a copy and resend?",
  };
}
export async function compressAndResend(input: {
  attachment: AttachmentDescriptor;
  modelMaxBytes: number;
  compressor: ImageCompressionPort;
  signal?: AbortSignal;
}): Promise<AttachmentDescriptor> {
  const offered = await prepareOversizedImageRetry(input);
  if (offered.state !== "retry-offered") return offered.attachment;
  const compressed = await input.compressor.compress({
    uri: input.attachment.blobRef,
    mimeType: input.attachment.mimeType,
    targetBytes: offered.targetBytes,
    preserveMetadata: true,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!compressed.metadataPreserved)
    throw new AttachmentError(
      "Image metadata could not be preserved",
      "invalid",
    );
  if (compressed.byteLength > offered.targetBytes)
    throw new AttachmentError(
      "Compressed image is still too large; the original is unchanged",
      "too-large",
    );
  return input.compressor.replaceManaged(
    input.attachment.id,
    compressed,
    input.signal,
  );
}
