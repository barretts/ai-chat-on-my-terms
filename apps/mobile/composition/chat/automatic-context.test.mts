import { describe, expect, it } from "vitest";
import {
  EMPTY_PRESETS,
  resetScopeValue,
  resolveSettings,
  updateScopeValue,
  type SettingsPresets,
  type SettingsScope,
} from "../../features/chat-settings/index";

const capabilities = {
  "parameter.contextWindow": "yes",
  "parameter.max_output_tokens": "yes",
  "parameter.temperature": "yes",
  reasoning: "yes",
} as const;

function resolve(
  presets: SettingsPresets = EMPTY_PRESETS,
  serverContextWindow: number | undefined = 65536,
  personaEnabled = true,
) {
  return resolveSettings({
    presets,
    capabilities,
    personaEnabled,
    ...(serverContextWindow === undefined ? {} : { serverContextWindow }),
  });
}

function frozenPresets(presets: SettingsPresets): SettingsPresets {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(presets).map(([scope, preset]) => [
        scope,
        Object.freeze({
          explicitlySet: Object.freeze({ ...preset.explicitlySet }),
        }),
      ]),
    ),
  ) as SettingsPresets;
}

describe("automatic server context defaults", () => {
  it("uses the selected server's 64K capacity when no context override is saved", () => {
    const presets = frozenPresets(
      updateScopeValue(EMPTY_PRESETS, "chat", "max_output_tokens", 512),
    );
    const result = resolve(presets);
    expect(result.effective.contextWindow).toBe(65536);
    expect(result.origins.contextWindow).toBe("server");
    expect(result.outbound.max_output_tokens).toBe(512);
    expect(presets.global.explicitlySet).not.toHaveProperty("contextWindow");
    expect(presets.chat.explicitlySet).toEqual({ max_output_tokens: 512 });
  });

  it.each([
    ["global", 8192],
    ["model", 16384],
    ["persona", 32768],
    ["chat", 49152],
  ] as const)(
    "preserves an explicit %s context above the automatic default's priority",
    (scope, contextWindow) => {
      const presets = frozenPresets(
        updateScopeValue(EMPTY_PRESETS, scope, "contextWindow", contextWindow),
      );
      const result = resolve(presets);
      expect(result.effective.contextWindow).toBe(contextWindow);
      expect(result.origins.contextWindow).toBe(scope);
      expect(presets[scope].explicitlySet.contextWindow).toBe(contextWindow);
    },
  );

  it("keeps global, model, persona and chat precedence as higher scopes are added and reset", () => {
    let presets = EMPTY_PRESETS;
    const layers: Array<[SettingsScope, number]> = [
      ["global", 8192],
      ["model", 16384],
      ["persona", 32768],
      ["chat", 49152],
    ];
    for (const [scope, contextWindow] of layers) {
      presets = updateScopeValue(
        presets,
        scope,
        "contextWindow",
        contextWindow,
      );
      const result = resolve(presets);
      expect(result.effective.contextWindow).toBe(contextWindow);
      expect(result.origins.contextWindow).toBe(scope);
    }
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      presets = resetScopeValue(presets, layers[index]![0], "contextWindow");
      const result = resolve(presets);
      expect(result.effective.contextWindow).toBe(
        index === 0 ? 65536 : layers[index - 1]![1],
      );
      expect(result.origins.contextWindow).toBe(
        index === 0 ? "server" : layers[index - 1]![0],
      );
    }
  });

  it("ignores a disabled persona context and preserves the preceding explicit scope", () => {
    const personaOnly = updateScopeValue(
      EMPTY_PRESETS,
      "persona",
      "contextWindow",
      32768,
    );
    expect(resolve(personaOnly, 65536, false).effective.contextWindow).toBe(
      65536,
    );
    expect(resolve(personaOnly, 65536, false).origins.contextWindow).toBe(
      "server",
    );
    const withModel = updateScopeValue(
      personaOnly,
      "model",
      "contextWindow",
      8192,
    );
    const result = resolve(withModel, 65536, false);
    expect(result.effective.contextWindow).toBe(8192);
    expect(result.origins.contextWindow).toBe("model");
    expect(withModel.persona.explicitlySet.contextWindow).toBe(32768);
  });

  it("resets a chat context to automatic without rewriting saved values or other controls", () => {
    let presets = updateScopeValue(EMPTY_PRESETS, "global", "temperature", 0.7);
    presets = updateScopeValue(presets, "chat", "reasoning", false);
    presets = updateScopeValue(presets, "chat", "contextWindow", 4096);
    presets = frozenPresets(presets);
    const before = JSON.stringify(presets);
    const reset = resetScopeValue(presets, "chat", "contextWindow");
    const result = resolve(reset);
    expect(result.effective.contextWindow).toBe(65536);
    expect(result.origins.contextWindow).toBe("server");
    expect(result.effective.temperature).toBe(0.7);
    expect(result.effective.reasoning).toBe(false);
    expect(reset.chat.explicitlySet).toEqual({ reasoning: false });
    expect(reset.global.explicitlySet).toEqual({ temperature: 0.7 });
    expect(JSON.stringify(presets)).toBe(before);
    expect(presets.chat.explicitlySet.contextWindow).toBe(4096);
  });

  it.each([
    undefined,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "leaves the fallback available when server capacity is absent or invalid (%s)",
    (serverContextWindow) => {
      // The send boundary applies its conservative fallback when no effective
      // context is present; discovery must not invent or persist an override.
      const result = resolveSettings({
        presets: EMPTY_PRESETS,
        capabilities,
        personaEnabled: true,
        ...(serverContextWindow === undefined ? {} : { serverContextWindow }),
      });
      expect(result.effective).not.toHaveProperty("contextWindow");
      expect(result.origins).not.toHaveProperty("contextWindow");
      const explicit = updateScopeValue(
        EMPTY_PRESETS,
        "model",
        "contextWindow",
        8192,
      );
      const saved = resolveSettings({
        presets: explicit,
        capabilities,
        personaEnabled: true,
        ...(serverContextWindow === undefined ? {} : { serverContextWindow }),
      });
      expect(saved.effective.contextWindow).toBe(8192);
      expect(saved.origins.contextWindow).toBe("model");
    },
  );

  it("refreshes an automatic capacity without mutating the source presets or capability input", () => {
    const presets = frozenPresets(
      updateScopeValue(
        EMPTY_PRESETS,
        "persona",
        "systemPrompt",
        "Keep my persona.",
      ),
    );
    const sourceCapabilities = Object.freeze({ ...capabilities });
    const input = Object.freeze({
      presets,
      capabilities: sourceCapabilities,
      personaEnabled: true,
      serverContextWindow: 65536,
    });
    const before = JSON.stringify(input);
    const first = resolveSettings(input);
    const refreshed = resolveSettings({ ...input, serverContextWindow: 32768 });
    expect(first.effective.contextWindow).toBe(65536);
    expect(refreshed.effective.contextWindow).toBe(32768);
    expect(refreshed.origins.contextWindow).toBe("server");
    expect(refreshed.effective.systemPrompt).toBe("Keep my persona.");
    expect(JSON.stringify(input)).toBe(before);
    for (const preset of Object.values(presets))
      expect(preset.explicitlySet).not.toHaveProperty("contextWindow");
  });
});
