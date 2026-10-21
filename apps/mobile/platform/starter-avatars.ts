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
import type { StarterTrope } from "@locallab/personas-starter-pack";

const AVATAR_ASSETS: Record<string, number> = {
  "gruff-mentor": require("../assets/starter-personas/gruff-mentor.png"),
  sunbeam: require("../assets/starter-personas/sunbeam.png"),
  butler: require("../assets/starter-personas/butler.png"),
  "noir-detective": require("../assets/starter-personas/noir-detective.png"),
  schemer: require("../assets/starter-personas/schemer.png"),
  archivist: require("../assets/starter-personas/archivist.png"),
  "hype-buddy": require("../assets/starter-personas/hype-buddy.png"),
  oracle: require("../assets/starter-personas/oracle.png"),
  tsundere: require("../assets/starter-personas/tsundere.png"),
  kuudere: require("../assets/starter-personas/kuudere.png"),
  genki: require("../assets/starter-personas/genki.png"),
  chuunibyou: require("../assets/starter-personas/chuunibyou.png"),
  "isekai-hero": require("../assets/starter-personas/isekai-hero.png"),
  "magical-girl": require("../assets/starter-personas/magical-girl.png"),
};

export function createStarterAvatarAttacher(deps: {
  attachments: SQLiteChatAttachments;
  extraction: ExtractionPort;
}): (trope: StarterTrope) => Promise<string | null> {
  return async (trope) => {
    try {
      const module = AVATAR_ASSETS[trope.key];
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
          name: `${trope.key}.png`,
          mimeType: "image/png",
          byteLength,
          sourceUri: uri,
          metadata: { source: "starter-pack" },
        },
        trope.id,
        deps.extraction,
        {},
      );
      return stored.id;
    } catch (cause) {
      console.warn(
        `starter-pack avatar import failed for ${trope.key}: ${String(cause)}`,
      );
      return null;
    }
  };
}
