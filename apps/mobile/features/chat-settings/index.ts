import type { CapabilityMap } from "@locallab/contracts/ports";
import { resolveCapabilities } from "@locallab/capabilities";
import {
  contextReloadIntent,
  resolveParameters,
  useGlobalParameters,
} from "@locallab/parameters";
import type {
  ParameterPreset,
  ParameterPresetStack,
  ParameterValues,
} from "@locallab/parameters";

export type SettingsScope = "global" | "model" | "persona" | "chat";
export type SettingsPresets = Readonly<Record<SettingsScope, ParameterPreset>>;
export type ControlKind = "number" | "boolean" | "text" | "choice";
export interface ParameterControl {
  key: string;
  label: string;
  kind: ControlKind;
  capability: string;
  choices?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
}

export const PARAMETER_CONTROLS: readonly ParameterControl[] = [
  {
    key: "providerConnectionId",
    label: "Provider connection ID",
    kind: "text",
    capability: "chat.provider",
  },
  { key: "modelId", label: "Model ID", kind: "text", capability: "chat.model" },
  {
    key: "systemPrompt",
    label: "System prompt",
    kind: "text",
    capability: "chat.systemPrompt",
  },
  {
    key: "temperature",
    label: "Temperature",
    kind: "number",
    capability: "parameter.temperature",
    min: 0,
    max: 2,
    step: 0.1,
  },
  {
    key: "top_p",
    label: "Top P",
    kind: "number",
    capability: "parameter.top_p",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: "top_k",
    label: "Top K",
    kind: "number",
    capability: "parameter.top_k",
    min: 0,
    max: 500,
    step: 1,
  },
  {
    key: "min_p",
    label: "Min P",
    kind: "number",
    capability: "parameter.min_p",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "repeat_penalty",
    label: "Repeat penalty",
    kind: "number",
    capability: "parameter.repeat_penalty",
    min: 0,
    max: 3,
    step: 0.05,
  },
  {
    key: "penalty_repeat",
    label: "Penalty repeat (on-device)",
    kind: "number",
    capability: "parameter.penalty_repeat",
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    key: "max_output_tokens",
    label: "Maximum output tokens",
    kind: "number",
    capability: "parameter.max_output_tokens",
    min: 1,
    max: 100000,
    step: 1,
  },
  {
    key: "contextWindow",
    label: "Context window",
    kind: "number",
    capability: "parameter.contextWindow",
    min: 256,
    max: 2000000,
    step: 256,
  },
  {
    key: "reasoning",
    label: "Reasoning",
    kind: "boolean",
    capability: "reasoning",
  },
  {
    key: "reasoning_effort",
    label: "Reasoning effort",
    kind: "choice",
    capability: "reasoning",
    choices: ["low", "medium", "high"],
  },
  {
    key: "reasoning_verbosity",
    label: "Reasoning verbosity",
    kind: "choice",
    capability: "reasoning",
    choices: ["low", "medium", "high"],
  },
  {
    key: "json_mode",
    label: "JSON / structured output",
    kind: "boolean",
    capability: "structuredOutput",
  },
  {
    key: "flash_attention",
    label: "Flash attention",
    kind: "boolean",
    capability: "parameter.flash_attention",
  },
  {
    key: "kv_cache_offload",
    label: "KV cache offload",
    kind: "boolean",
    capability: "parameter.kv_cache_offload",
  },
  {
    key: "load.gpu_layers",
    label: "GPU layers",
    kind: "number",
    capability: "parameter.load.gpu_layers",
    min: 0,
    max: 999,
    step: 1,
  },
  {
    key: "load.use_mmap",
    label: "Memory map weights",
    kind: "boolean",
    capability: "parameter.load.use_mmap",
  },
];

export interface ChatAppearance {
  background?: string;
  avatar?: string;
}

export interface ChatSettingsStore {
  loadPresets(identity: SettingsIdentity): Promise<Partial<SettingsPresets>>;
  savePreset(
    scope: SettingsScope,
    values: ParameterValues,
    identity: SettingsIdentity,
  ): Promise<void>;
  loadAppearance(conversationId: string): Promise<ChatAppearance>;
  saveAppearance(
    conversationId: string,
    appearance: ChatAppearance,
  ): Promise<void>;
}

export interface SettingsIdentity {
  modelId?: string;
  personaId?: string;
}

export interface SettingsSnapshot {
  stack: ParameterPresetStack;
  effective: ParameterValues;
  outbound: ParameterValues;
  unsupported: Readonly<
    Record<
      string,
      { value: unknown; capability: string; support: "no" | "unknown" }
    >
  >;
  origins: Readonly<Record<string, SettingsScope | "server">>;
  capabilities: ReturnType<typeof resolveCapabilities>;
}

/**
 * Publisher-recommended sampling, keyed by the installed model's catalog id —
 * never by a shared model-name preset. Folded into the model scope below every
 * explicit user preset by resolveSettings.
 */
const publisherSamplingDefaults: Readonly<Record<string, ParameterValues>> = {
  "liquid/lfm2.5-2.6b-q4_k_m": {
    temperature: 0.1,
    top_k: 50,
    penalty_repeat: 1.1,
  },
};

export function catalogPublisherDefaults(
  catalogId: string,
): ParameterValues | undefined {
  return publisherSamplingDefaults[catalogId];
}

export function resolveSettings(input: {
  presets: SettingsPresets;
  personaEnabled: boolean;
  capabilities: CapabilityMap;
  /** Active context reported by the selected server, below every explicit preset. */
  serverContextWindow?: number;
  /** Active model output limit reported by the selected server. */
  serverMaxOutputTokens?: number;
  /** Publisher sampling for the bound catalog model; user presets always win. */
  publisherDefaults?: ParameterValues;
}): SettingsSnapshot {
  const serverContextWindow =
    Number.isSafeInteger(input.serverContextWindow) &&
    input.serverContextWindow! > 0
      ? input.serverContextWindow
      : undefined;
  const serverMaxOutputTokens =
    Number.isSafeInteger(input.serverMaxOutputTokens) &&
    input.serverMaxOutputTokens! > 0
      ? input.serverMaxOutputTokens
      : undefined;
  const stack: ParameterPresetStack = {
    global: {
      explicitlySet: {
        ...(serverContextWindow ? { contextWindow: serverContextWindow } : {}),
        ...(serverMaxOutputTokens
          ? { max_output_tokens: serverMaxOutputTokens }
          : {}),
        ...input.presets.global.explicitlySet,
      },
    },
    model: input.publisherDefaults
      ? {
          explicitlySet: {
            ...input.publisherDefaults,
            ...input.presets.model.explicitlySet,
          },
        }
      : input.presets.model,
    persona: { ...input.presets.persona, enabled: input.personaEnabled },
    chat: input.presets.chat,
  };
  const parameterCapabilities: Record<string, "yes" | "no" | "unknown"> = {
    ...input.capabilities,
    providerConnectionId: "yes",
    modelId: "yes",
    systemPrompt: "yes",
  };
  for (const control of PARAMETER_CONTROLS) {
    parameterCapabilities[control.key] =
      input.capabilities[control.capability] ??
      input.capabilities[control.key] ??
      "unknown";
  }
  const resolved = resolveParameters(stack, parameterCapabilities);
  const origins: Record<string, SettingsScope | "server"> = {
    ...(serverContextWindow ? { contextWindow: "server" as const } : {}),
    ...(serverMaxOutputTokens ? { max_output_tokens: "server" as const } : {}),
  };
  for (const [scope, values] of [
    ["global", input.presets.global.explicitlySet],
    ["model", input.presets.model.explicitlySet],
    ...(input.personaEnabled
      ? [["persona", input.presets.persona.explicitlySet] as const]
      : []),
    ["chat", input.presets.chat.explicitlySet],
  ] as const) {
    for (const key of Object.keys(values)) origins[key] = scope;
  }
  const caps = resolveCapabilities({ provider: parameterCapabilities });
  return { stack, ...resolved, origins, capabilities: caps };
}

export function updateScopeValue(
  presets: SettingsPresets,
  scope: SettingsScope,
  key: string,
  value: unknown,
): SettingsPresets {
  return {
    ...presets,
    [scope]: {
      explicitlySet: { ...presets[scope].explicitlySet, [key]: value },
    },
  };
}

export function resetScopeValue(
  presets: SettingsPresets,
  scope: SettingsScope,
  key: string,
): SettingsPresets {
  const values = { ...presets[scope].explicitlySet };
  delete values[key];
  return { ...presets, [scope]: { explicitlySet: values } };
}

export function resetModelToGlobal(presets: SettingsPresets): {
  presets: SettingsPresets;
  reloadContext: boolean;
} {
  const stack = {
    global: presets.global,
    model: presets.model,
    persona: { ...presets.persona, enabled: true },
    chat: presets.chat,
  } satisfies ParameterPresetStack;
  const result = useGlobalParameters(stack);
  return {
    presets: { ...presets, model: { explicitlySet: {} } },
    reloadContext: result.reloadContext,
  };
}

export function scopeChangeNeedsContextReload(
  before: ParameterValues,
  after: ParameterValues,
): boolean {
  return contextReloadIntent(before, after);
}

export const EMPTY_PRESETS: SettingsPresets = {
  global: { explicitlySet: {} },
  model: { explicitlySet: {} },
  persona: { explicitlySet: {} },
  chat: { explicitlySet: {} },
};
