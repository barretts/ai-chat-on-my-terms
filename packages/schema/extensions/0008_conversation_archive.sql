-- Immutable additive migration. Future changes receive a new numeric version.
-- Core tables are never altered; archive state is a side table like folder memberships.
-- A row means the conversation is archived (hidden from Recent); deleting the row unarchives it.
CREATE TABLE IF NOT EXISTS conversation_archive_state (
  conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  archived_at TEXT NOT NULL
);
-- Attachment/blob owners released after a conversation delete commits. Rows survive a
-- crash between the SQL delete and managed-file cleanup, so cleanup resumes on next launch.
CREATE TABLE IF NOT EXISTS conversation_delete_cleanups (
  owner_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
