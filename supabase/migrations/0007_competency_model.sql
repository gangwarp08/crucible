-- Crucible — L0 canonical competency model (Slice 5.1)
--
-- Splits the CONSTRUCT (what we measure — identical across every scenario) from
-- the BINDING (how one scenario surfaces evidence for it). Before this, all of
-- {weight, description, signals, anchors} lived inside scenarios.rubric per
-- scenario, which made cross-scenario comparison impossible once a second
-- scenario existed.
--
--   competency_model_versions  → a frozen set of competency rows = one version.
--   competencies               → the canonical, versioned construct (~8-12).
--   scenarios.rubric           → (rebound in 0008) an array of bindings that
--                                reference canonical keys + carry weights and
--                                optional per-scenario overrides.
--   evaluations.competency_model_version → every verdict records the model it
--                                ran under, so scores stay comparable as the
--                                construct evolves.
--
-- This migration is DDL + the version row only. The 8 canonical competency
-- rows and the scenario rubric rebind land in 0008 (content), mirroring the
-- 0003 (schema) / 0004 (content) split.
--
-- RLS is enabled with no policies on every new table — the server reaches
-- Supabase with the service-role key (which bypasses RLS) and the browser never
-- connects directly (CLAUDE.md Hard Rule §2).

CREATE TABLE competency_model_versions (
  version    INTEGER PRIMARY KEY,
  frozen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note       TEXT
);

CREATE TABLE competencies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                  TEXT NOT NULL,
  name                 TEXT NOT NULL,
  construct_family     TEXT NOT NULL,
  definition           TEXT NOT NULL,
  default_signals      JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_anchors      JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_scoring_note TEXT,
  dimensions           JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_version        INTEGER NOT NULL REFERENCES competency_model_versions(version),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key, model_version)
);
CREATE INDEX competencies_model_version ON competencies (model_version);

-- Every evaluation records the competency model version it was scored under.
-- Nullable: historical evaluations predate the model and keep NULL.
ALTER TABLE evaluations
  ADD COLUMN competency_model_version INTEGER REFERENCES competency_model_versions(version);

ALTER TABLE competency_model_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE competencies              ENABLE ROW LEVEL SECURITY;

-- Version 1 of the canonical model. Rows seeded in 0008.
INSERT INTO competency_model_versions (version, note)
VALUES (1, 'Initial canonical competency model, extracted from fde-db-triage (Slice 5.1).')
ON CONFLICT (version) DO NOTHING;
