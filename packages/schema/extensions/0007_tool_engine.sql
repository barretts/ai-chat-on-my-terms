-- Immutable additive migration. Future changes receive a new numeric version.
CREATE TABLE IF NOT EXISTS tool_engine_invocations (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL, entity_json TEXT NOT NULL CHECK(json_valid(entity_json)));
CREATE INDEX IF NOT EXISTS tool_engine_invocations_run ON tool_engine_invocations(run_id);
CREATE TABLE IF NOT EXISTS tool_engine_clock (device_id TEXT PRIMARY KEY NOT NULL, wall_ms INTEGER NOT NULL, counter INTEGER NOT NULL);
