-- Crucible — L6 outcome capture (Slice 5.5)
--
-- Stores real-world hiring/performance outcomes a design partner reports back
-- for a candidate, so we can later correlate assessment scores (the evaluations
-- + evidence_units we already store) against what actually happened on the job.
-- This is the validity feedback loop: does a high execution score predict a fast
-- ramp, a good 90-day rating, retention?
--
-- The correlation link is `session_id` (→ sessions → evaluations/evidence_units).
-- `candidate_ref` is the PARTNER's own identifier (free text) carried for their
-- bookkeeping + so an outcome can be re-linked to a session later if it arrives
-- before the link is known. ON DELETE SET NULL keeps the partner-reported fact
-- even if a session row is later cleaned up.
--
-- outcome_value is JSONB so one column fits bool/numeric/scale outcomes:
--   hired              → { "value": true }
--   ramp_weeks         → { "value": 6 }
--   manager_rating_90d → { "value": 4 }    (1-5)
--   retained_90d       → { "value": true }
-- outcome_type is validated with Zod at the API boundary (it will grow); only
-- `source` carries a DB-level CHECK since that set is fixed.
--
-- RLS enabled, no policies — service-role only (CLAUDE.md Hard Rule §2). Light
-- org/tenant scoping (org_id + tenant RLS) lands in Slice 5.7, not here.

CREATE TABLE outcomes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_ref TEXT NOT NULL,
  session_id    UUID REFERENCES sessions(id)  ON DELETE SET NULL,
  scenario_id   UUID REFERENCES scenarios(id) ON DELETE SET NULL,
  outcome_type  TEXT NOT NULL,
  outcome_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  source        TEXT NOT NULL CHECK (source IN ('csv', 'webhook', 'manual')),
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX outcomes_session       ON outcomes (session_id);
CREATE INDEX outcomes_scenario      ON outcomes (scenario_id);
CREATE INDEX outcomes_candidate_ref ON outcomes (candidate_ref);
CREATE INDEX outcomes_type          ON outcomes (outcome_type);

ALTER TABLE outcomes ENABLE ROW LEVEL SECURITY;
