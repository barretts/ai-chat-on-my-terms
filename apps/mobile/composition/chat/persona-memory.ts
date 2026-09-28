import {
  DEFAULT_PERSONA_ID,
  SQLitePersonaLibrary,
  type PersonaRunSnapshot,
} from "@locallab/personas-library";
import {
  MemoryExtractionCoordinator,
  SQLiteMemoryStore,
  type MemoryPolicy,
  type MemoryPreferences,
} from "@locallab/memory-extraction";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

/** The app migration runner creates the base optional tables before these stores open. */
export async function initializePersonaMemoryChat(
  db: SQLiteDatabasePort,
  createId: () => string,
) {
  const personas = new SQLitePersonaLibrary(db, { createId });
  await personas.initialize();
  const memory = new SQLiteMemoryStore(db, { createId });
  await memory.initialize();
  await memory.recoverInterruptedExtractions();
  return {
    personas,
    memory,
    memoryExtraction: new MemoryExtractionCoordinator(memory),
  };
}

/** Custom Personas keep their own facts until explicit sharing is implemented. */
export function personaMemoryPolicy(
  identity: Pick<PersonaRunSnapshot, "personaId">,
  preferences: MemoryPreferences,
): MemoryPolicy {
  const isDefault = identity.personaId === DEFAULT_PERSONA_ID;
  return {
    extract: preferences.extractionEnabled,
    inject: preferences.injectionEnabled,
    scope: isDefault
      ? { scope: "global", scopeId: null }
      : { scope: "persona", scopeId: identity.personaId },
    includeGlobal: isDefault,
  };
}

export function personaSystemPrompt(
  identity: PersonaRunSnapshot,
  chatPrompt: unknown,
  memoryPrompt?: string,
): string {
  return [
    identity.prompt,
    typeof chatPrompt === "string" ? chatPrompt : "",
    memoryPrompt ?? "",
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Only explicit model template controls carry into background extraction. */
export function memoryModelControlPrompt(systemPrompt: unknown): string {
  if (typeof systemPrompt !== "string") return "";
  if (systemPrompt.includes("<|think_off|>")) return "<|think_off|>";
  if (systemPrompt.includes("<|think_on|>")) return "<|think_on|>";
  return "";
}
