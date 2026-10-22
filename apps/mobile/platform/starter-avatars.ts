/**
 * Starter-pack avatar intake (T184): bundled flat emblems become managed
 * chat attachments so persona avatars reuse the exact storage, retention,
 * and preview path as user-picked photos — no parallel attachment system.
 *
 * Failures return null instead of throwing: the pack spec says an avatar
 * failure keeps the persona photo-less, never aborts the install.
 */
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import type { SQLiteChatAttachments } from "@locallab/chat-integration";
import type { ExtractionPort } from "@locallab/attachments";

import { AVATAR_ASSETS } from "./starter-avatars.assets";
/** Any stored entity with a `key` naming a bundled avatar and an `id` owner. */
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
      const byteLength = new File(uri).size;
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return null;
      // Owner is the persona id: the avatar's lifecycle rides the persona's.
      const stored = await deps.attachments.importPicked(
        {
          name: `${owner.key}.png`,
          mimeType: "image/png",
          byteLength,
          sourceUri: uri,
          metadata: { source: "bundled-avatar" },
        },
        owner.id,
        deps.extraction,
        {},
      );
      return stored.id;
    } catch (cause) {
      console.warn(
        `bundled avatar import failed for ${owner.key}: ${String(cause)}`,
      );
      return null;
    }
  };
}
