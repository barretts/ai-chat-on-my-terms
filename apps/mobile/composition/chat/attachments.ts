import {
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
import { File, Paths } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";

const DOCUMENT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/*",
];

/** Native pickers return readable cache URIs, then intake copies the original into managed storage. */
export function createExpoChatAttachmentSource() {
  async function pickImage(
    camera: boolean,
    signal?: AbortSignal,
  ): Promise<PickedAttachment | undefined> {
    signal?.throwIfAborted();
    if (camera) {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted)
        throw new AttachmentError(
          "Allow camera access in Settings to take a photo",
          "invalid",
        );
    }
    const options = {
      mediaTypes: ["images"] as ImagePicker.MediaType[],
      allowsEditing: false,
      quality: 1,
      exif: true,
    };
    const result = camera
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
    signal?.throwIfAborted();
    if (result.canceled) return undefined;
    const asset = result.assets[0];
    if (!asset) return undefined;
    const file = new File(asset.uri);
    const size = asset.fileSize ?? file.size;
    if (size === null || !Number.isSafeInteger(size) || size < 0)
      throw new AttachmentError(
        "The selected image size is unavailable",
        "invalid",
      );
    const name = asset.fileName ?? file.name ?? "photo.jpg";
    return {
      name,
      mimeType: asset.mimeType ?? mimeFromName(name),
      byteLength: size,
      sourceUri: asset.uri,
      metadata: {
        width: asset.width,
        height: asset.height,
        ...(asset.exif ? { exif: asset.exif } : {}),
        source: camera ? "camera" : "photo-library",
      },
    };
  }
  return {
    async pickFile(
      signal?: AbortSignal,
    ): Promise<PickedAttachment | undefined> {
      signal?.throwIfAborted();
      const result = await DocumentPicker.getDocumentAsync({
        type: DOCUMENT_TYPES,
        copyToCacheDirectory: true,
        multiple: false,
      });
      signal?.throwIfAborted();
      if (result.canceled) return undefined;
      const asset = result.assets[0];
      if (!asset) return undefined;
      const file = new File(asset.uri);
      const size = asset.size ?? file.size;
      if (size === null || !Number.isSafeInteger(size) || size < 0)
        throw new AttachmentError(
          "The selected file size is unavailable",
          "invalid",
        );
      return {
        name: asset.name,
        mimeType: asset.mimeType ?? mimeFromName(asset.name),
        byteLength: size,
        sourceUri: asset.uri,
        metadata: {
          source: "document-picker",
          lastModified: asset.lastModified,
        },
      };
    },
    pickImage: (signal?: AbortSignal) => pickImage(false, signal),
    takePhoto: (signal?: AbortSignal) => pickImage(true, signal),
  };
}

/** UTF-8 text is available on Expo; native document codecs can be supplied by the host. */
export function createExpoChatAttachmentExtraction(
  codecs: Partial<Pick<ExtractionPort, "pdf" | "xlsx">> = {},
): ExtractionPort {
  return {
    async text(uri, maximumBytes, maximumCharacters, signal) {
      signal.throwIfAborted();
      const file = new File(uri);
      if (file.size === null || file.size > maximumBytes)
        throw new AttachmentError(
          "Attachment exceeds its extraction size limit",
          "too-large",
        );
      const bytes = await file.bytes();
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

export interface MobileChatAttachmentIntake {
  readonly attachments: SQLiteChatAttachments;
  /** Release temporary preview resources when this screen's intake is closed. */
  dispose?(): void;
  /** Recognize only currently retained platform preview URLs. */
  readonly isManagedPreviewUri?: (uri: string) => boolean;
  pickFile(
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<AttachmentDescriptor | undefined>;
  pickImage(
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<AttachmentDescriptor | undefined>;
  takePhoto(
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<AttachmentDescriptor | undefined>;
  prepare(
    input: PrepareChatAttachmentsInput,
  ): ReturnType<typeof prepareChatAttachments>;
  preview(id: string): Promise<{ uri: string; mimeType: string; name: string }>;
}

export async function createMobileChatAttachmentIntake(options: {
  readonly db: SQLiteDatabasePort;
  readonly blobs: BlobStore;
  readonly extraction?: ExtractionPort;
  readonly source?: ReturnType<typeof createExpoChatAttachmentSource>;
  readonly createId?: () => string;
}): Promise<MobileChatAttachmentIntake> {
  const attachments = new SQLiteChatAttachments(options.db, options.blobs, {
    ...(options.createId ? { createId: options.createId } : {}),
    managedUri: (path) => new File(Paths.document, ...path.split("/")).uri,
  });
  await attachments.initialize();
  const source = options.source ?? createExpoChatAttachmentSource();
  const extraction = options.extraction ?? createExpoChatAttachmentExtraction();
  const intake = async (
    picked: PickedAttachment | undefined,
    ownerId: string,
    signal?: AbortSignal,
  ) =>
    picked
      ? attachments.importPicked(
          picked,
          ownerId,
          extraction,
          signal ? { signal } : {},
        )
      : undefined;
  return {
    attachments,
    pickFile: async (owner, signal) =>
      intake(await source.pickFile(signal), owner, signal),
    pickImage: async (owner, signal) =>
      intake(await source.pickImage(signal), owner, signal),
    takePhoto: async (owner, signal) =>
      intake(await source.takePhoto(signal), owner, signal),
    prepare: (input) => prepareChatAttachments(attachments, input),
    async preview(id) {
      const descriptor = await attachments.get(id);
      if (!descriptor)
        throw new AttachmentError("Attachment is unavailable", "missing");
      const stored = await attachments.getManaged(
        descriptor.previewRef ?? descriptor.blobRef,
      );
      if (!stored)
        throw new AttachmentError(
          "Attachment bytes are unavailable",
          "missing",
        );
      return {
        uri: stored.uri,
        mimeType: descriptor.mimeType,
        name: descriptor.name,
      };
    },
  };
}

function mimeFromName(name: string): string {
  const extension = name.toLowerCase().split(".").at(-1);
  return (
    (
      {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        gif: "image/gif",
        heic: "image/heic",
        heif: "image/heif",
        md: "text/markdown",
        txt: "text/plain",
        pdf: "application/pdf",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      } as Record<string, string>
    )[extension ?? ""] ?? "application/octet-stream"
  );
}
