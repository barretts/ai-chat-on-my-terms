CREATE TABLE IF NOT EXISTS chat_history_allocations (
      allocation_key TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_history_metadata (
      conversation_id TEXT PRIMARY KEY NOT NULL,
      model_id TEXT,
      last_used_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS response_variants (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      content_json TEXT NOT NULL CHECK (json_valid(content_json)),
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1)),
      UNIQUE (message_id, generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS response_variant_selected
      ON response_variants(message_id) WHERE selected = 1;
    CREATE TABLE IF NOT EXISTS server_continuations (
      message_id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      context_fingerprint TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
      updated_at TEXT NOT NULL
    );
CREATE TABLE IF NOT EXISTS blob_import_intents (
        id TEXT PRIMARY KEY NOT NULL,
        intent_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_blobs (
        id TEXT PRIMARY KEY NOT NULL,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        managed_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blob_references (
        blob_id TEXT NOT NULL REFERENCES managed_blobs(id) ON DELETE CASCADE,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        PRIMARY KEY (blob_id, owner_type, owner_id)
      );
      CREATE INDEX IF NOT EXISTS blob_references_owner
        ON blob_references(owner_type, owner_id);
      CREATE TABLE IF NOT EXISTS blob_leases (
        token TEXT PRIMARY KEY NOT NULL,
        blob_id TEXT NOT NULL REFERENCES managed_blobs(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS blob_leases_blob ON blob_leases(blob_id);
CREATE TABLE IF NOT EXISTS chat_attachments (
        id TEXT PRIMARY KEY NOT NULL,
        blob_ref TEXT NOT NULL REFERENCES managed_blobs(id) ON DELETE CASCADE,
        descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json))
      );
      CREATE TABLE IF NOT EXISTS chat_attachment_owners (
        owner_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL REFERENCES chat_attachments(id) ON DELETE CASCADE,
        PRIMARY KEY(owner_id,attachment_id)
      );
      CREATE INDEX IF NOT EXISTS chat_attachment_blob ON chat_attachments(blob_ref);
CREATE TABLE IF NOT EXISTS generation_lifecycle (
        run_id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        execution TEXT NOT NULL CHECK (execution IN ('local','remote')),
        remote_job_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('running','remote_pending','interrupted','completed','canceled','failed')),
        last_sequence INTEGER NOT NULL DEFAULT -1 CHECK (last_sequence >= -1),
        partial_text TEXT NOT NULL DEFAULT '',
        partial_reasoning TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        last_notified_characters INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS generation_lifecycle_conversation_updated
      ON generation_lifecycle(conversation_id, updated_at);
