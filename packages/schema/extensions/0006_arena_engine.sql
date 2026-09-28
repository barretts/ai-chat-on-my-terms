-- Immutable additive migration. Future changes receive a new numeric version.
CREATE TABLE IF NOT EXISTS arena_runs (
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','completed','canceled','interrupted')),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision_wall_ms INTEGER NOT NULL CHECK (revision_wall_ms >= 0),
  revision_counter INTEGER NOT NULL CHECK (revision_counter >= 0),
  revision_device_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS arena_contestants (
  id TEXT PRIMARY KEY NOT NULL,
  arena_run_id TEXT NOT NULL REFERENCES arena_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','canceled','interrupted')),
  provider_connection_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision_wall_ms INTEGER NOT NULL CHECK (revision_wall_ms >= 0),
  revision_counter INTEGER NOT NULL CHECK (revision_counter >= 0),
  revision_device_id TEXT NOT NULL,
  UNIQUE (arena_run_id, position)
);
CREATE INDEX IF NOT EXISTS arena_runs_state_updated ON arena_runs(state, updated_at);
CREATE INDEX IF NOT EXISTS arena_contestants_run_position ON arena_contestants(arena_run_id, position);
