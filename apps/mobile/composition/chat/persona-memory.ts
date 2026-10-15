import {
  SQLitePersonaLibrary,
  type PersonaRunSnapshot,
} from "@locallab/personas-library";
import {
  MemoryExtractionCoordinator,
  SQLiteMemoryStore,
  type MemoryPolicy,
  type MemoryPreferences,
} from "@locallab/memory-extraction";
import { SQLitePersonaMemoryScope, scopedMemoryPolicy } from "@locallab/memory-scope";
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
  const memoryScope = new SQLitePersonaMemoryScope(db);
  await memoryScope.initialize();
  await memory.recoverInterruptedExtractions();
  return {
    personas,
    memory,
    memoryScope,
    memoryExtraction: new MemoryExtractionCoordinator(memory),
  };
}

/** Per-Persona profile switches override the global memory switches. */
export function personaMemoryPolicy(
  identity: Pick<PersonaRunSnapshot, "personaId" | "profile">,
  preferences: MemoryPreferences,
): MemoryPolicy {
  return scopedMemoryPolicy(identity, preferences);
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
