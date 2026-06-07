import { Sandbox } from "e2b";
import { env } from "../env.js";
import { sessionRegistry } from "./registry.js";
import { mintSessionKey } from "./litellm.js";
import { expireSession } from "./session.js";
import { persistSessionCreated } from "./db.js";
import { logEvent } from "./telemetry.js";

/** Provision a new E2B microVM, mint a per-session LiteLLM key, and register both.
 *  Starts the orchestrator kill-switch timer that calls expireSession at deadline.
 *  Persists the session row to Supabase and emits a session.created event. */
export async function createSandbox(sessionId: string): Promise<string> {
  const timeoutMs = env.SESSION_TIMEOUT_MIN * 60_000;
  const deadline = new Date(Date.now() + timeoutMs);

  const sandbox = await Sandbox.create("crucible-dev", {
    timeoutMs,
    metadata: { sessionId },
  });

  let litellmKey: string;
  try {
    litellmKey = await mintSessionKey(sessionId);
  } catch (err) {
    await sandbox.kill().catch(() => {});
    throw err;
  }

  const expiryTimer = setTimeout(() => {
    void expireSession(sessionId, "timeout");
  }, timeoutMs);

  sessionRegistry.set(sessionId, {
    sandbox,
    sandboxId: sandbox.sandboxId,
    createdAt: new Date(),
    deadline,
    litellmKey,
    spendTally: 0,
    status: "active",
    expiryTimer,
    ptySockets: new Set(),
    nextSeq: 0,
    eventBuffer: [],
    flushTimer: null,
  });

  // Persist to Supabase and emit telemetry (both fire-and-forget).
  void persistSessionCreated(sessionId);
  logEvent(sessionId, "session.created", "system", {
    sandboxId: sandbox.sandboxId,
    template: "crucible-dev",
    model: "gemini-flash",
    budgetUsd: env.SESSION_BUDGET_USD,
    timeoutMin: env.SESSION_TIMEOUT_MIN,
    deadline: deadline.toISOString(),
  });

  return sandbox.sandboxId;
}

/** Cancel the orchestrator timer and run expireSession (the shared teardown path).
 *  Called by the manual DELETE /sessions/:id endpoint. */
export async function destroySandbox(
  sessionId: string,
  endReason: "manual" | "budget" = "manual",
): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.expiryTimer);
  await expireSession(sessionId, endReason);
}
