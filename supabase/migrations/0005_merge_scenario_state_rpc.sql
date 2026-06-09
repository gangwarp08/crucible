-- 0005_merge_scenario_state_rpc.sql
--
-- Partial jsonb merge for sessions.scenario_state.
--
-- WHY:
--   Multiple server paths write to scenario_state concurrently (per-session
--   AI assistant token deduction, db.query / PTY compute deduction, persona
--   reveal-flag flips, deliverable submission, scheduled-beat firing). The
--   pre-existing pattern was "spread current state in memory, fire-and-
--   forget UPDATE sessions SET scenario_state = <whole object>". Two
--   concurrent fire-and-forgets each captured a snapshot at their own
--   spread moment, then raced to Supabase — the snapshot that landed
--   second clobbered the other's change even though both changes were
--   for different top-level keys. The bug surfaced when a submitted
--   deliverable showed NULL in scenario_state after a normal playthrough
--   (the deliverable.submit event landed at seq 15 but the scenario_state
--   mirror was lost).
--
-- WHAT:
--   A SQL function that does an in-database top-level merge:
--     scenario_state := COALESCE(scenario_state, '{}'::jsonb) || p_patch
--   Each caller sends ONLY its changed top-level key(s). Concurrent updates
--   to disjoint keys can no longer clobber each other; the database
--   serializes both UPDATEs but each only writes its own keys.
--
-- USAGE (server-only via the service-role client):
--   await supabase.rpc("merge_scenario_state", {
--     p_session_id: sessionId,
--     p_patch:      { tokens: 12345 },
--   });
--
-- SECURITY DEFINER is set so the function runs with the owner's privileges,
-- matching the existing service-role write path. EXECUTE is locked to
-- service_role only — the browser never reaches Supabase directly per
-- CLAUDE.md Hard Rule 2.

CREATE OR REPLACE FUNCTION public.merge_scenario_state(
  p_session_id uuid,
  p_patch      jsonb
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.sessions
  SET scenario_state = COALESCE(scenario_state, '{}'::jsonb) || p_patch,
      updated_at     = now()
  WHERE id = p_session_id;
$$;

REVOKE EXECUTE ON FUNCTION public.merge_scenario_state(uuid, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.merge_scenario_state(uuid, jsonb) TO service_role;
