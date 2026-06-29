-- Crucible — L1 item families (Slice 5.6, resolves C4)
--
-- Groups scenarios into FAMILIES that measure the same competency construct, so
-- we can author/compare ISOMORPHS (same radical task structure, different
-- incidental values) and band them by difficulty without inventing a parallel
-- difficulty column (C4: `scenarios.difficulty` already exists — we constrain it
-- into a band here rather than adding one).
--
--   radical_values     — the structure-defining facts shared by all isomorphs of
--                        a scenario (bug class, dedup key, required filter, the
--                        red herrings, reporting-window length). Two same-family
--                        same-band scenarios with equal radical_values are
--                        isomorphs and should score comparably.
--   incidental_values  — what VARIES between isomorphs (dataset seed, company
--                        name, the specific corrected figures). Swapping these is
--                        what stops a candidate reusing a memorised answer.
--   isomorph_of        — slug of the canonical scenario this is a matched
--                        isomorph of (same family + same band). NULL for the
--                        canonical member and for cross-band variants.
--
-- Authoring stays behind scripts/encode-*.ts so a future v2 generator targets
-- the same rows. RLS posture unchanged (scenarios already has its policy).

-- ── Family registry ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scenario_families (
  family_id          TEXT PRIMARY KEY,
  title              TEXT,
  -- The competency weight map every member binds (mirrors the rubric binding),
  -- so equivalence is measured against a shared target.
  competency_targets JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Nominal/base band for the family; individual members carry their own band
  -- in scenarios.difficulty (the family spans bands, e.g. mid + hard).
  difficulty_band    TEXT,
  -- Shared radical shape of the family's task (prose + structured spec).
  radical_spec       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE scenario_families ENABLE ROW LEVEL SECURITY;

-- ── Scenario columns ────────────────────────────────────────────────────────
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS family_id          TEXT REFERENCES scenario_families(family_id);
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS isomorph_of        TEXT;
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS radical_values     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS incidental_values  JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS scenarios_family ON scenarios (family_id);

-- Constrain difficulty into a band (C4 — no new column). Guarded so re-apply is
-- safe. NULL difficulty stays allowed (CHECK passes on NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scenarios_difficulty_band'
  ) THEN
    ALTER TABLE scenarios
      ADD CONSTRAINT scenarios_difficulty_band
      CHECK (difficulty IN ('easy', 'mid', 'hard'));
  END IF;
END $$;

-- ── Seed the fde-db-triage family + backfill existing members ───────────────
INSERT INTO scenario_families (family_id, title, competency_targets, difficulty_band, radical_spec)
VALUES (
  'fde-db-triage',
  'Revenue/data-investigation triage',
  '{
    "problem_framing": 0.15, "data_fluency": 0.20, "design_under_constraints": 0.10,
    "execution": 0.20, "ai_orchestration": 0.10, "teamwork": 0.10,
    "customer_engagement": 0.05, "outcome_communication": 0.10
  }'::jsonb,
  'mid',
  '{
    "task": "Investigate an overstated revenue/data figure, find the root cause, deliver a corrected figure + plain-English client summary.",
    "bug_class": "webhook_retry_duplicate",
    "dedup_key": "external_payment_id",
    "requires_status_filter": "succeeded",
    "red_herrings": ["refunds", "utc_month_boundary"],
    "reporting_window_months": 3,
    "deliverable_components": 4
  }'::jsonb
)
ON CONFLICT (family_id) DO NOTHING;

-- Canonical mid-band member.
UPDATE scenarios SET
  family_id   = 'fde-db-triage',
  isomorph_of = NULL,
  radical_values = '{
    "bug_class": "webhook_retry_duplicate",
    "dedup_key": "external_payment_id",
    "requires_status_filter": "succeeded",
    "red_herrings": ["refunds", "utc_month_boundary"],
    "reporting_window": ["2026-03", "2026-04", "2026-05"],
    "bug_months": ["2026-04", "2026-05"]
  }'::jsonb,
  incidental_values = '{
    "seed_label": "fde-db-triage-v1",
    "company": "Meridian",
    "reference_date": "2026-05-31T23:59:59Z"
  }'::jsonb
WHERE slug = 'fde-db-triage';

-- Hard-band member of the same family (a different, harder task — not an
-- isomorph of the mid scenario, so isomorph_of stays NULL).
UPDATE scenarios SET
  family_id = 'fde-db-triage'
WHERE slug = 'fde-db-triage-pro';
