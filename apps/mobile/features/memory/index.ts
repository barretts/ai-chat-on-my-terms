import type {
  MemoryPreferences,
  MemoryScope,
  SavedMemory,
  SQLiteMemoryStore,
} from "@locallab/memory-extraction";

export type MemoryManagementPort = Pick<
  SQLiteMemoryStore,
  | "list"
  | "get"
  | "createManual"
  | "edit"
  | "delete"
  | "preferences"
  | "savePreferences"
  | "sourceLink"
  | "listLegacy"
  | "adoptLegacy"
  | "deleteLegacy"
>;

export interface MemoryFeatureProps {
  store: MemoryManagementPort;
  /** A Persona management surface can restrict this view to its own scope. */
  scope?: MemoryScope;
  onOpenSource?: (conversationId: string, messageId: string) => void;
  onClose?: () => void;
  onPreferencesChanged?: (preferences: MemoryPreferences) => void;
}

export function memoryScopeLabel(memory: SavedMemory): string {
  if (memory.entry.scope === "global") return "Across conversations";
  if (memory.entry.scope === "persona") return "Persona memory";
  return "This conversation";
}

export function memorySourceLabel(memory: SavedMemory): string {
  if (memory.entry.provenance.method === "user") return "Added by you";
  if (memory.entry.provenance.method === "legacy-saved-entry")
    return "Previously saved entry";
  if (memory.entry.provenance.method === "user-edited") return "Edited by you";
  if (memory.entry.provenance.method === "user-reviewed-legacy")
    return "Reviewed by you";
  return "Extracted from a completed turn";
}
