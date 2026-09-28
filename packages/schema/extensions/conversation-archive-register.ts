import { registerMigration } from "../migrations/registry.js";

export const CONVERSATION_ARCHIVE_MIGRATION = registerMigration(
  "0008-conversation-archive",
  new URL("./0008_conversation_archive.sql", import.meta.url),
);
