-- 0030_reverify_links.sql — verification pipeline (slice V10): day-one
-- re-verification micro-sessions.
--
-- "Same person on day one": after an offer, the org mints a REVERIFY link tied
-- to the original session. The new hire runs a short micro-session (timeout
-- REVERIFY_TIMEOUT_MIN, easy-band sibling scenario) and re-does the identity
-- step; the fresh enrolment embedding is compared against the ORIGINAL
-- session's anchor. The result lands on identity_checks.{reverify_of,
-- anchor_similarity} (columns authored in dormant 0027 — reverify comparisons
-- only work once 0024+0027 are applied; the link/session plumbing here is not
-- biometric and applies normally).
--
-- Idempotent: safe to re-run.

ALTER TABLE session_links
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'standard'
    CHECK (kind IN ('standard', 'reverify')),
  ADD COLUMN IF NOT EXISTS original_session_id UUID REFERENCES sessions(id);

COMMENT ON COLUMN session_links.kind IS
  'standard = ordinary assessment link; reverify = day-one re-verification micro-session tied to original_session_id.';
COMMENT ON COLUMN session_links.original_session_id IS
  'For kind=reverify: the original assessment session this link re-verifies.';

CREATE INDEX IF NOT EXISTS idx_session_links_original ON session_links (original_session_id);
