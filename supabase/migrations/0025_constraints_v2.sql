-- 0025: tighten live simulation constraints (operator request, 2026-07-09):
--   tokens 200000 → 50000, compute_minutes 60 → 30, memory_mb 2048 → 1024.
-- time_minutes and money_usd are unchanged.
--
-- Applies to the LIVE family-1 scenarios only (fde-db-triage, -pro, -iso).
-- Family 2 gets the same values via its (still-unapplied) content migration
-- 0023, edited in the same change set.
--
-- MEASUREMENT HYGIENE: constraints are candidate-visible scenario content
-- (ConstraintHUD) and feed the compute-minutes soft mechanic, so this is a
-- scenario-content change — scenarios.version is bumped so every subsequent
-- evaluation is stamped with the new scenario_version and the validity
-- dashboard's version panel segregates pre/post-change cohorts instead of
-- silently pooling them.
--
-- Idempotent: the WHERE clause skips rows already at the new token value.

UPDATE scenarios
SET constraints = constraints
      || '{"tokens": 50000, "compute_minutes": 30, "memory_mb": 1024}'::jsonb,
    version = version + 1
WHERE slug IN ('fde-db-triage', 'fde-db-triage-pro', 'fde-db-triage-iso')
  AND (constraints ->> 'tokens')::int IS DISTINCT FROM 50000;
