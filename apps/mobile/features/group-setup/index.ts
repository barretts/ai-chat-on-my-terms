import {
  defaultGroupRoomSettings,
  emptyGroupParticipant,
  type GroupParticipantDraft,
  type GroupRoomDraft,
} from "@locallab/groups-config";
import type { PersonaGroupIntent } from "@locallab/personas-library";
import type { PersonaModelConnectionOption } from "../persona-bindings";

export interface GroupSeatChoice {
  value: string;
  label: string;
  detail?: string;
}

export function newGroupRoomDraft(conversationId: string): GroupRoomDraft {
  return {
    id: null,
    name: "",
    scenario: "",
    userDisplayName: "",
    conversationId,
    settings: defaultGroupRoomSettings(),
    participants: [],
  };
}

/** "Add to group" from the Personas list seats the Persona by identity. */
export function personaSeatFromIntent(
  intent: PersonaGroupIntent,
): GroupParticipantDraft {
  return {
    ...emptyGroupParticipant(),
    personaId: intent.identity.personaId,
    displayName: intent.identity.name,
  };
}

export function directModelSeat(
  connection: PersonaModelConnectionOption,
): GroupParticipantDraft {
  return {
    ...emptyGroupParticipant(),
    providerConnectionId: connection.id,
    modelId: connection.modelId,
    displayName: connection.modelId,
  };
}

/** Picker options: saved Personas first, then direct model connections. */
export function groupSeatChoices(
  personas: readonly { id: string; name: string }[],
  connections: readonly PersonaModelConnectionOption[],
): GroupSeatChoice[] {
  return [
    ...personas.map((persona) => ({
      value: `persona:${persona.id}`,
      label: persona.name,
      detail: "Persona",
    })),
    ...connections.map((connection) => ({
      value: `connection:${connection.id}`,
      label: connection.modelId,
      detail: `${connection.label} (direct model)`,
    })),
  ];
}
