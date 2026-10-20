import { registerMigration } from "../migrations/registry.js";

export const GROUP_CHAT_MIGRATION = registerMigration(
  "0009-group-chat",
  new URL("./0009_group_chat.sql", import.meta.url),
);
