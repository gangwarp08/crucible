import { Sandbox } from "e2b";
import { env } from "../env.js";
import { sessionRegistry } from "./registry.js";

/** Provision a new E2B microVM, register it under sessionId, return its sandboxId. */
export async function createSandbox(sessionId: string): Promise<string> {
  const sandbox = await Sandbox.create("crucible-dev", {
    timeoutMs: env.SESSION_TIMEOUT_MIN * 60_000,
    metadata: { sessionId },
  });
  // TODO: persist session to Supabase
  sessionRegistry.set(sessionId, {
    sandbox,
    sandboxId: sandbox.sandboxId,
    createdAt: new Date(),
  });
  return sandbox.sandboxId;
}

/** Terminate an E2B microVM and remove it from the registry. Safe to call if already gone. */
export async function destroySandbox(sessionId: string): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry) return;
  sessionRegistry.delete(sessionId);
  try {
    await entry.sandbox.kill();
  } catch {
    // already dead — ignore
  }
}
