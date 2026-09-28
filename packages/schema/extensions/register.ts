import { registerMigration } from "../migrations/registry.js";

/** Load exactly once before invoking migrateSQLite to enable optional tables. */
export const OPTIONAL_FEATURES_MIGRATION = registerMigration(
  "0002-optional-features",
  new URL("./0002_optional_features.sql", import.meta.url),
);
