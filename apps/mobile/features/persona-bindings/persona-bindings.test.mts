import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CHOICE,
  personaModelChoice,
  personaModelChoices,
  personaProfileWithModel,
} from ".";

const REMOVED = "0195c000-0000-7000-8000-0000000000ff";

describe("persona model bindings", () => {
  it("binds the connection identity, never the display label", () => {
    const profile = personaProfileWithModel(
      { nickname: "keep" },
      "0195c000-0000-7000-8000-0000000000a1",
    );
    expect(JSON.stringify(profile)).not.toMatch("Lab — llama");
    expect(profile.model).toEqual({
      connectionId: "0195c000-0000-7000-8000-0000000000a1",
    });
    expect(profile.nickname).toBe("keep");
    expect(personaModelChoice(profile)).toBe(
      "0195c000-0000-7000-8000-0000000000a1",
    );
  });

  it("clears the binding explicitly", () => {
    const bound = personaProfileWithModel(undefined, "0195c000-0000-7000-8000-0000000000a1");
    const cleared = personaProfileWithModel(bound, null);
    expect(cleared.model).toBeUndefined();
    expect(personaModelChoice(cleared)).toBe(DEFAULT_MODEL_CHOICE);
  });

  it("keeps a removed binding visible instead of silently replacing it", () => {
    const choices = personaModelChoices(
      [
        {
          id: "0195c000-0000-7000-8000-0000000000a1",
          label: "Lab",
          modelId: "llama",
        },
      ],
      REMOVED,
    );
    expect(choices[0]).toEqual({
      value: DEFAULT_MODEL_CHOICE,
      label: "Use this chat's model",
    });
    expect(choices[1]?.value).toBe(REMOVED);
    expect(choices[1]?.label).toMatch(/Removed binding/);
  });
});
