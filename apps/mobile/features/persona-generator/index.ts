import type { PersonaAppearance } from "@locallab/personas-library";
import {
  bundledAppearance,
  type GeneratedPersona,
  type PersonaGenerationResult,
} from "@locallab/personas-generator";

/**
 * Review-before-save is mandatory: a generated profile is only ever handed
 * back as editor fields. Saving still goes through the Persona library, and
 * memory sharing stays off because no generated key touches the profile map.
 */
export interface PersonaGenerationDraft {
  name: string;
  description: string;
  prompt: string;
  appearance: PersonaAppearance;
}

export type PersonaGenerateHandler = (
  idea: string,
  signal: AbortSignal,
) => Promise<PersonaGenerationResult>;

export function generationDraft(
  persona: GeneratedPersona,
): PersonaGenerationDraft {
  return {
    name: persona.name,
    description: persona.description,
    prompt: persona.prompt,
    appearance: bundledAppearance(persona.name),
  };
}
