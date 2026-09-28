import { EntityIdSchema } from "@locallab/contracts/identity";
import { AttachmentError } from "@locallab/attachments";
import type { PersonaAvatarPort } from "./index";

export class PersonaAvatarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaAvatarError";
  }
}

/** Narrow adapter for the app's existing native image intake and managed attachments. */
export function createManagedPersonaAvatarPort(options: {
  pickImage(
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<
    | {
        id: string;
        mimeType: string;
        byteLength: number;
      }
    | undefined
  >;
  preview(id: string): Promise<{ uri: string; mimeType: string }>;
  release(id: string, ownerId: string): Promise<void>;
  /** The storage owner can validate private preview URLs issued by its own registry. */
  isManagedPreviewUri?: (uri: string) => boolean;
  maximumBytes?: number;
}): PersonaAvatarPort {
  const managedUri = options.isManagedPreviewUri ?? isManagedAvatarUri;
  const maximumBytes = options.maximumBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0)
    throw new PersonaAvatarError(
      "Avatar size limit must be a positive byte count.",
    );
  return {
    async pick(ownerId, signal) {
      EntityIdSchema.parse(ownerId);
      signal?.throwIfAborted();
      let attachment: Awaited<ReturnType<typeof options.pickImage>>;
      try {
        attachment = await options.pickImage(ownerId, signal);
      } catch (cause) {
        if (
          cause instanceof AttachmentError &&
          cause.code === "unsupported-type"
        )
          throw new PersonaAvatarError(
            "Choose a JPEG, PNG, WebP, HEIC, or HEIF image for this avatar.",
          );
        throw cause;
      }
      if (!attachment) return undefined;
      try {
        signal?.throwIfAborted();
        EntityIdSchema.parse(attachment.id);
        if (
          !Number.isSafeInteger(attachment.byteLength) ||
          attachment.byteLength < 1 ||
          attachment.byteLength > maximumBytes
        )
          throw new PersonaAvatarError(
            `Choose an avatar image smaller than ${Math.ceil(maximumBytes / (1024 * 1024))} MB.`,
          );
        if (!isAvatarMime(attachment.mimeType))
          throw new PersonaAvatarError(
            "Choose a JPEG, PNG, WebP, HEIC, or HEIF image for this avatar.",
          );
        const preview = await options.preview(attachment.id);
        signal?.throwIfAborted();
        if (!isAvatarMime(preview.mimeType) || !managedUri(preview.uri))
          throw new PersonaAvatarError(
            "This avatar image is not available in managed local storage.",
          );
        return { attachmentId: attachment.id, uri: preview.uri };
      } catch (cause) {
        await options.release(attachment.id, ownerId).catch(() => undefined);
        throw cause;
      }
    },
    async resolve(id) {
      EntityIdSchema.parse(id);
      const preview = await options.preview(id);
      if (!isAvatarMime(preview.mimeType) || !managedUri(preview.uri))
        return undefined;
      return preview.uri;
    },
    release: (id, ownerId) => options.release(id, ownerId),
  };
}

function isAvatarMime(mime: string): boolean {
  return /^(image\/(?:jpeg|png|webp|heic|heif))$/i.test(mime);
}
function isManagedAvatarUri(uri: string): boolean {
  // Managed previews are private on-device files, with no remote image fetches.
  if (!/^file:\/\/\//i.test(uri) || /[\u0000-\u001f]/.test(uri)) return false;
  try {
    const url = new URL(uri);
    return !url.hostname && !url.search && !url.hash;
  } catch {
    return false;
  }
}
