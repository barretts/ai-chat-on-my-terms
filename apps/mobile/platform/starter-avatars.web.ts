/**
 * Web counterpart of starter-avatars.ts: expo-file-system's `File` is stubbed
 * in the browser (validatePath throws), and the blob file port only reads
 * data:/blob: URLs, so asset bytes are measured through fetch and re-handed
 * to importPicked as a blob: URL. Same failure contract: null on any error,
 * never aborting the pack install.
 */
import { Asset } from "expo-asset";
import type { SQLiteChatAttachments } from "@locallab/chat-integration";
import { AVATAR_ASSETS } from "./starter-avatars.assets";
import type { ExtractionPort } from "@locallab/attachments";

export interface BundledAvatarOwner {
  key: string;
  id: string;
}

export function createStarterAvatarAttacher(deps: {
  attachments: SQLiteChatAttachments;
  extraction: ExtractionPort;
}): (owner: BundledAvatarOwner) => Promise<string | null> {
  return async (owner) => {
    try {
      const module = AVATAR_ASSETS[owner.key];
      if (module === undefined) return null;
      const asset = Asset.fromModule(module);
      await asset.downloadAsync();
      const uri = asset.localUri ?? asset.uri;
      if (!uri) return null;
      const response = await fetch(uri);
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!Number.isSafeInteger(blob.size) || blob.size <= 0) return null;
      // The browser blob port reads data:/blob: only; rewrap the fetched
      // bytes (also normalizes cross-origin asset URLs to same-origin blobs).
      const sourceUrl = URL.createObjectURL(blob);
      try {
        const stored = await deps.attachments.importPicked(
          {
            name: `${owner.key}.png`,
            mimeType: blob.type || "image/png",
            byteLength: blob.size,
            sourceUri: sourceUrl,
            metadata: { source: "bundled-avatar" },
          },
          owner.id,
          deps.extraction,
          {},
        );
        return stored.id;
      } finally {
        URL.revokeObjectURL(sourceUrl);
      }
    } catch (cause) {
      console.warn(
        `bundled avatar import failed for ${owner.key}: ${String(cause)}`,
      );
      return null;
    }
  };
}
