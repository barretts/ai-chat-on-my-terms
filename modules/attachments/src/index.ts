import type {
  AttachmentBlobPort,
  AttachmentDescriptor,
  AttachmentIds,
  ExtractionPort,
  PickedAttachment,
} from "@locallab/attachments";
import { ingestAttachment } from "@locallab/attachments";

/** Native hosts implement camera/library/document picking and keep security-scoped URLs alive through import. */
export interface NativeAttachmentSource {
  pickImage(signal?: AbortSignal): Promise<PickedAttachment | undefined>;
  pickFile(signal?: AbortSignal): Promise<PickedAttachment | undefined>;
  preview(
    blobRef: string,
  ): Promise<{ uri: string; mimeType: string } | undefined>;
}
export interface AttachmentPlatform {
  readonly source: NativeAttachmentSource;
  readonly blobs: AttachmentBlobPort;
  readonly extraction: ExtractionPort;
  readonly ids: AttachmentIds;
}
export async function takePhoto(
  platform: AttachmentPlatform,
  signal?: AbortSignal,
): Promise<AttachmentDescriptor | undefined> {
  const item = await platform.source.pickImage(signal);
  if (!item) return undefined;
  return ingestAttachment(item, platform, signal ? { signal } : {});
}
export async function chooseAttachment(
  platform: AttachmentPlatform,
  signal?: AbortSignal,
): Promise<AttachmentDescriptor | undefined> {
  const item = await platform.source.pickFile(signal);
  if (!item) return undefined;
  return ingestAttachment(item, platform, signal ? { signal } : {});
}
export async function openAttachmentPreview(
  platform: AttachmentPlatform,
  attachment: AttachmentDescriptor,
): Promise<{ uri: string; mimeType: string }> {
  const preview = await platform.source.preview(attachment.blobRef);
  if (!preview)
    throw new Error(
      "No native preview handler is available for this attachment",
    );
  return preview;
}
