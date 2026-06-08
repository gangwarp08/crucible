-- Crucible — FDE-simulation data model foundation (Week 4.3)
--
-- Catalog of FDE simulation scenarios plus the evaluation tables that capture
-- the rubric verdict for each completed session.
--
-- A "scenario" is the simulation definition: brief, client/team personas,
-- supporting docs, the game-mechanic budgets the candidate must work within
-- (compute / memory / tokens / time / money), the rubric used to grade the
-- session, the deliverable spec, optional curveballs that fire mid-session,
-- and the success criteria.
--
-- IMPORTANT — two distinct budget concepts in this codebase:
--   1. scenarios.constraints  → SCENARIO game-mechanic budget. Part of the
--      simulation the candidate is reasoning about. Drained as the candidate
--      "uses" compute / memory / tokens / time / money in-game.
--   2. SESSION_BUDGET_USD     → PLATFORM LLM budget. The kill switch on real
--      AI spend, enforced by the server per CLAUDE.md Hard Rule §5.
-- These are independent. The first is fiction inside the simulation; the
-- second is real money leaving the LiteLLM gateway.
--
-- RLS is enabled on every new table (no policies). The server reaches Supabase
-- with the service-role key, which bypasses RLS; the browser never connects
-- directly (CLAUDE.md Hard Rule §2).

CREATE TABLE scenarios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'fde',
  difficulty       TEXT,
  brief            TEXT,
  client_persona   JSONB NOT NULL DEFAULT '{}'::jsonb,
  team_persona     JSONB NOT NULL DEFAULT '{}'::jsonb,
  dataset_ref      TEXT,
  docs             JSONB NOT NULL DEFAULT '[]'::jsonb,
  constraints      JSONB NOT NULL DEFAULT '{}'::jsonb,
  rubric           JSONB NOT NULL DEFAULT '{}'::jsonb,
  deliverable_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  curveballs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE evaluations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID REFERENCES sessions(id),
  scenario_id   UUID REFERENCES scenarios(id),
  overall_score NUMERIC,
  summary       TEXT,
  model         TEXT,
  status        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE evaluation_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id UUID NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  competency    TEXT NOT NULL,
  score         NUMERIC,
  weight        NUMERIC,
  rationale     TEXT,
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evaluation_items_evaluation_id ON evaluation_items (evaluation_id);
CREATE INDEX evaluation_items_competency    ON evaluation_items (competency);

ALTER TABLE sessions
  ADD COLUMN scenario_id    UUID REFERENCES scenarios(id),
  ADD COLUMN scenario_state JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE scenarios        ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_items ENABLE ROW LEVEL SECURITY;

-- ── Seed: minimal placeholder scenario ──────────────────────────────────────
-- Real content (full brief, personas, docs, curveballs) lands in the next
-- slice. This row exists so the rest of the stack (loader, POST /sessions,
-- recruiter UI) has something concrete to point at.
INSERT INTO scenarios (
  slug, title, role, difficulty, brief, constraints, rubric
) VALUES (
  'fde-db-triage',
  'Customer database triage',
  'fde',
  'mid',
  'A customer is reporting intermittent slow queries on their primary database. The candidate must triage the symptoms with the customer, identify a likely root cause, propose a fix that fits within the engagement constraints, and communicate the trade-offs back to a non-technical stakeholder. [PLACEHOLDER — real brief lands in the next slice.]',
  jsonb_build_object(
    'compute_minutes', 60,
    'memory_mb',       2048,
    'tokens',          200000,
    'time_minutes',    90,
    'money_usd',       25
  ),
  jsonb_build_object(
    'problem_framing',          jsonb_build_object('weight', 1),
    'customer_engagement',      jsonb_build_object('weight', 1),
    'data_fluency',             jsonb_build_object('weight', 1),
    'design_under_constraints', jsonb_build_object('weight', 1),
    'execution',                jsonb_build_object('weight', 1),
    'ai_orchestration',         jsonb_build_object('weight', 1),
    'teamwork',                 jsonb_build_object('weight', 1),
    'outcome_communication',    jsonb_build_object('weight', 1)
  )
)
ON CONFLICT (slug) DO NOTHING;
