-- Crucible — L6 reliability + version stamping + tenant seam (Slice 5.7, Q4/Q5)
--
-- Three things, all additive + nullable so nothing breaks on re-score:
--
-- 1. VERSION STAMPS on evaluations. competency_model_version landed in 5.1; this
--    adds the other three legs so every verdict records the full provenance of
--    how it was produced (Q5 — all nullable, so historical rows stay valid):
--      detector_version      — services/evidence-extractor.ts DETECTOR_VERSION
--      judge_prompt_version  — services/analysis-agent.ts JUDGE_PROMPT_VERSION
--      scenario_version      — scenarios.version (added below)
--    When any stamp changes, the held-out anchor set can be re-scored and drift
--    flagged (verify-drift). scenarios.version is the bumpable content version.
--
-- 2. scenario_stats — per-(scenario, competency) running aggregates computed as
--    sessions accrue (proto-difficulty: mean score + pass rate + n). Recomputed
--    by services/scenario-stats.ts after each evaluation persists.
--
-- 3. TENANT SEAM — nullable org_id on the candidate-facing tables. This is the
--    multi-tenant seam ONLY: no orgs table and no RLS isolation policies yet
--    (the server uses the service role, which bypasses RLS; real per-tenant
--    policies need an auth/tenant context that arrives with v2). RLS stays
--    enabled-with-no-policies on every table, matching the existing convention.

-- ── 1. Version stamps ───────────────────────────────────────────────────────
ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS detector_version     TEXT;
ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS judge_prompt_version TEXT;
ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS scenario_version     INTEGER;

ALTER TABLE scenarios   ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- ── 2. scenario_stats ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scenario_stats (
  scenario_id    UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  competency_key TEXT NOT NULL,
  n              INTEGER NOT NULL DEFAULT 0,
  mean_score     NUMERIC,
  pass_rate      NUMERIC,            -- fraction of evals with score >= 3 (meets bar)
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, competency_key)
);
ALTER TABLE scenario_stats ENABLE ROW LEVEL SECURITY;

-- ── 3. Tenant seam (nullable org_id; no policies yet) ───────────────────────
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE outcomes  ADD COLUMN IF NOT EXISTS org_id UUID;

CREATE INDEX IF NOT EXISTS scenarios_org ON scenarios (org_id);
CREATE INDEX IF NOT EXISTS sessions_org  ON sessions  (org_id);
CREATE INDEX IF NOT EXISTS outcomes_org  ON outcomes  (org_id);
