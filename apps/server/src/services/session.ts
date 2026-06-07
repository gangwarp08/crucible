import type { CreateSessionRequest } from "@crucible/shared";
import type { Session } from "@crucible/shared";
import { env } from "../env.js";

// TODO: wire up Supabase client (slice: persistence)
// TODO: wire up Redis client (slice: rate-limit / session cache)
// TODO: wire up E2B sandbox lifecycle (slice: sandbox)
// TODO: mint per-session LiteLLM key via LITELLM_MASTER_KEY (slice: llm-gateway)

export async function createSession(req: CreateSessionRequest): Promise<Omit<Session, "sandboxId">> {
  // TODO: validate assessmentId and candidateId exist in Supabase
  // TODO: provision E2B sandbox, store sandboxId server-side only
  // TODO: mint short-lived LiteLLM key scoped to this session
  // TODO: persist session row to Supabase
  // TODO: start budget + timeout watchdog

  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.SESSION_TIMEOUT_MIN * 60 * 1000);

  const stub: Omit<Session, "sandboxId"> = {
    id: crypto.randomUUID(),
    assessmentId: req.assessmentId,
    candidateId: req.candidateId,
    status: "pending",
    budgetUsd: env.SESSION_BUDGET_USD,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  return stub;
}

export async function getSession(id: string): Promise<Omit<Session, "sandboxId"> | null> {
  // TODO: fetch from Supabase by id; return null if not found
  void id;
  return null;
}

export async function endSession(id: string): Promise<void> {
  // TODO: terminate E2B sandbox
  // TODO: revoke per-session LiteLLM key
  // TODO: update session status to "completed" in Supabase
  void id;
}
