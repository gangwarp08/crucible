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

/** Update mutable fields (spend, status) — called on each spend change. */
export async function persistSessionUpdate(
  sessionId: string,
  fields: { spend_usd?: number; status?: string },
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

/** Write final session state — called once in expireSession before teardown. */
export async function finalizeSession(
  sessionId: string,
  endReason: "timeout" | "manual" | "budget",
): Promise<void> {
  if (!supabase) return;
  try {
    const entry = sessionRegistry.get(sessionId);
    if (!entry) return;

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - entry.createdAt.getTime();
    const status = endReason === "timeout" ? "timed_out" : "completed";

    const { error } = await supabase
      .from("sessions")
      .update({
        status,
        end_reason: endReason,
        ended_at: endedAt.toISOString(),
        duration_ms: durationMs,
        spend_usd: entry.spendTally,
        updated_at: endedAt.toISOString(),
      })
      .eq("id", sessionId);

    if (error) console.error("[db] finalizeSession failed", error.message);
  } catch (err) {
    console.error("[db] finalizeSession unexpected error", err);
  }
}
