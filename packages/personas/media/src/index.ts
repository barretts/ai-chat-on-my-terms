import {
  PERSONA_MEDIA_SETTINGS_KEY,
  readPersonaMediaSettings,
  type PersonaBindingStatus,
} from "@locallab/personas-bindings";

/** A saved image workflow the media engine can run. */
export interface PersonaWorkflowRegistration {
  name: string;
  definition: Record<string, unknown>;
}

export interface PersonaMediaResolution {
  status: PersonaBindingStatus;
  workflow?: PersonaWorkflowRegistration;
  /** Shown to the user when the bound workflow no longer exists. */
  message?: string;
}

/**
 * Resolve the image workflow a Persona pins. The first bound id wins; a
 * removed workflow reports `missing` — nothing is silently substituted, and
 * the caller must not swap in the global workflow without telling the user.
 */
export async function resolvePersonaMediaBinding(
  profile: unknown,
  findWorkflow: (
    workflowId: string,
  ) => PersonaWorkflowRegistration | undefined | Promise<
    PersonaWorkflowRegistration | undefined
  >,
): Promise<PersonaMediaResolution> {
  const [primary] = readPersonaMediaSettings(profile).workflowIds;
  if (!primary) return { status: "unbound" };
  const workflow = await findWorkflow(primary);
  if (!workflow)
    return {
      status: "missing",
      message:
        "The image workflow bound to this Persona was removed. Rebind or clear it in this Persona's Media settings; no other workflow was used.",
    };
  return { status: "bound", workflow };
}

/**
 * Profile patch for Persona Media settings. Workflow ids are opaque saved-
 * workflow names; passing null clears the binding so the chat falls back to
 * the global media workflow.
 */
export function personaMediaPatch(
  workflowId: string | null,
): Readonly<Record<string, unknown>> {
  if (workflowId === null)
    return { [PERSONA_MEDIA_SETTINGS_KEY]: null };
  const id = workflowId.trim();
  if (id === "")
    throw new Error("A bound media workflow needs a non-empty name.");
  return { [PERSONA_MEDIA_SETTINGS_KEY]: { workflowIds: [id] } };
}
