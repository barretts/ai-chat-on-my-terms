/**
 * T098A (SY-02, SY-03, SY-07) — "Sync chats with Home Mac" opt-in and the
 * one-time initial choice prompt. The pairing/Settings UX lives here; the
 * per-pair state model lives in @locallab/sync-preferences and the same
 * gate (`syncDataAllowed`) blocks the T098C transport until the user opts
 * in and picks a mode. Disabling never deletes local chats on either side.
 */
export {
  SyncPreferenceError,
  completeInitialSync,
  findPairSyncPreference,
  needsInitialSyncChoice,
  optInPairSync,
  optOutPairSync,
  parseSyncPreferenceRecords,
  setInitialSyncChoice,
  syncChoiceLabel,
  syncDataAllowed,
  syncPreferenceViews,
} from "@locallab/sync-preferences";
export type {
  PairSyncPreference,
  SyncChoice,
  SyncPreferenceRow,
  SyncPreferenceVault,
} from "@locallab/sync-preferences";
import type { SyncChoice, SyncPreferenceRow } from "@locallab/sync-preferences";

export interface SyncChoicePreview {
  choice: SyncChoice;
  title: string;
  /** Plain-language preview of what the first sync will do (SY-03). */
  preview: string;
}

export function syncChoicePreviews(): readonly SyncChoicePreview[] {
  return [
    {
      choice: "copy-phone",
      title: "Copy from this iPhone",
      preview:
        "Your iPhone chats become the chats on your Home Mac. Chats that exist only on the Mac are removed there.",
    },
    {
      choice: "copy-mac",
      title: "Copy from the Home Mac",
      preview:
        "Your Home Mac chats are copied onto this iPhone. Chats that exist only on the iPhone are removed here.",
    },
    {
      choice: "merge",
      title: "Merge both sides",
      preview:
        "Chats from both devices are combined. Newer edits win; nothing else is removed.",
    },
  ];
}

/** SY-07 reassurance copy for the Settings toggle. */
export function syncToggleNote(enabled: boolean): string {
  return enabled
    ? "Sync is on. Chats stay on both devices and update each other."
    : "Sync is off. Chats are never deleted; both local copies stay exactly where they are.";
}
/** SY-08 failure copy: retry is the toggle, per the source guide. */
export function syncFailureNote(note: string): string {
  return `${note} Toggle Sync chats off and on to retry.`;
}

export function initialSyncPromptVisible(row: SyncPreferenceRow): boolean {
  return row.enabled && row.needsChoice;
}
