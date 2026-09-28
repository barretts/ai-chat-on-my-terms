/** Additive Persona metadata. The existing optional personas table remains authoritative. */
export const PERSONA_LIBRARY_SQL = `
CREATE TABLE IF NOT EXISTS persona_profiles (
  persona_id TEXT PRIMARY KEY NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  photo_attachment_id TEXT,
  model_id TEXT,
  parameter_preset_id TEXT,
  revision_wall_ms INTEGER NOT NULL CHECK(revision_wall_ms >= 0),
  revision_counter INTEGER NOT NULL CHECK(revision_counter >= 0),
  revision_device_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS persona_library_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS persona_tombstones (
  entity_id TEXT PRIMARY KEY NOT NULL,
  tombstone_json TEXT NOT NULL CHECK(json_valid(tombstone_json))
);
CREATE TABLE IF NOT EXISTS conversation_personas (
  conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
  selected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS persona_run_snapshots (
  run_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS persona_run_snapshots_conversation ON persona_run_snapshots(conversation_id);
`;
