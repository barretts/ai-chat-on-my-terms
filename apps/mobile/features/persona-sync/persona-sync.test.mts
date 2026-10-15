import { describe, expect, it } from "vitest";
import {
  SyncPersonaError,
  bindingDecisionText,
  findPersonaSelection,
  personaBindingNotes,
  personaSyncOffered,
  personaSyncRows,
  resolvePersonaBindings,
  selectPersonas,
  togglePersonaSelection,
  type PersonaBindings,
  type PersonaListEntry,
} from ".";

const ROUTE = "0198f2a3-0000-7000-8000-0000000000a1";
const ADA = "0198f2a3-0000-7000-8000-0000000000b1";
const NOVA = "0198f2a3-0000-7000-8000-0000000000b2";
const PHOTO = "0198f2a3-0000-7000-8000-0000000000c1";
const NOW = "2026-10-14T12:00:00.000Z";

const CASTERS: PersonaListEntry[] = [
  { personaId: ADA, name: "Ada", photoAttachmentId: PHOTO },
  { personaId: NOVA, name: "Nova", photoAttachmentId: null },
];

describe("persona sync selection (SY-10 opt-in wall)", () => {
  it("is only offered while chat sync is enabled", () => {
    expect(personaSyncOffered(false)).toBe(false);
    expect(personaSyncOffered(true)).toBe(true);
  });

  it("marks only the selected characters in the list", () => {
    const selection = findPersonaSelection(selectPersonas([], ROUTE, [ADA], { photos: true, memories: true }, NOW), ROUTE);
    const rows = personaSyncRows(CASTERS, selection);
    expect(rows.find((row) => row.personaId === ADA)?.selected).toBe(true);
    expect(rows.find((row) => row.personaId === NOVA)?.selected).toBe(false);
    expect(rows.find((row) => row.personaId === ADA)?.hasPhoto).toBe(true);
    expect(personaSyncRows(CASTERS, null).every((row) => !row.selected)).toBe(true);
  });

  it("toggles one character without dropping the pair flags", () => {
    let rows = selectPersonas([], ROUTE, [ADA], { photos: false, memories: true }, NOW);
    rows = togglePersonaSelection(rows, ROUTE, NOVA, NOW);
    let selection = findPersonaSelection(rows, ROUTE)!;
    expect(selection.personaIds).toEqual([ADA, NOVA]);
    expect(selection.photos).toBe(false);
    rows = togglePersonaSelection(rows, ROUTE, ADA, NOW);
    selection = findPersonaSelection(rows, ROUTE)!;
    expect(selection.personaIds).toEqual([NOVA]);
  });

  it("rejects malformed persisted rows fail-closed", () => {
    expect(() => selectPersonas([], ROUTE, ["not-an-id"], { photos: true, memories: true }, NOW)).toThrow(
      SyncPersonaError,
    );
  });
});

describe("binding decisions without leaking isolated facts", () => {
  const bindings: PersonaBindings = {
    photoAttachmentId: "resolved",
    modelId: "unavailable",
    parameterPresetId: "not-needed",
  };

  it("asks for a local replacement and copies nothing over", () => {
    const notes = personaBindingNotes(bindings);
    expect(notes).toContain("Model: not on this device. Pick a replacement here — nothing was copied over.");
    expect(notes).toContain("Photo: ready on this device");
    expect(notes.length).toBe(2);
  });

  it("bindingDecisionText stays silent for not-needed references", () => {
    expect(bindingDecisionText("not-needed", "parameterPresetId")).toBeNull();
  });

  it("resolves synced personas against the LOCAL device index", () => {
    const resolved = resolvePersonaBindings(
      {
        id: ADA,
        createdAt: NOW,
        updatedAt: NOW,
        revision: { wallMs: 1, counter: 0, deviceId: ADA },
        name: "Ada",
        profile: {},
        photoAttachmentId: PHOTO,
        modelId: "0198f2a3-0000-7000-8000-0000000000d1",
        parameterPresetId: null,
      },
      {
        hasAttachment: (id) => id === PHOTO,
        hasModel: () => false,
        hasPreset: () => false,
      },
    );
    expect(resolved).toEqual({ photoAttachmentId: "resolved", modelId: "unavailable", parameterPresetId: "not-needed" });
  });
});
