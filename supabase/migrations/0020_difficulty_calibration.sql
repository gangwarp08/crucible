-- Crucible — P5.2 difficulty calibration seam (v-next)
--
-- Two things, both additive + measurement-neutral (no scoring, content, or
-- detector change — pure read/aggregate infrastructure):
--
-- 1. sessions.difficulty_band — the band a session was ROUTED to at creation.
--    Nullable: P5.1 (deliberate per-candidate band routing) lands separately
--    and stamps it at session create; the column ships NOW so the P5.2 stats
--    accumulator can key on it from the pilot cohort's first sessions. Values
--    mirror the scenarios.difficulty CHECK from 0011 (easy | mid | hard).
--    Spec safety rule: running sessions are never re-routed, so the band is
--    write-once at creation — no update path exists.
--
-- 2. competency_difficulty_stats — per-(scenario, band, competency)
--    calibration aggregates over SCORABLE sessions only (ties to RD3 /
--    services/scorability.ts — excluded sessions never enter the validity
--    dataset): n, mean score, pass rate (score >= 3, same bar as
--    scenario_stats), and spread (population stddev). Recomputed in full by
--    services/difficulty-stats.ts after each evaluation persists
--    (fire-and-forget from the analysis agent, exactly like scenario_stats
--    in 0012). stats_version stamps how each row was computed
--    (DIFFICULTY_STATS_VERSION) so rows can be recomputed and compared when
--    the formula changes. This is the data real IRT/CAT consumes in v2.

-- ── 1. Session difficulty band (stamped at creation by P5.1) ────────────────
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS difficulty_band TEXT
  CHECK (difficulty_band IN ('easy', 'mid', 'hard'));

-- ── 2. competency_difficulty_stats ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competency_difficulty_stats (
  scenario_id     UUID REFERENCES scenarios(id) ON DELETE CASCADE,
  difficulty_band TEXT NOT NULL,
  competency_key  TEXT NOT NULL,
  n               INTEGER NOT NULL DEFAULT 0,
  mean_score      NUMERIC,
  pass_rate       NUMERIC,           -- fraction of item scores >= 3 (meets bar)
  spread          NUMERIC,           -- population stddev of item scores, 4dp
  stats_version   TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, difficulty_band, competency_key)
);

-- Enabled-with-no-policies, matching every table in this schema: the server
-- reads/writes with the service role (bypasses RLS); the browser never
-- reaches Supabase directly (CLAUDE.md Hard Rule 2).
ALTER TABLE competency_difficulty_stats ENABLE ROW LEVEL SECURITY;
