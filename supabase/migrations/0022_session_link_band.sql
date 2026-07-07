-- Crucible — P5.1 difficulty routing at creation (v-next)
--
-- session_links.difficulty_band: the band the RECRUITER requested when minting
-- the link (manual per-invite banding — no seniority auto-mapping in the
-- pilot). Consumed exactly once, at session creation: routes/sessions.ts
-- resolves the canonical scenario to its same-family sibling in this band
-- (services/difficulty-routing.ts) BEFORE the sandbox is created, then stamps
-- sessions.difficulty_band (migration 0020) with the EFFECTIVE band — the
-- routed scenario's own difficulty.
--
-- NULLABLE = no routing: a band-less link starts the scenario exactly as
-- today. Values mirror the scenarios.difficulty CHECK from 0011 and the
-- sessions.difficulty_band CHECK from 0020 (easy | mid | hard).
--
-- Spec safety rule (P5): routing happens ONLY at creation. Nothing re-routes a
-- running session — no code path updates sessions.difficulty_band after the
-- insert (asserted by scripts/verify-difficulty-routing.ts).

ALTER TABLE session_links ADD COLUMN IF NOT EXISTS difficulty_band TEXT
  CHECK (difficulty_band IN ('easy', 'mid', 'hard'));
