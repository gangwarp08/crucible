// Compute-minutes soft mechanic. db.query and PTY command events deduct from
// scenarioState.compute_minutes; depletion DOES NOT block anything — the
// candidate's management of compute is the design_under_constraints rubric
// signal, not a hard gate. (Matches the spec's intent and the way tokens
// are allowed to go negative on the threshold-crossing call too.)
//
// Sessions without a scenario have no compute mechanic — the helper is a
// no-op there. Same per-session race caveat as elsewhere: two concurrent
// deductions race on entry.scenarioState; not fixed in this slice.

import { sessionRegistry } from "./registry.js";
import { logEvent } from "./telemetry.js";
import { persistScenarioState } from "./db.js";

export type ComputeReason = "db_query" | "sandbox_command";

/** Subtract `amount` compute-minutes from the session's scenario state and
 *  emit a constraint.spend telemetry event. No-op if the session has no
 *  scenario or no compute_minutes budget configured. Returns the post-
 *  deduction balance for callers that want to echo it back in their HTTP
 *  response; null when nothing was deducted. */
export function deductComputeMinutes(
  sessionId: string,
  amount: number,
  reason: ComputeReason,
): number | null {
  const entry = sessionRegistry.get(sessionId);
  if (!entry || entry.scenarioId === null) return null;
  const current = entry.scenarioState["compute_minutes"];
  if (typeof current !== "number") return null;

  const next = current - amount;
  entry.scenarioState = { ...entry.scenarioState, compute_minutes: next };

  logEvent(sessionId, "constraint.spend", "system", {
    resource: "compute_minutes",
    amount,
    balance_after: next,
    reason,
  });

  void persistScenarioState(sessionId, entry.scenarioState);

  return next;
}
