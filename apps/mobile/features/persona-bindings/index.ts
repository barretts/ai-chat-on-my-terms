import {
  PERSONA_MODEL_SETTINGS_KEY,
  bindingOptions,
  readPersonaModelSettings,
} from "@locallab/personas-bindings";

export interface PersonaModelConnectionOption {
  id: string;
  label: string;
  modelId: string;
}

export const DEFAULT_MODEL_CHOICE = "default";

/** Dropdown list for the Persona editor; removed bindings stay selectable. */
export function personaModelChoices(
  connections: readonly PersonaModelConnectionOption[],
  boundConnectionId: string | undefined,
): { value: string; label: string }[] {
  return [
    {
      value: DEFAULT_MODEL_CHOICE,
      label: "Use this chat's model",
    },
    ...bindingOptions(
      connections.map((connection) => ({
        id: connection.id,
        label: `${connection.label} — ${connection.modelId}`,
      })),
      boundConnectionId,
    ),
  ];
}

/**
 * Profile merge for the Persona editor. The stored binding is the provider
 * connection ID (identity), never the display label.
 */
export function personaProfileWithModel(
  profile: Readonly<Record<string, unknown>> | undefined,
  connectionId: string | null,
): Record<string, unknown> {
  const next = { ...profile };
  if (connectionId === null) delete next[PERSONA_MODEL_SETTINGS_KEY];
  else next[PERSONA_MODEL_SETTINGS_KEY] = { connectionId };
  return next;
}

export function personaModelChoice(
  profile: Readonly<Record<string, unknown>> | undefined,
): string {
  return readPersonaModelSettings(profile).connectionId ?? DEFAULT_MODEL_CHOICE;
}
