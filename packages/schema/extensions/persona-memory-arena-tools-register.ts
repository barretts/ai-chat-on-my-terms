import { registerMigration } from "../migrations/registry.js";

export const PERSONA_LIBRARY_MIGRATION = registerMigration(
  "0004-persona-library",
  new URL("./0004_persona_library.sql", import.meta.url),
);
export const MEMORY_EXTRACTION_MIGRATION = registerMigration(
  "0005-memory-extraction",
  new URL("./0005_memory_extraction.sql", import.meta.url),
);
export const ARENA_ENGINE_MIGRATION = registerMigration(
  "0006-arena-engine",
  new URL("./0006_arena_engine.sql", import.meta.url),
);
export const TOOL_ENGINE_MIGRATION = registerMigration(
  "0007-tool-engine",
  new URL("./0007_tool_engine.sql", import.meta.url),
);
