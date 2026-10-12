// Verification pipeline (slice V10) — day-one re-verification.
//
// THE BAIT-AND-SWITCH DEFENSE: the evidence chain extends past the hire.
// A reverify link (session_links.kind='reverify', migration 0030) starts a
// short micro-session tied to the ORIGINAL assessment session; the new hire
// re-does the identity step and the fresh enrolment embedding is compared
// against the ORIGINAL session's anchor. Derived result only —
// identity_checks.{reverify_of, anchor_similarity} (dormant 0027 columns).
//
// DORMANCY LADDER (every step fails soft):
//   - pre-0030: reverify links can't be minted (explicit error to the org);
//   - org flag settings.posthire_reverify_enabled absent/false: mint refused;
//   - pre-0027 / no anchor on the original session: the micro-session still
//     runs, the comparison is simply skipped (null) — never a candidate error.

import { env } from "../env.js";
import { supabase } from "./supabase.js";
import { appendEvent } from "./events-direct.js";
import { readAnchor, cosineSimilarity } from "./face-continuity.js";

export class ReverifyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ReverifyError";
  }
}

export interface ReverifyInfo {
  kind: "reverify";
  originalSessionId: string;
}

/** Org flag read (same pure-shape rule as proctoringV2EnabledFromSettings). */
export function reverifyEnabledFromSettings(settings: unknown): boolean {
  return (
    typeof settings === "object" &&
    settings !== null &&
    (settings as Record<string, unknown>)["posthire_reverify_enabled"] === true
  );
}

/** Reverify info for the link a SESSION was started from; null for standard
 *  links, pre-0030 databases, and any read failure (fail-soft). */
export async function readReverifyInfoBySession(sessionId: string): Promise<ReverifyInfo | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("session_links")
      .select("kind, original_session_id")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (error || !data) return null; // 42703 pre-0030 lands here — fail soft
    const row = data as { kind?: string; original_session_id?: string | null };
    if (row.kind !== "reverify" || !row.original_session_id) return null;
    return { kind: "reverify", originalSessionId: row.original_session_id };
  } catch {
    return null;
  }
}

/** Reverify info by RAW TOKEN HASH lookup at session creation (the summary
 *  type doesn't carry the 0030 columns; this is the targeted side read). */
export async function readReverifyInfoByTokenHash(tokenHash: string): Promise<ReverifyInfo | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("session_links")
      .select("kind, original_session_id")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { kind?: string; original_session_id?: string | null };
    if (row.kind !== "reverify" || !row.original_session_id) return null;
    return { kind: "reverify", originalSessionId: row.original_session_id };
  } catch {
    return null;
  }
}

/**
 * Compare a reverify session's fresh enrolment embedding against the ORIGINAL
 * session's anchor and persist the derived similarity on the reverify
 * session's identity_checks row. Fail-soft null on every dormant path
 * (no anchor, version mismatch, pre-0027/0024). Never throws into the route.
 */
export async function recordReverifyComparison(
  reverifySessionId: string,
  originalSessionId: string,
  embedding: number[],
  modelVersion: string,
): Promise<number | null> {
  try {
    if (!supabase) return null;
    const anchor = await readAnchor(originalSessionId);
    if (!anchor || anchor.model_version !== modelVersion) return null;
    const sim = cosineSimilarity(anchor.embedding, embedding);
    if (sim === null) return null;
    const rounded = Math.round(sim * 100) / 100;

    const { error } = await supabase
      .from("identity_checks")
      .update({ reverify_of: originalSessionId, anchor_similarity: rounded })
      .eq("session_id", reverifySessionId);
    if (error) return null; // pre-0027 columns — comparison stays event-only

    // Derived values only, on BOTH sessions' timelines: the reverify session
    // records what it compared against; the original gains the day-one marker.
    await appendEvent(reverifySessionId, "identity.reverify", "system", {
      original_session_id: originalSessionId,
      anchor_similarity: rounded,
    });
    await appendEvent(originalSessionId, "identity.reverify_result", "system", {
      reverify_session_id: reverifySessionId,
      anchor_similarity: rounded,
    });
    return rounded;
  } catch {
    return null;
  }
}

export interface ReverifyStatus {
  original_session_id: string;
  anchor_similarity: number | null;
}

/** Review surface: this session's reverify comparison (when it was a reverify
 *  micro-session), or the day-one result recorded AGAINST this session (when
 *  it was the original). Null everywhere dormant. */
export async function readReverifyStatus(sessionId: string): Promise<ReverifyStatus | null> {
  if (!supabase) return null;
  try {
    // As the reverify session…
    const { data: own } = await supabase
      .from("identity_checks")
      .select("reverify_of, anchor_similarity")
      .eq("session_id", sessionId)
      .not("reverify_of", "is", null)
      .maybeSingle();
    const o = own as { reverify_of?: string | null; anchor_similarity?: number | string | null } | null;
    if (o?.reverify_of) {
      const sim = o.anchor_similarity === null || o.anchor_similarity === undefined ? null : Number(o.anchor_similarity);
      return {
        original_session_id: o.reverify_of,
        anchor_similarity: sim !== null && Number.isFinite(sim) ? sim : null,
      };
    }
    // …or as the original (the day-one check points back here).
    const { data: against } = await supabase
      .from("identity_checks")
      .select("session_id, anchor_similarity")
      .eq("reverify_of", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const a = against as { session_id?: string; anchor_similarity?: number | string | null } | null;
    if (a?.session_id) {
      const sim = a.anchor_similarity === null || a.anchor_similarity === undefined ? null : Number(a.anchor_similarity);
      return {
        original_session_id: sessionId,
        anchor_similarity: sim !== null && Number.isFinite(sim) ? sim : null,
      };
    }
    return null;
  } catch {
    return null; // pre-0027/0024 — no block renders
  }
}

export function reverifyTimeoutMin(): number {
  return env.REVERIFY_TIMEOUT_MIN;
}
