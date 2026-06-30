-- Crucible — partner outcome-invite links (post-5.7 feature)
--
-- A better outcome-capture flow than the static shared-secret webhook: an admin
-- generates a per-session, single-use, expiring link from the review UI and
-- shares it with the hiring partner. The partner opens it (no account, no shared
-- key) and submits real-world outcomes for that ONE candidate. Each link is the
-- auth boundary — high-entropy, scoped to a session, time-limited.
--
-- Only the SHA-256 hash of the token is stored; the raw token lives solely in
-- the URL the admin copies. Status is derived: revoked_at → revoked,
-- submitted_at → submitted, now > expires_at → expired, else active. Single-use
-- (submitted_at blocks re-submit). RLS on, no policies — service-role only.
-- org_id mirrors the 5.7 tenant seam.

CREATE TABLE IF NOT EXISTS outcome_invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT NOT NULL UNIQUE,
  session_id    UUID NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
  scenario_id   UUID          REFERENCES scenarios(id) ON DELETE SET NULL,
  outcome_types TEXT[] NOT NULL DEFAULT '{hired,ramp_weeks,manager_rating_90d,retained_90d}',
  expires_at    TIMESTAMPTZ NOT NULL,
  submitted_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  org_id        UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outcome_invites_session ON outcome_invites (session_id);

ALTER TABLE outcome_invites ENABLE ROW LEVEL SECURITY;

-- Allow partner-form submissions as a distinct source alongside csv/webhook/manual.
ALTER TABLE outcomes DROP CONSTRAINT IF EXISTS outcomes_source_check;
ALTER TABLE outcomes ADD CONSTRAINT outcomes_source_check
  CHECK (source IN ('csv', 'webhook', 'manual', 'partner_form'));
