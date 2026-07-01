-- Crucible — session lifecycle state machine (Slice 6.1, partner readiness)
--
-- Adds the derived-label + defense columns the lifecycle/scorability code needs.
-- The status progression gains 'submitted' and 'defending' — but status is a
-- free-text column (no enum/CHECK today), so the new statuses need NO migration,
-- only the new COLUMNS do. We deliberately do NOT add a CHECK on status: it would
-- reject legacy 'timed_out' rows and couple the schema to the enum.
--
-- All new columns nullable. RLS already enabled on sessions (0001).
--
-- Critical principle (spec §2): `scorable` is a DERIVED label, not a status.
-- 'completed' ≠ "in the validity dataset". scorable/exclusion_reason are computed
-- by services/scorability.ts (recomputable) and may be human-overridden.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deliverable_locked_at   TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS defense_outcome         TEXT;  -- coherent | weak | declined | not_reached
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scorable                BOOLEAN;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS exclusion_reason        TEXT;  -- excluded_infra | excluded_abandoned | ...
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS verification_cap_status TEXT;  -- none | applied | advisory_pending | confirmed | overridden

-- Q1 (resolved: backfill): migrate legacy terminal 'timed_out' rows into the
-- canonical representation so scorability can key off end_reason alone. New
-- lifecycle code writes status='completed' + end_reason='timeout' on the
-- deadline path; this aligns history with that.
UPDATE sessions
   SET status = 'completed', end_reason = 'timeout'
 WHERE status = 'timed_out';
