import { describe, expect, it } from "vitest";
import {
  EMPTY_PRESETS,
  resetModelToGlobal,
  resetScopeValue,
  resolveSettings,
  scopeChangeNeedsContextReload,
  updateScopeValue,
} from "./index";

describe("per-chat parameter settings", () => {
  it("applies precedence while persisting false and exposing the winning origin", () => {
    let presets = updateScopeValue(EMPTY_PRESETS, "global", "reasoning", true);
    presets = updateScopeValue(presets, "model", "temperature", 0.8);
    presets = updateScopeValue(presets, "persona", "reasoning", false);
    presets = updateScopeValue(presets, "chat", "temperature", 0.2);
    presets = updateScopeValue(presets, "chat", "json_mode", false);
    const result = resolveSettings({
      presets,
      personaEnabled: true,
      capabilities: {
        reasoning: "yes",
        "parameter.temperature": "yes",
        structuredOutput: "yes",
      },
    });
    expect(result.effective.temperature).toBe(0.2);
    expect(result.effective.reasoning).toBe(false);
    expect(result.effective.json_mode).toBe(false);
    expect(result.origins).toMatchObject({
      temperature: "chat",
      reasoning: "persona",
    });
    expect(result.outbound).toMatchObject({
      reasoning: false,
      json_mode: false,
    });
  });

  it("retains unsupported values locally without sending them", () => {
    let presets = updateScopeValue(EMPTY_PRESETS, "model", "top_k", 40);
    presets = updateScopeValue(presets, "chat", "flash_attention", true);
    const result = resolveSettings({
      presets,
      personaEnabled: false,
      capabilities: { "parameter.top_k": "no" },
    });
    expect(result.effective.top_k).toBe(40);
    expect(result.unsupported.top_k?.support).toBe("no");
    expect(result.unsupported.flash_attention?.support).toBe("unknown");
    expect(result.outbound).not.toHaveProperty("top_k");
    expect(result.outbound).not.toHaveProperty("flash_attention");
  });

  it("resets only the selected scope and Use Global clears the model layer", () => {
    let presets = updateScopeValue(EMPTY_PRESETS, "global", "temperature", 0.5);
    presets = updateScopeValue(presets, "model", "contextWindow", 8192);
    presets = updateScopeValue(presets, "chat", "reasoning", false);
    const oneReset = resetScopeValue(presets, "chat", "reasoning");
    expect(oneReset.global.explicitlySet.temperature).toBe(0.5);
    expect(oneReset.model.explicitlySet.contextWindow).toBe(8192);
    expect(oneReset.chat.explicitlySet).not.toHaveProperty("reasoning");
    const global = resetModelToGlobal(presets);
    expect(global.presets.model.explicitlySet).toEqual({});
    expect(global.presets.chat.explicitlySet.reasoning).toBe(false);
    expect(global.reloadContext).toBe(true);
  });

  it("requests reload only for context-related changes", () => {
    expect(
      scopeChangeNeedsContextReload({ temperature: 0.2 }, { temperature: 0.7 }),
    ).toBe(false);
    expect(
      scopeChangeNeedsContextReload(
        { contextWindow: 4096 },
        { contextWindow: 8192 },
      ),
    ).toBe(true);
    expect(scopeChangeNeedsContextReload({}, { "load.gpu_layers": 12 })).toBe(
      true,
    );
  });
});
