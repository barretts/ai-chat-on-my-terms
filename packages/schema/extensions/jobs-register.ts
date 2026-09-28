import { registerMigration } from "../migrations/registry.js";

export const SCHEDULED_JOBS_MIGRATION = registerMigration(
  "0003-scheduled-jobs",
  new URL("./0003_scheduled_jobs.sql", import.meta.url),
);
