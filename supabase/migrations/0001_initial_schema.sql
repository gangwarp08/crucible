-- Crucible — initial schema (Week 3.1)
--
-- 7 tables covering assessment definitions, candidates, live sessions, and the
-- four-stream telemetry sink (events / transcript / cost_ledger / file_snapshots).
-- Applied originally via the Supabase management API; codified here so the
-- migration tree reproduces the live remote schema on a fresh database.
--
-- RLS is enabled on every table (Supabase default for the public schema). No
-- policies are defined: the server reaches Supabase with the service-role key,
-- which bypasses RLS; the browser never connects directly (CLAUDE.md Hard Rule 2).

CREATE TABLE assessments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE candidates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT,
  email      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id                UUID PRIMARY KEY,
  assessment_id     UUID REFERENCES assessments(id),
  status            TEXT NOT NULL DEFAULT 'active',
  sandbox_id        TEXT NOT NULL,
  template          TEXT NOT NULL,
  litellm_key_alias TEXT NOT NULL,
  model             TEXT NOT NULL,
  budget_usd        NUMERIC(10, 6) NOT NULL,
  spend_usd         NUMERIC(10, 6) NOT NULL DEFAULT 0,
  timeout_min       INTEGER NOT NULL,
  deadline          TIMESTAMPTZ NOT NULL,
  end_reason        TEXT,
  ended_at          TIMESTAMPTZ,
  duration_ms       BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_session_seq ON events (session_id, seq);

CREATE TABLE transcript (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transcript_session_seq ON transcript (session_id, seq);

CREATE TABLE cost_ledger (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cost_usd          NUMERIC(12, 8) NOT NULL,
  description       TEXT
);

CREATE TABLE file_snapshots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  path       TEXT NOT NULL,
  content    TEXT NOT NULL
);

ALTER TABLE assessments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_ledger    ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_snapshots ENABLE ROW LEVEL SECURITY;
