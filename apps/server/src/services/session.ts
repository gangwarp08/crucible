import { sessionRegistry } from "./registry.js";
import { revokeSessionKey } from "./litellm.js";
import { finalizeSession } from "./db.js";
import { logEvent, flushTelemetry } from "./telemetry.js";

export type EndReason = "timeout" | "manual" | "budget";

/**
 * Tear down a session: finalize Supabase row, emit session.ended, flush telemetry,
 * close PTY sockets, revoke the LiteLLM key, and kill the sandbox.
 * Idempotent — safe to call multiple times (no-op after first completion).
 *
 * Called by: the orchestrator timer (endReason='timeout'),
 *            DELETE /sessions/:id via destroySandbox (endReason='manual'),
 *            budget-exceeded path (endReason='budget').
 */
export async function expireSession(
  sessionId: string,
  endReason: EndReason = "timeout",
): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry || entry.status === "completed") return;

  // Mark completed first so concurrent requests are rejected immediately.
  entry.status = "completed";

  // Emit the session.ended event and flush the full buffer to Supabase BEFORE
  // we start destroying infra — ensures telemetry arrives even if kill() throws.
  logEvent(sessionId, "session.ended", "system", {
    endReason,
    spendUsd: entry.spendTally,
    durationMs: Date.now() - entry.createdAt.getTime(),
  });
  await flushTelemetry(sessionId);      // drains buffer synchronously
  await finalizeSession(sessionId, endReason); // writes final row state

  // Close all active PTY WebSocket connections (tells the browser the session is over).
  for (const socket of entry.ptySockets) {
    try {
      if (socket.readyState === 1 /* OPEN */) socket.close(1001, "Session expired");
    } catch {
      // socket may already be closing — ignore
    }
  }
  entry.ptySockets.clear();

  // Close all active messaging WebSocket connections (client/team persona threads).
  for (const socket of entry.messagingSockets) {
    try {
      if (socket.readyState === 1 /* OPEN */) socket.close(1001, "Session expired");
    } catch {
      // socket may already be closing — ignore
    }
  }
  entry.messagingSockets.clear();

  // Revoke the per-session LiteLLM key (best-effort).
  await revokeSessionKey(entry.litellmKey).catch(() => {});

  // Kill the E2B microVM (best-effort — may already be dead).
  try {
    await entry.sandbox.kill();
  } catch {
    // already dead or network error — ignore
  }
}
