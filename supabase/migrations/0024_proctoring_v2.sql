-- 0024_proctoring_v2.sql — P6 (proctoring v2, DORMANT): identity_checks.
--
-- ⚠ AUTHORED, NOT APPLIED. P6 ships dormant: this migration must not be run
-- until counsel signs off consent language + data-handling for the target
-- jurisdiction (biometric / government-ID capture is BIPA / GDPR-class data).
-- The server code is skip-graceful when this table is absent.
--
-- DATA MINIMIZATION (the load-bearing property): identity_checks stores
-- DERIVED results only — a consent decision, a match confidence, a verified
-- boolean. RAW FRAMES (ID photo, selfie, webcam samples) ARE NEVER PERSISTED
-- anywhere: the server processes the two candidate-submitted images in memory
-- (services/proctoring-v2.ts) and discards them; webcam presence frames never
-- leave the browser at all. There is deliberately NO column that could hold
-- image bytes. Deletion path: services/proctoring-v2.ts deleteIdentityData
-- hard-deletes rows (org-scoped) — plus ON DELETE CASCADE with the session.
--
-- One row per session (the consent recording), updated in place with the
-- verification result if the candidate attempts identity verification.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS identity_checks (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  org_id               UUID NOT NULL REFERENCES orgs(id),
  -- Version of the consent text the candidate actually saw (versioned consent
  -- recording — P6.1). Bumped in services/proctoring-v2.ts whenever the text
  -- changes.
  consent_text_version TEXT NOT NULL,
  consented_at         TIMESTAMPTZ NOT NULL,
  -- The recorded decision. 'decline' downgrades the session to v1 passive
  -- proctoring (signed-off policy) — no webcam, no identity capture.
  decision             TEXT NOT NULL CHECK (decision IN ('accept', 'decline')),
  -- Derived verification result (NULL until / unless verification runs).
  match_confidence     NUMERIC,
  verified             BOOLEAN,
  provider             TEXT NOT NULL DEFAULT 'gateway-vision',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE identity_checks IS
  'P6 proctoring-v2 consent + identity-verification results. DERIVED DATA ONLY: raw frames (ID photo, selfie, webcam samples) are never persisted — images are processed in memory and discarded. Org-scoped; hard-deletable via the identity-delete endpoint (biometric minimization).';

-- RLS parity with the rest of the schema (0019 posture): ENABLED with ZERO
-- policies = deny-all for anon/authenticated. All app traffic uses the
-- service role; org isolation is enforced at the app layer (org_id scoping in
-- services/proctoring-v2.ts + routes behind requireOrg).
ALTER TABLE identity_checks ENABLE ROW LEVEL SECURITY;

-- Org-scoped reads (review surface) and org-scoped deletion.
CREATE INDEX IF NOT EXISTS idx_identity_checks_org     ON identity_checks (org_id);
CREATE INDEX IF NOT EXISTS idx_identity_checks_session ON identity_checks (session_id);
