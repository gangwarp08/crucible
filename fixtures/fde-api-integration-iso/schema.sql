-- fde-api-integration-iso-v1 synthetic schema (GENERATED — do not edit by hand)
-- Runs in SQLite (the sandbox customer.db is built with python sqlite3).
-- Regenerate via:  pnpm exec tsx fixtures/fde-api-integration-iso/generate.ts

DROP TABLE IF EXISTS api_requests;
DROP TABLE IF EXISTS provider_contacts;
DROP TABLE IF EXISTS local_contacts;

-- Request log of the nightly ContactHub sync run (client side).
CREATE TABLE api_requests (
  id           TEXT PRIMARY KEY,
  endpoint     TEXT NOT NULL,
  method       TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  cursor       TEXT,
  next_cursor  TEXT,
  retry_of     TEXT,
  requested_at TEXT NOT NULL
);
CREATE INDEX api_requests_status ON api_requests (status_code);
CREATE INDEX api_requests_cursor ON api_requests (cursor);

-- The provider's full contact export (source of truth).
CREATE TABLE provider_contacts (
  external_id TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX provider_contacts_updated_at ON provider_contacts (updated_at);

-- Our synced local copy (what the integration actually wrote).
CREATE TABLE local_contacts (
  id          TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX local_contacts_external_id ON local_contacts (external_id);
