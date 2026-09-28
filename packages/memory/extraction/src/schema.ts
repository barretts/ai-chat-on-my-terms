/** Additive schema. The coordinator also registers this with the migration allocator. */
export const MEMORY_EXTRACTION_SCHEMA_SQL = `
CREATE INDEX IF NOT EXISTS memory_items_content_key
  ON memory_items(namespace,json_extract(metadata_json,'$.contentKey'));
CREATE TABLE IF NOT EXISTS memory_revision_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','tombstone')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);
CREATE INDEX IF NOT EXISTS memory_revision_log_entity ON memory_revision_log(memory_id,sequence);
CREATE TABLE IF NOT EXISTS memory_extraction_runs (
  run_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','completed','failed','interrupted')),
  claim_token TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id,scope_key)
);
CREATE TABLE IF NOT EXISTS memory_preferences (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json))
);
CREATE TABLE IF NOT EXISTS memory_clock (
  device_id TEXT PRIMARY KEY NOT NULL,
  wall_ms INTEGER NOT NULL CHECK (wall_ms >= 0),
  counter INTEGER NOT NULL CHECK (counter >= 0)
);
`;
