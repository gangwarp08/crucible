// Supabase session persistence — best-effort, never throws into the request path.
import { supabase } from "./supabase.js";
import { sessionRegistry } from "./registry.js";
import { env } from "../env.js";

/** Insert the sessions row when a new session is created. */
export async function persistSessionCreated(sessionId: string): Promise<void> {
  if (!supabase) return;
  try {
    const entry = sessionRegistry.get(sessionId);
    if (!entry) return;

    const { error } = await supabase.from("sessions").insert({
      id: sessionId,
      assessment_id: null,
      status: "active",
      sandbox_id: entry.sandboxId,
      template: "crucible-dev",
      litellm_key_alias: `session-${sessionId}`,
      model: "gemini-flash",
      budget_usd: env.SESSION_BUDGET_USD,
      spend_usd: 0,
      timeout_min: env.SESSION_TIMEOUT_MIN,
      deadline: entry.deadline.toISOString(),
      created_at: entry.createdAt.toISOString(),
      started_at: entry.createdAt.toISOString(),
      updated_at: entry.createdAt.toISOString(),
      scenario_id: entry.scenarioId,
      scenario_state: entry.scenarioState,
    });

    if (error) console.error("[db] persistSessionCreated failed", error.message);
  } catch (err) {
    console.error("[db] persistSessionCreated unexpected error", err);
  }
}

/** Source-of-truth read for the orphan-teardown path. When the in-memory
 *  registry entry is gone (server restart / tsx-watch reload), DELETE
 *  /sessions/:id falls back to this row to find the sandbox to kill and
 *  whether the row is already terminal. Returns null on miss or any error
 *  so callers can no-op cleanly. */
export interface SessionRowMinimal {
  id:                string;
  sandbox_id:        string;
  scenario_id:       string | null;
  litellm_key_alias: string;
  status:            string;
  created_at:        string;
}
export async function loadSessionRow(
  sessionId: string,
): Promise<SessionRowMinimal | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("sessions")
      .select("id, sandbox_id, scenario_id, litellm_key_alias, status, created_at")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) {
      console.error("[db] loadSessionRow failed", error.message);
      return null;
    }
    return (data as SessionRowMinimal | null) ?? null;
  } catch (err) {
    console.error("[db] loadSessionRow unexpected error", err);
    return null;
  }
}

/** Full row read used by getOrRehydrateSession. Includes the mutable fields
 *  (spend_usd, scenario_state, deadline) needed to reconstruct a live
 *  in-memory SessionEntry after a server restart. */
export interface SessionRowFull extends SessionRowMinimal {
  spend_usd:         number | string;
  deadline:          string;
  scenario_state:    Record<string, unknown> | null;
}
/**
 * Sum today's spend (UTC day) across every session, from the cost_ledger — the
 * most real-time tally (includes in-flight costs). Powers the H2 global daily
 * circuit breaker. FAIL-CLOSED: if Supabase is unavailable or the query errors,
 * this THROWS — the caller must treat "can't measure spend" as "deny", never
 * "allow". Never swallow the error into a 0.
 */
export async function sumTodaySpendUsd(): Promise<number> {
  if (!supabase) throw new Error("sumTodaySpendUsd: Supabase client unavailable (fail-closed)");
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("cost_ledger")
    .select("cost_usd")
    .gte("ts", dayStart.toISOString());
  if (error) throw new Error(`sumTodaySpendUsd query failed (fail-closed): ${error.message}`);
  let total = 0;
  for (const row of (data ?? []) as Array<{ cost_usd: number | string | null }>) {
    total += Number(row.cost_usd) || 0;
  }
  return total;
}

export async function loadSessionRowFull(
  sessionId: string,
): Promise<SessionRowFull | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("sessions")
      .select(
        "id, sandbox_id, scenario_id, litellm_key_alias, status, created_at, " +
          "spend_usd, deadline, scenario_state",
      )
      .eq("id", sessionId)
      .maybeSingle();
    if (error) {
      console.error("[db] loadSessionRowFull failed", error.message);
      return null;
    }
    return (data as SessionRowFull | null) ?? null;
  } catch (err) {
    console.error("[db] loadSessionRowFull unexpected error", err);
    return null;
  }
}

/** MAX(seq) helpers used by rehydrate to avoid PK clashes in the events and
 *  transcript tables when the in-memory counters are lost. */
export async function loadNextEventSeq(sessionId: string): Promise<number> {
  if (!supabase) return 1;
  try {
    const { data, error } = await supabase
      .from("events")
      .select("seq")
      .eq("session_id", sessionId)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[db] loadNextEventSeq failed", error.message);
      return 1;
    }
    return ((data?.seq as number | undefined) ?? 0) + 1;
  } catch (err) {
    console.error("[db] loadNextEventSeq unexpected error", err);
    return 1;
  }
}

export async function loadNextTranscriptSeq(sessionId: string): Promise<number> {
  if (!supabase) return 1;
  try {
    const { data, error } = await supabase
      .from("transcript")
      .select("seq")
      .eq("session_id", sessionId)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[db] loadNextTranscriptSeq failed", error.message);
      return 1;
    }
    return ((data?.seq as number | undefined) ?? 0) + 1;
  } catch (err) {
    console.error("[db] loadNextTranscriptSeq unexpected error", err);
    return 1;
  }
}

/** Update mutable fields (spend, status) — called on each spend change. */
export async function persistSessionUpdate(
  sessionId: string,
  fields: {
    spend_usd?: number;
    status?: string;
    end_reason?: string;
    ended_at?: string;
    // Rotated per-session LiteLLM key alias (H1/6.8a rehydration key rotation).
    litellm_key_alias?: string;
    // Lifecycle columns (Slice 6.1+).
    deliverable_locked_at?: string | null;
    defense_outcome?: string | null;
    scorable?: boolean | null;
    exclusion_reason?: string | null;
    verification_cap_status?: string | null;
  },
): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from("sessions")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", sessionId);

    if (error) console.error("[db] persistSessionUpdate failed", error.message);
  } catch (err) {
    console.error("[db] persistSessionUpdate unexpected error", err);
  }
}

/** Persist the live scenario_state jsonb as a WHOLE-OBJECT REPLACE. Keep this
 *  for genuine full writes (e.g. future session-resume code that rebuilds
 *  state from scratch). Per-field callers MUST use persistScenarioStatePatch
 *  instead — concurrent whole-object writes from different fire-and-forget
 *  paths race against each other and silently clobber sibling fields. Best-
 *  effort; never throws. */
export async function persistScenarioState(
  sessionId: string,
  scenarioState: Record<string, unknown>,
): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from("sessions")
      .update({
        scenario_state: scenarioState,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);

    if (error) console.error("[db] persistScenarioState failed", error.message);
  } catch (err) {
    console.error("[db] persistScenarioState unexpected error", err);
  }
}

/** Partial jsonb merge of scenario_state via the merge_scenario_state RPC
 *  (migration 0005). Each caller passes ONLY its changed top-level key(s)
 *  so concurrent fire-and-forget updates to disjoint keys can never clobber
 *  each other — Postgres serializes the UPDATEs but each only writes its
 *  own keys. Within-key concurrent writes are dominated by the latest
 *  in-memory state (callers also mutate entry.scenarioState in-place so
 *  the latest snapshot is always consistent). Best-effort; never throws. */
export async function persistScenarioStatePatch(
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await supabase.rpc("merge_scenario_state", {
      p_session_id: sessionId,
      p_patch: patch,
    });
    if (error) console.error("[db] persistScenarioStatePatch failed", error.message);
  } catch (err) {
    console.error("[db] persistScenarioStatePatch unexpected error", err);
  }
}

/** Write final session state — called once in expireSession before teardown.
 *  Accepts the full EndReason union (including "orphaned") so the type flows
 *  cleanly through expireSession, even though the orphan path bypasses this
 *  function entirely (it does its own UPDATE in sandbox.ts orphanTeardown).
 *  The status mapping below collapses anything-not-"timeout" to "completed". */
export async function finalizeSession(
  sessionId: string,
  endReason: "timeout" | "manual" | "budget" | "orphaned",
): Promise<void> {
  if (!supabase) return;
  try {
    const entry = sessionRegistry.get(sessionId);
    if (!entry) return;

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - entry.createdAt.getTime();
    const status = endReason === "timeout" ? "timed_out" : "completed";

    // H6 (6.8d): fail clean + attributable. An UNCLEAN terminal (budget /
    // orphaned — anything other than manual/timeout) is charged to us and
    // excluded up-front, so it can never be silently scored 0 against the
    // candidate even if the analysis agent never runs for it. Clean terminals
    // are left for scorability to decide from the full signal (Slice 6.4).
    const dirty = endReason !== "manual" && endReason !== "timeout";
    const infraFields = dirty
      ? { scorable: false, exclusion_reason: "excluded_infra" }
      : {};

    const { error } = await supabase
      .from("sessions")
      .update({
        status,
        end_reason: endReason,
        ended_at: endedAt.toISOString(),
        duration_ms: durationMs,
        spend_usd: entry.spendTally,
        updated_at: endedAt.toISOString(),
        ...infraFields,
      })
      .eq("id", sessionId);

    if (error) console.error("[db] finalizeSession failed", error.message);
  } catch (err) {
    console.error("[db] finalizeSession unexpected error", err);
  }
}
