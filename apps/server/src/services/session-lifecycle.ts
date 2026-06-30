// Session lifecycle state machine (Slice 6.1, partner readiness).
//
// Phases: active → submitted (deliverable frozen, workspace read-only) →
// defending (verifier Q&A) → completed. Non-clean terminals (error/aborted/
// orphaned) are represented via end_reason on a 'completed' row, not as distinct
// statuses. This module is the single authority on which transitions are legal;
// callers (submit in 6.2, verification in 6.3, teardown) route through
// transitionSession so an illegal move can't slip in.
//
// `scorable` / `exclusion_reason` are DERIVED labels computed elsewhere
// (services/scorability.ts, 6.4) — NOT part of this machine.

import { sessionRegistry } from "./registry.js";
import { persistSessionUpdate } from "./db.js";
import { supabase } from "./supabase.js";

export type SessionStatus = "active" | "submitted" | "defending" | "completed";
export type DefenseOutcome = "coherent" | "weak" | "declined" | "not_reached";
export type VerificationCapStatus =
  | "none" | "applied" | "advisory_pending" | "confirmed" | "overridden";

// Allowed forward transitions. active can end directly (manual/budget/error/
// orphan) or be auto-locked at the deadline; submitted can defend or end;
// defending ends. 'completed' is terminal.
const LEGAL: Record<SessionStatus, readonly SessionStatus[]> = {
  active:    ["submitted", "defending", "completed"],
  submitted: ["defending", "completed"],
  defending: ["completed"],
  completed: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: SessionStatus, to: SessionStatus) {
    super(`illegal session transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return LEGAL[from]?.includes(to) ?? false;
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** Current status: prefer the live in-memory entry, else the DB row. */
export async function currentStatus(sessionId: string): Promise<SessionStatus | null> {
  const entry = sessionRegistry.get(sessionId);
  if (entry) return entry.status;
  if (!supabase) return null;
  const { data } = await supabase
    .from("sessions").select("status").eq("id", sessionId).maybeSingle();
  const s = (data as { status?: string } | null)?.status;
  return (s as SessionStatus | undefined) ?? null;
}

export interface TransitionOpts {
  /** Stamp deliverable_locked_at (used on the active→submitted lock, 6.2). */
  deliverableLockedAt?: string;
}

/**
 * Validate + apply a status transition: throws IllegalTransitionError on an
 * illegal move, updates the in-memory entry (if live), and persists. Idempotent
 * when from === to. Terminal teardown (→completed with end_reason/ended_at)
 * still flows through expireSession; this is primarily for the new intermediate
 * states (submitted, defending).
 */
export async function transitionSession(
  sessionId: string,
  to: SessionStatus,
  opts: TransitionOpts = {},
): Promise<void> {
  const from = await currentStatus(sessionId);
  if (from === null) throw new Error(`session ${sessionId} not found`);
  if (from === to) return; // idempotent
  assertTransition(from, to);

  const entry = sessionRegistry.get(sessionId);
  if (entry) entry.status = to;

  const fields: Parameters<typeof persistSessionUpdate>[1] = { status: to };
  if (to === "submitted" && opts.deliverableLockedAt) {
    fields.deliverable_locked_at = opts.deliverableLockedAt;
  }
  await persistSessionUpdate(sessionId, fields);
}
