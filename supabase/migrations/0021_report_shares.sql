-- 0021_report_shares.sql — P4.3: tokenized shareable candidate-report links.
--
-- A report_shares row grants PUBLIC (no org key, no login) read access to the
-- EXTERNAL-SAFE subset of one session's evaluation via GET /api/report/:token.
-- Same token discipline as session_links / outcome_invites (0016 / 0013):
-- only the SHA-256 of the raw token is stored — the raw 32-byte base64url
-- token is returned exactly once at mint time and lives only in the URL the
-- recruiter shares. Links are expiring (expires_at, TTL capped at 720h by the
-- mint route) and revocable (revoked_at); status is DERIVED, never stored:
-- revoked_at → revoked, now > expires_at → expired, else active.
--
-- org_id stamps the OWNING tenant (the session's org, not necessarily the
-- requesting org — an admin minting a share for a partner's session must not
-- pull it into the admin org). ON DELETE CASCADE from sessions: a deleted
-- session takes its share links with it. No cascade from orgs — deleting a
-- tenant with live share links should fail loudly, not silently orphan them.

CREATE TABLE IF NOT EXISTS report_shares (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 hex of the raw share token
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  org_id     UUID NOT NULL REFERENCES orgs(id),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Share management is listed per session (GET /api/review/sessions/:id/shares).
CREATE INDEX IF NOT EXISTS report_shares_session ON report_shares (session_id);

-- RLS parity with the rest of the schema (see 0019): ENABLED with ZERO
-- policies = deny-all for anon/authenticated. All access goes through the
-- server's service-role client; the PUBLIC report endpoint authenticates by
-- token hash at the app layer, never by exposing this table.
ALTER TABLE report_shares ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE report_shares IS
  'P4.3 shareable candidate-report links: sha256-hashed raw token (shown once), expiring + revocable, org-stamped. Public GET /api/report/:token authenticates by token hash; RLS deny-all backstop.';
