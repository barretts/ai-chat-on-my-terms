-- Versioned scheduler records for durable mobile and desktop job execution.
CREATE TABLE scheduled_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('streaming', 'download', 'media')),
  idempotency_key TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'canceled', 'failed')),
  progress REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
  started_at TEXT,
  finished_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision_wall_ms INTEGER NOT NULL CHECK (revision_wall_ms >= 0),
  revision_counter INTEGER NOT NULL CHECK (revision_counter >= 0),
  revision_device_id TEXT NOT NULL
);
CREATE INDEX scheduled_jobs_state_category_created
  ON scheduled_jobs (state, category, created_at, id);
