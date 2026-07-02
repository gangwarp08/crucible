// Deadline reaper — force-completes overdue sessions the in-memory timers
// missed.
//
// Each session arms an in-memory setTimeout at its deadline (sandbox.ts /
// session-rehydrate.ts). That timer is LOST on a server restart (deploy,
// crash). A session that is `submitted`/`defending` when the server restarts is
// not rehydrated (rehydrate only resumes `active`), so its timer is never
// re-armed and it can sit past its deadline forever — exactly the "stuck on
// defending" case seen in the first prod dry run (two restarts mid-session).
//
// This periodic DB sweep is the safety net: any session past its deadline that
// isn't ended gets force-completed (end_reason=timeout, a CLEAN terminal) with
// its per-session LiteLLM key revoked and the Analysis Agent fired — regardless
// of whether any process holds it in memory. Sessions still live in memory are
// left to their own timer (skipped) so we never double-finalize.

import { supabase } from "./supabase.js";
import { sessionRegistry } from "./registry.js";
import { persistSessionUpdate } from "./db.js";
import { revokeSessionKeyByAlias } from "./litellm.js";
import { runAnalysisAgent } from "./analysis-agent.js";

const TICK_MS = Number(process.env["DEADLINE_REAPER_TICK_MS"]) || 60_000;
const NON_TERMINAL = ["active", "submitted", "defending"] as const;

interface OverdueRow {
  id: string;
  status: string;
  deadline: string;
  created_at: string;
  scenario_id: string | null;
  litellm_key_alias: string | null;
}

/** One sweep: force-complete every overdue, not-yet-ended session that no live
 *  process is servicing. Best-effort + non-throwing. */
export async function sweepOverdueSessions(): Promise<number> {
  if (!supabase) return 0;
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("sessions")
    .select("id, status, deadline, created_at, scenario_id, litellm_key_alias")
    .in("status", NON_TERMINAL as unknown as string[])
    .lt("deadline", nowIso)
    .is("ended_at", null);
  if (error) {
    console.error("[deadline-reaper] sweep query failed:", error.message);
    return 0;
  }

  let reaped = 0;
  for (const row of (data ?? []) as OverdueRow[]) {
    // A session still in memory has a live timer (or is actively finalizing) —
    // let it handle its own expiry to avoid a double-finalize race.
    const live = sessionRegistry.get(row.id);
    if (live && live.status !== "completed") continue;

    try {
      const durationMs = Date.now() - new Date(row.created_at).getTime();
      // timeout is a CLEAN terminal — scorability (RD3) then decides from the
      // full signal rather than us pre-excluding it as infra.
      await persistSessionUpdate(row.id, {
        status: "completed",
        end_reason: "timeout",
        ended_at: nowIso,
      });
      await revokeSessionKeyByAlias(row.litellm_key_alias ?? "");
      console.log(`[deadline-reaper] force-completed ${row.id} (was ${row.status}, +${Math.round(durationMs / 60000)}min)`);
      reaped++;
      // Fire-and-forget analysis for scenario-bound sessions (reads from DB).
      if (row.scenario_id) {
        void runAnalysisAgent(row.id).catch((err) =>
          console.error(`[deadline-reaper] analysis for ${row.id} failed:`, err instanceof Error ? err.message : String(err)),
        );
      }
    } catch (err) {
      console.error(`[deadline-reaper] finalize ${row.id} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return reaped;
}

let handle: ReturnType<typeof setInterval> | null = null;

/** Start the periodic reaper. Eager initial sweep catches sessions orphaned by
 *  the restart that just happened. Idempotent. */
export function startDeadlineReaper(): void {
  if (handle) return;
  handle = setInterval(() => { void sweepOverdueSessions(); }, TICK_MS);
  if (typeof handle.unref === "function") handle.unref();
  void sweepOverdueSessions();
  console.log(`[deadline-reaper] started (tick=${TICK_MS}ms)`);
}
