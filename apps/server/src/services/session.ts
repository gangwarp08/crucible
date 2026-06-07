import { sessionRegistry } from "./registry.js";
import { revokeSessionKey } from "./litellm.js";

/**
 * Tear down a session: close PTY sockets, kill the sandbox, revoke the LiteLLM key,
 * and mark the session completed. Idempotent — safe to call multiple times.
 *
 * Called by: the orchestrator timer (automatic expiry) AND the manual DELETE path.
 * Never call sandbox.kill / revokeSessionKey directly outside of this function.
 */
export async function expireSession(sessionId: string): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry || entry.status === "completed") return;

  // Mark completed first so concurrent requests are rejected immediately.
  entry.status = "completed";

  // Close all active PTY WebSocket connections (tells the browser the session is over).
  for (const socket of entry.ptySockets) {
    try {
      if (socket.readyState === 1 /* OPEN */) socket.close(1001, "Session expired");
    } catch {
      // socket may already be closing — ignore
    }
  }
  entry.ptySockets.clear();

  // Revoke the per-session LiteLLM key (best-effort).
  await revokeSessionKey(entry.litellmKey).catch(() => {});

  // Kill the E2B microVM (best-effort — may already be dead).
  try {
    await entry.sandbox.kill();
  } catch {
    // already dead or network error — ignore
  }
}
