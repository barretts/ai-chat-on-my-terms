import { describe, expect, it } from "vitest";
import type { GeneratedPersona } from "@locallab/personas-generator";
import { BUNDLED_PERSONA_PALETTES, bundledAppearance } from "@locallab/personas-generator";
import { generationDraft } from "./index";

const generated: GeneratedPersona = {
  name: "Harbor",
  description: "A friendly port guide.",
  prompt:
    "You are Harbor. Answer maritime questions warmly and keep replies practical.",
};

describe("generationDraft", () => {
  it("maps the validated reply to editable Persona fields", () => {
    const draft = generationDraft(generated);
    expect(draft.name).toBe("Harbor");
    expect(draft.description).toBe("A friendly port guide.");
    expect(draft.prompt).toContain("You are Harbor");
    expect(
      Object.keys(draft).sort().join(","),
    ).toBe("appearance,description,name,prompt");
  });

  it("assigns owned bundled avatar art deterministically", () => {
    const first = generationDraft(generated).appearance;
    const second = generationDraft({ ...generated }).appearance;
    expect(first).toEqual(second);
    expect(BUNDLED_PERSONA_PALETTES).toContainEqual({
      accentColor: first.accentColor,
      backgroundColor: first.backgroundColor,
    });
    expect(["circle", "square"]).toContain(first.avatarShape);
  });

  it("never carries a memory-sharing switch into the draft", () => {
    const draft = generationDraft(generated);
    expect("profile" in draft).toBe(false);
    expect(JSON.stringify(draft)).not.toContain("memorySharing");
  });

  it("keeps appearance tied to the generated name seed", () => {
    expect(bundledAppearance("Harbor")).toEqual(
      generationDraft(generated).appearance,
    );
    expect(bundledAppearance("Marina")).not.toEqual(
      generationDraft(generated).appearance,
    );
  });
});
