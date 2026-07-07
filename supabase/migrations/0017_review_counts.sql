-- 0017_review_counts.sql
--
-- Grouped per-session aggregates for the recruiter review session list.
--
-- WHY:
--   GET /api/review/sessions previously fired four raw scans that shipped up
--   to COUNT_QUERY_MAX_ROWS (100k) rows PER TABLE over the network — events /
--   transcript / file_snapshots selected only session_id so the server could
--   tally counts in JS, and evaluations returned every historical row sorted
--   DESC so the first row per session won. The route only ever needs one
--   number (or one row) per session, so the aggregation belongs in Postgres.
--
-- WHAT:
--   Two set-returning functions, one RPC per concern:
--     review_session_counts(ids)      → (session_id, event_count,
--                                        message_count, file_count) per id.
--                                        Counts cast to int so PostgREST
--                                        serializes plain JSON numbers.
--                                        message_count uses role <> 'system'
--                                        to match the old .neq("role",
--                                        "system") semantics (role is NOT
--                                        NULL, so NULL handling is moot).
--     review_latest_evaluations(ids)  → the most recent evaluations row per
--                                        session (DISTINCT ON ... ORDER BY
--                                        created_at DESC), same columns the
--                                        route selected before.
--
-- USAGE (server-only via the service-role client):
--   await supabase.rpc("review_session_counts",     { ids });
--   await supabase.rpc("review_latest_evaluations", { ids });
--
-- SECURITY DEFINER is set so the functions run with the owner's privileges,
-- matching the existing service-role read path. EXECUTE is locked to
-- service_role only — the browser never reaches Supabase directly per
-- CLAUDE.md Hard Rule 2.

CREATE OR REPLACE FUNCTION public.review_session_counts(ids uuid[])
RETURNS TABLE(session_id uuid, event_count int, message_count int, file_count int)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id,
         COALESCE(e.n, 0)::int,
         COALESCE(t.n, 0)::int,
         COALESCE(f.n, 0)::int
  FROM unnest(ids) AS s(id)
  LEFT JOIN (
    SELECT ev.session_id AS sid, count(*) AS n
    FROM public.events ev
    WHERE ev.session_id = ANY(ids)
    GROUP BY ev.session_id
  ) e ON e.sid = s.id
  LEFT JOIN (
    SELECT tr.session_id AS sid, count(*) AS n
    FROM public.transcript tr
    WHERE tr.session_id = ANY(ids) AND tr.role <> 'system'
    GROUP BY tr.session_id
  ) t ON t.sid = s.id
  LEFT JOIN (
    SELECT fs.session_id AS sid, count(*) AS n
    FROM public.file_snapshots fs
    WHERE fs.session_id = ANY(ids)
    GROUP BY fs.session_id
  ) f ON f.sid = s.id;
$$;

CREATE OR REPLACE FUNCTION public.review_latest_evaluations(ids uuid[])
RETURNS TABLE(session_id uuid, overall_score numeric, status text, created_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (ev.session_id)
         ev.session_id, ev.overall_score, ev.status, ev.created_at
  FROM public.evaluations ev
  WHERE ev.session_id = ANY(ids)
  -- id DESC breaks created_at ties deterministically (bulk re-scores can
  -- share a timestamp; the old JS pick was nondeterministic there).
  ORDER BY ev.session_id, ev.created_at DESC, ev.id DESC;
$$;

-- Supabase's default privileges grant EXECUTE on new public functions to
-- anon and authenticated EXPLICITLY, and REVOKE ... FROM PUBLIC does not
-- remove explicit role grants. Both functions are SECURITY DEFINER (bypass
-- RLS) and return evaluation scores, so anon/authenticated must be revoked
-- by name — otherwise the browser-shipped anon key could call the RPCs.
REVOKE EXECUTE ON FUNCTION public.review_session_counts(uuid[])     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.review_session_counts(uuid[])     TO service_role;
REVOKE EXECUTE ON FUNCTION public.review_latest_evaluations(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.review_latest_evaluations(uuid[]) TO service_role;
