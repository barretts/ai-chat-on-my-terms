-- PostgreSQL service metadata. Relay payloads and conversation history are
-- end-to-end encrypted and are never persisted in this schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS locallab;

CREATE TABLE locallab.pairing_routes (
  route_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_device_id UUID NOT NULL,
  peer_device_id UUID,
  public_key_fingerprint BYTEA NOT NULL CHECK (octet_length(public_key_fingerprint) = 32),
  state TEXT NOT NULL CHECK (state IN ('pending', 'paired', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paired_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (peer_device_id IS NULL OR peer_device_id <> owner_device_id)
);
CREATE INDEX pairing_routes_expiry ON locallab.pairing_routes (expires_at) WHERE state IN ('pending', 'paired');

CREATE TABLE locallab.pairing_ticket_digests (
  ticket_digest BYTEA PRIMARY KEY CHECK (octet_length(ticket_digest) = 32),
  route_id UUID NOT NULL REFERENCES locallab.pairing_routes(route_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE locallab.relay_connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID NOT NULL REFERENCES locallab.pairing_routes(route_id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  UNIQUE (route_id, device_id, connection_id)
);
CREATE INDEX relay_connections_active ON locallab.relay_connections (route_id, last_seen_at) WHERE disconnected_at IS NULL;

CREATE TABLE locallab.sync_device_cursors (
  route_id UUID NOT NULL REFERENCES locallab.pairing_routes(route_id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  acknowledged_sequence BIGINT NOT NULL DEFAULT 0 CHECK (acknowledged_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id, device_id)
);

CREATE TABLE locallab.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_subject TEXT,
  category TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 20000),
  diagnostic_consent BOOLEAN NOT NULL DEFAULT FALSE,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'triaged', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE locallab.backup_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_subject TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  ciphertext_sha256 BYTEA NOT NULL CHECK (octet_length(ciphertext_sha256) = 32),
  ciphertext_bytes BIGINT NOT NULL CHECK (ciphertext_bytes >= 0),
  format_version INTEGER NOT NULL CHECK (format_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE TABLE locallab.entitlement_snapshots (
  account_subject TEXT PRIMARY KEY,
  entitlements JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(entitlements) = 'array'),
  valid_until TIMESTAMPTZ NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE locallab.service_metrics (
  metric_name TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  dimensions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(dimensions) = 'object'),
  count BIGINT NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (metric_name, bucket_start, dimensions)
);
