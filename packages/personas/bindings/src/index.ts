import { EntityIdSchema } from "@locallab/contracts/identity";

/**
 * Persona binding keys stored inside the Persona profile map (PE-02, PE-09).
 * Bindings are IDs, never display names: a removed provider, voice or media
 * workflow is reported, and nothing is silently substituted.
 */
export const PERSONA_MODEL_SETTINGS_KEY = "model";
export const PERSONA_MEDIA_SETTINGS_KEY = "media";

export interface PersonaModelSettings {
  /** Chat provider connection ID pinning the exact provider + model. */
  connectionId?: string;
}

export interface PersonaMediaSettings {
  /** Media workflow references (resolved by the media batch; opaque here). */
  workflowIds: readonly string[];
}

export type PersonaBindingStatus = "unbound" | "bound" | "missing";

export interface PersonaModelResolution<T> {
  status: PersonaBindingStatus;
  registration?: T;
  /** Shown to the user when the bound identity no longer exists. */
  message?: string;
}

export function readPersonaModelSettings(
  profile: unknown,
): PersonaModelSettings {
  if (typeof profile !== "object" || profile === null) return {};
  const raw = (profile as Record<string, unknown>)[
    PERSONA_MODEL_SETTINGS_KEY
  ];
  if (typeof raw !== "object" || raw === null) return {};
  const connectionId = (raw as Record<string, unknown>).connectionId;
  if (
    typeof connectionId !== "string" ||
    !EntityIdSchema.safeParse(connectionId).success
  )
    return {};
  return { connectionId };
}

export function personaModelPatch(
  connectionId: string | null,
): Readonly<Record<string, unknown>> {
  if (connectionId === null)
    return { [PERSONA_MODEL_SETTINGS_KEY]: null };
  return {
    [PERSONA_MODEL_SETTINGS_KEY]: {
      connectionId: EntityIdSchema.parse(connectionId),
    },
  };
}

export function readPersonaMediaSettings(profile: unknown): PersonaMediaSettings {
  if (typeof profile !== "object" || profile === null)
    return { workflowIds: [] };
  const raw = (profile as Record<string, unknown>)[
    PERSONA_MEDIA_SETTINGS_KEY
  ];
  if (typeof raw !== "object" || raw === null) return { workflowIds: [] };
  const ids = (raw as Record<string, unknown>).workflowIds;
  if (!Array.isArray(ids)) return { workflowIds: [] };
  return {
    workflowIds: ids
      .filter((id): id is string => typeof id === "string" && id.trim() !== "")
      .slice(0, 16)
      .map((id) => id.trim()),
  };
}

/**
 * Resolve a Persona's bound provider connection. A removed binding reports
 * `missing` with the exact explanation; the caller must not fall back to the
 * chat's current provider without telling the user.
 */
export async function resolvePersonaModelBinding<T>(
  profile: unknown,
  findConnection: (
    connectionId: string,
  ) => T | undefined | Promise<T | undefined>,
): Promise<PersonaModelResolution<T>> {
  const { connectionId } = readPersonaModelSettings(profile);
  if (!connectionId) return { status: "unbound" };
  const registration = await findConnection(connectionId);
  if (!registration)
    return {
      status: "missing",
      message:
        "The model bound to this Persona was removed from Connections. Rebind or clear it in this Persona's Model settings; no other model was used.",
    };
  return { status: "bound", registration };
}

/** Binding option lists keep a removed identity visible instead of dropping it. */
export function bindingOptions<T>(
  options: readonly { id: string; label: string }[],
  boundId: string | undefined,
  removedLabel = "Removed binding (choose another or reset)",
): { value: string; label: string }[] {
  const list = options.map((option) => ({
    value: option.id,
    label: option.label,
  }));
  if (boundId && !list.some((option) => option.value === boundId))
    list.unshift({ value: boundId, label: removedLabel });
  return list;
}
