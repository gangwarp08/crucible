-- 0015_competency_gating.sql — RD4 (Slice 6.5): competency gating.
--
-- A load-bearing competency the scenario never surfaced (zero evidence units)
-- must score `not_assessed`, NOT 1 — "no chance to demonstrate" is not
-- "demonstrated poorly". evaluation_items.score is ALREADY nullable (0003), so
-- a not-assessed item stores score = NULL; we add an explicit `assessed` flag so
-- review + reweighting can tell "scored 0/null" apart from "deliberately not
-- assessed", and so the overall reweights over assessed competencies only.
--
-- Backfill: every existing row predates gating and carries a real score, so it
-- is assessed = true. Idempotent (IF NOT EXISTS + guarded backfill).

ALTER TABLE evaluation_items
  ADD COLUMN IF NOT EXISTS assessed BOOLEAN NOT NULL DEFAULT true;

-- Existing rows: a NULL score that somehow predates this is the only "not
-- assessed" case; everything else stays assessed = true (the column default).
UPDATE evaluation_items SET assessed = false WHERE score IS NULL;
