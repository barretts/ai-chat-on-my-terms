-- Immutable additive migration (GR-13 persona group chats, T170).
-- Core tables are never altered. group_rooms/group_participants mirror
-- SQLiteGroupConfigStore.initialize exactly so fresh and existing databases
-- reach the identical shape; the versioned ledger owns them from here on.
-- All new state rides side tables (settings, prefs, rounds, runs, mapping).
CREATE TABLE IF NOT EXISTS group_rooms (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  scenario TEXT NOT NULL DEFAULT '',
  user_display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS group_participants (
  id TEXT PRIMARY KEY NOT NULL,
  group_room_id TEXT NOT NULL REFERENCES group_rooms(id),
  persona_id TEXT,
  provider_connection_id TEXT,
  model_id TEXT,
  display_name TEXT NOT NULL,
  accent_color TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  voice_json TEXT,
  tools_enabled INTEGER NOT NULL DEFAULT 0,
  turn_order INTEGER NOT NULL
);
-- Room settings (Conversation/Order/Reply display/Shared model/Response limit).
CREATE TABLE IF NOT EXISTS group_room_settings (
  room_id TEXT PRIMARY KEY NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
  conversation_mode TEXT NOT NULL DEFAULT 'discussion'
    CHECK (conversation_mode IN ('discussion', 'independent')),
  speaker_order TEXT NOT NULL DEFAULT 'round-robin'
    CHECK (speaker_order IN ('round-robin', 'dice', 'topic-interest')),
  reply_display TEXT NOT NULL DEFAULT 'complete'
    CHECK (reply_display IN ('complete', 'live')),
  shared_model_id TEXT,
  response_limit_tokens INTEGER NOT NULL DEFAULT 256,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Per-participant Drunk flag; absent row means off.
CREATE TABLE IF NOT EXISTS group_participant_prefs (
  participant_id TEXT PRIMARY KEY NOT NULL REFERENCES group_participants(id) ON DELETE CASCADE,
  drunk INTEGER NOT NULL DEFAULT 0 CHECK (drunk IN (0, 1))
);
-- One row per automatic round: what started it, the frozen speaker order and
-- the settings snapshot in force at round start (identity freeze, GR-13).
CREATE TABLE IF NOT EXISTS group_rounds (
  id TEXT PRIMARY KEY NOT NULL,
  group_room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('send', 'pass', 'ask')),
  frozen_order_json TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'stopped', 'failed')),
  seat_cursor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS group_rounds_room_idx
  ON group_rounds(group_room_id, created_at);
-- Per-speaker run inside a round; seat_index is the frozen turn_order slot.
CREATE TABLE IF NOT EXISTS group_runs (
  id TEXT PRIMARY KEY NOT NULL,
  group_round_id TEXT NOT NULL REFERENCES group_rounds(id) ON DELETE CASCADE,
  seat_index INTEGER NOT NULL,
  participant_id TEXT,
  model_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS group_runs_round_idx
  ON group_runs(group_round_id, seat_index);
-- Conversations dedicated to a room (kind marker without altering core).
CREATE TABLE IF NOT EXISTS group_room_conversations (
  conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  group_room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
