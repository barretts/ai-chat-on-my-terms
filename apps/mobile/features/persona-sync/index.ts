/**
 * T099 (SY-10) — selective Persona/photo/memory sync UI.
 *
 * Persona sync is an EXTRA opt-in layered on top of chat sync: it is only
 * ever offered for a pair whose chat sync is enabled AND chosen. The
 * eligibility wall itself (`personaTierGate`) runs in the sync engine on
 * both seams; this feature owns the selection UX, the per-persona
 * toggles, and the decision copy for device-local bindings that cannot
 * resolve on the target — shown WITHOUT echoing private fact content.
 */
export {
  SyncPersonaError,
  clearPersonaSelection,
  findPersonaSelection,
  parsePersonaSelectionRecords,
  resolvePersonaBindings,
  selectPersonas,
} from "@locallab/sync-personas";
export type {
  BindingStatus,
  PersonaBindings,
  PersonaSelectionVault,
  PersonaSyncSelection,
} from "@locallab/sync-personas";
import { findPersonaSelection, selectPersonas } from "@locallab/sync-personas";
import type { BindingStatus, PersonaBindings, PersonaSyncSelection } from "@locallab/sync-personas";

/** Persona catalogue entry as shown in Settings (name only; no facts). */
export interface PersonaListEntry {
  personaId: string;
  name: string;
  photoAttachmentId: string | null;
}

export interface PersonaSyncRow {
  personaId: string;
  name: string;
  selected: boolean;
  hasPhoto: boolean;
}

/** Step 1: persona opt-in exists only while chat sync is enabled+chosen. */
export function personaSyncOffered(chatSyncEnabled: boolean): boolean {
  return chatSyncEnabled;
}

export function personaSyncRows(
  personas: readonly PersonaListEntry[],
  selection: PersonaSyncSelection | null,
): readonly PersonaSyncRow[] {
  const selected = new Set(selection?.personaIds ?? []);
  return personas.map((persona) => ({
    personaId: persona.personaId,
    name: persona.name,
    selected: selected.has(persona.personaId),
    hasPhoto: persona.photoAttachmentId !== null,
  }));
}

/** Toggle one persona while keeping the route's photos/memories flags. */
export function togglePersonaSelection(
  rows: readonly PersonaSyncSelection[],
  routeId: string,
  personaId: string,
  now: string,
): PersonaSyncSelection[] {
  const current = findPersonaSelection(rows, routeId);
  const chosen = current === null ? [] : current.personaIds;
  const next = chosen.includes(personaId)
    ? chosen.filter((id) => id !== personaId)
    : [...chosen, personaId];
  return selectPersonas(
    rows.filter((row) => row.routeId !== routeId),
    routeId,
    next,
    { photos: current?.photos ?? true, memories: current?.memories ?? true },
    now,
  );
}

const BINDING_LABELS: Record<string, string> = {
  photoAttachmentId: "Photo",
  modelId: "Model",
  parameterPresetId: "Preset",
};

/**
 * Decision copy for one binding status. "unavailable" NEVER echoes the
 * referenced id's content (isolated facts stay isolated); it asks for an
 * explicit local choice instead.
 */
export function bindingDecisionText(status: BindingStatus, kind: keyof PersonaBindings): string | null {
  if (status === "not-needed") return null;
  const label = BINDING_LABELS[kind] ?? kind;
  return status === "resolved"
    ? `${label}: ready on this device`
    : `${label}: not on this device. Pick a replacement here — nothing was copied over.`;
}

/** All decision notes for a synced persona, in fixed order. */
export function personaBindingNotes(bindings: PersonaBindings): readonly string[] {
  const notes: string[] = [];
  for (const kind of ["photoAttachmentId", "modelId", "parameterPresetId"] as const) {
    const note = bindingDecisionText(bindings[kind], kind);
    if (note !== null) notes.push(note);
  }
  return notes;
}
