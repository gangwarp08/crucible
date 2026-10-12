-- 0028_bgv_checks.sql — verification pipeline (slice V9): claims-verification
-- (BGV) check requests + derived results.
--
-- Stage-1 intake "buy" plug-in: employment/education claims are verified by a
-- commodity vendor (Truework/Argyle in the US; OnGrid/AuthBridge/IDfy in
-- India) behind the BgvProvider adapter (services/bgv/). This table stores
-- the REQUEST and the DERIVED RESULTS only — never documents, never raw
-- vendor payloads beyond the normalized result summary. PII is minimized to
-- the recruiter-supplied candidate_label (the same pseudonymous label used on
-- session links).
--
-- No biometric-class data → applied normally (not counsel-gated like 0024/0027).
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS bgv_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES orgs(id),
  -- Recruiter-facing pseudonymous label — joins to session_links.candidate_label.
  candidate_label TEXT NOT NULL,
  session_link_id UUID REFERENCES session_links(id),
  provider        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'pending', 'complete', 'failed')),
  -- Requested check types, e.g. ["employment","education"].
  checks          JSONB NOT NULL,
  -- Normalized derived results per check:
  --   { employment: { status: 'clear'|'discrepancy'|'unable_to_verify', note },
  --     education:  { ... } }
  results         JSONB,
  -- Vendor-side reference id (webhook correlation).
  external_ref    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE bgv_checks IS
  'Slice V9: BGV/claims-verification requests + normalized derived results (never documents). Vendor behind the BgvProvider adapter; candidate identified by pseudonymous candidate_label only.';

-- RLS parity (0019 posture): deny-all; service role only.
ALTER TABLE bgv_checks ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_bgv_checks_org_label ON bgv_checks (org_id, candidate_label);
CREATE INDEX IF NOT EXISTS idx_bgv_checks_external  ON bgv_checks (external_ref);
