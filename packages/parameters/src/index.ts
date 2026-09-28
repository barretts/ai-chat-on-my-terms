import type { CapabilityMap } from "@locallab/contracts/ports";

/** A preset's values are only the fields explicitly set at that scope. */
export type ParameterValues = Readonly<Record<string, unknown>>;

export interface ParameterPreset {
  readonly explicitlySet: ParameterValues;
}

export interface ParameterPresetStack {
  readonly global: ParameterPreset;
  readonly model?: ParameterPreset | undefined;
  /** Persona values apply only when the selected Persona is enabled. */
  readonly persona?:
    | (ParameterPreset & { readonly enabled: boolean })
    | undefined;
  readonly chat?: ParameterPreset | undefined;
}

export interface ParameterResolution {
  /** Fully merged user intent, including saved values unsupported by this backend. */
  readonly effective: ParameterValues;
  /** Safe values to put on a provider/native request. */
  readonly outbound: ParameterValues;
  /** Saved values excluded from outbound because support is explicitly unknown/no. */
  readonly unsupported: Readonly<
    Record<
      string,
      { value: unknown; capability: string; support: "no" | "unknown" }
    >
  >;
}

/** Capability keys match parameter keys, with an optional `parameter.` prefix. */
export function resolveParameters(
  stack: ParameterPresetStack,
  capabilities: CapabilityMap = {},
): ParameterResolution {
  const effective: Record<string, unknown> = { ...stack.global.explicitlySet };
  if (stack.model) Object.assign(effective, stack.model.explicitlySet);
  if (stack.persona?.enabled)
    Object.assign(effective, stack.persona.explicitlySet);
  if (stack.chat) Object.assign(effective, stack.chat.explicitlySet);

  const outbound: Record<string, unknown> = {};
  const unsupported: Record<
    string,
    { value: unknown; capability: string; support: "no" | "unknown" }
  > = {};
  for (const [key, value] of Object.entries(effective)) {
    const capability =
      capabilities[key] !== undefined ? key : `parameter.${key}`;
    const support = capabilities[capability];
    if (support === "no" || support === "unknown") {
      unsupported[key] = { value, capability, support };
    } else {
      // An absent capability entry means the backend has not constrained this field.
      outbound[key] = value;
    }
  }
  return { effective, outbound, unsupported };
}

export interface UseGlobalResult {
  readonly modelPreset: undefined;
  readonly reloadContext: boolean;
  readonly reason: "preset-reset";
}

/** Use Global removes the model override; it does not rewrite the saved global preset. */
export function useGlobalParameters(
  previous: ParameterPresetStack,
): UseGlobalResult {
  return {
    modelPreset: undefined,
    reloadContext: hasContextAffectingOverrides(previous.model?.explicitlySet),
    reason: "preset-reset",
  };
}

/** Mark context reconstruction when a context sizing/loading field changes. */
export function contextReloadIntent(
  previous: ParameterValues,
  next: ParameterValues,
): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (isContextAffecting(key) && !Object.is(previous[key], next[key]))
      return true;
  }
  return false;
}

function hasContextAffectingOverrides(
  values: ParameterValues | undefined,
): boolean {
  return values !== undefined && Object.keys(values).some(isContextAffecting);
}

function isContextAffecting(key: string): boolean {
  return (
    key === "contextWindow" ||
    key === "maxOutputTokens" ||
    key === "load" ||
    key.startsWith("load.")
  );
}
