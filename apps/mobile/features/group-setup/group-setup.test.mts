import { describe, expect, it } from "vitest";
import {
  directModelSeat,
  groupSeatChoices,
  newGroupRoomDraft,
  personaSeatFromIntent,
} from ".";

const PERSONA = "0195c000-0000-7000-8000-0000000000b1";
const CONNECTION = "0195c000-0000-7000-8000-0000000000b2";

describe("group setup helpers", () => {
  it("seats a Persona by identity from the add-to-group intent", () => {
    const seat = personaSeatFromIntent({
      kind: "add-persona-to-group",
      personaId: PERSONA,
      identity: {
        personaId: PERSONA,
        name: "Ada Lovelace",
        prompt: "",
        description: "",
        photoAttachmentId: null,
        appearance: {
          initials: "AL",
          shape: "circle",
          accentColor: "#000000",
          backgroundColor: "#ffffff",
        },
        profile: {},
        revision: { wallMs: 1, counter: 1, deviceId: "" },
      },
    });
    expect(seat.personaId).toBe(PERSONA);
    expect(seat.providerConnectionId).toBeNull();
    expect(seat.displayName).toBe("Ada Lovelace");
  });

  it("binds a direct model seat to the connection identity and exact model", () => {
    const seat = directModelSeat({
      id: CONNECTION,
      label: "Lab",
      modelId: "llama-3.3-70b",
    });
    expect(seat.providerConnectionId).toBe(CONNECTION);
    expect(seat.modelId).toBe("llama-3.3-70b");
    expect(seat.personaId).toBeNull();
  });

  it("offers personas before direct connections with distinct details", () => {
    const choices = groupSeatChoices(
      [{ id: PERSONA, name: "Ada" }],
      [{ id: CONNECTION, label: "Lab", modelId: "llama" }],
    );
    expect(choices[0]).toEqual({
      value: `persona:${PERSONA}`,
      label: "Ada",
      detail: "Persona",
    });
    expect(choices[1]?.value).toBe(`connection:${CONNECTION}`);
    expect(choices[1]?.detail).toContain("direct model");
  });

  it("starts a fresh room draft empty", () => {
    const draft = newGroupRoomDraft(
      "0195c000-0000-7000-8000-0000000000c1",
    );
    expect(draft.id).toBeNull();
    expect(draft.participants).toEqual([]);
  });
});
