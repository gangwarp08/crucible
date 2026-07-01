-- 0016_session_links.sql — RD6 (Slice 6.7): single-use candidate session links.
--
-- The candidate start-gate was a single shared, reusable INVITE_CODE — same
-- code for everyone, no binding, no expiry, infinitely reusable. For the
-- outcome loop to mean anything, the scored person must be the one the partner
-- can later report on. This adds unguessable, candidate-bound, time-boxed links
-- that are CONSUMED on first start (not reusable) and bound to the session at
-- start so a link can't be shared mid-session.
--
-- Only the SHA-256 hash of the token is stored (the raw token lives only in the
-- URL handed to the candidate). Status is derived, never stored: revoked_at →
-- revoked, consumed_at → consumed, now > expires_at → expired, else active.
-- session_id is a plain audit reference (no FK) so binding never races the
-- session-row persist.

CREATE TABLE IF NOT EXISTS session_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      TEXT NOT NULL UNIQUE,
  candidate_label TEXT NOT NULL,           -- who the partner attests took it
  scenario_id     UUID REFERENCES scenarios(id),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,             -- set atomically on first start
  session_id      UUID,                    -- bound session (audit ref, no FK)
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_links_token_hash_idx ON session_links (token_hash);

-- RLS parity with the rest of the schema: server uses the service role, which
-- bypasses RLS; no anon/authenticated policy is granted, so the browser can
-- never read token hashes directly.
ALTER TABLE session_links ENABLE ROW LEVEL SECURITY;
