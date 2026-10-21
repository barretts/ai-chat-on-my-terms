/**
 * Starter trope pack boot (T184): keep expo/asset imports out of the pure
 * seeding package and out of persona-memory.ts (which node tests run). This
 * module runs only inside the mobile composition root, where the database,
 * blob store, and attachment intake all exist.
 */
import type { ExtractionPort } from "@locallab/attachments";
import type { SQLiteChatAttachments } from "@locallab/chat-integration";
import {
  loadTropePack,
  seedTropePack,
  type TropePersonaWriter,
  type TropeSeedResult,
} from "@locallab/personas-starter-pack";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { createStarterAvatarAttacher } from "../../platform/starter-avatars";

export interface StarterTropePackDeps {
  library: TropePersonaWriter;
  db: SQLiteDatabasePort;
  attachments: SQLiteChatAttachments;
  extraction: ExtractionPort;
  log?: (message: string) => void;
}

function options(deps: StarterTropePackDeps) {
  const base = {
    library: deps.library,
    db: deps.db,
    attachAvatar: createStarterAvatarAttacher({
      attachments: deps.attachments,
      extraction: deps.extraction,
    }),
  };
  return deps.log ? { ...base, log: deps.log } : base;
}

/** Install-all-once at boot; a seeded device returns with no writes. */
export async function ensureStarterTropePack(
  deps: StarterTropePackDeps,
): Promise<TropeSeedResult> {
  return seedTropePack(options(deps));
}

/** Explicit owner reload from the Personas screen (revive deleted characters). */
export async function reloadStarterTropePack(
  deps: StarterTropePackDeps,
): Promise<TropeSeedResult> {
  return loadTropePack(options(deps));
}
