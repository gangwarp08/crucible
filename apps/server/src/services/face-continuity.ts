// Verification continuity (DORMANT, slice V4) — enrolment anchor storage and
// periodic re-match against it.
//
// DORMANCY CONTRACT (mirrors proctoring-v2.ts): every entry point is gated on
// the org flag + an ACCEPTED consent, and is skip-graceful pre-0027 (anchor
// table absent → anchor never stored, continuity posts are acknowledged and
// dropped — never a crash, never a candidate-visible error).
//
// DATA MINIMIZATION (the load-bearing property):
//   - The ANCHOR is a browser-computed embedding vector of the enrolment
//     selfie — never the selfie. identity_anchors has no image-byte column.
//   - SAMPLE vectors (the periodic webcam re-match posts) are compared in
//     memory and DISCARDED; only the derived similarity persists, as
//     integrity.face_match {similarity} events on the informational channel.
//   - Compares are MODEL-VERSION-GATED: a sample from a different embedder
//     version than the anchor is dropped (vectors don't compare across
//     embedders), never mis-scored.
//
// MISMATCH RULE (mirrors the webcam-presence / typing-drift streak pattern):
// MISMATCH_CONSECUTIVE samples in a row below FACE_MATCH_THRESHOLD → ONE
// integrity.face_mismatch event; re-arms only after a sample back above the
// threshold. A sustained swap emits once, not continuously.

import { env } from "../env.js";
import { supabase } from "./supabase.js";
import { logEvent } from "./telemetry.js";

export const MISMATCH_CONSECUTIVE = 2;

/** Max embedding dimensionality accepted on the wire (schema + sanity). */
export const MAX_EMBED_DIM = 2048;

export class FaceContinuityError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FaceContinuityError";
  }
}

// ── Pure math (exported for verify-face-continuity.ts) ─────────────────────

/** Cosine similarity in [-1, 1]; null when the vectors are incomparable
 *  (dimension mismatch, zero norm, non-finite members). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na < 1e-12 || nb < 1e-12) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface MismatchState {
  belowStreak: number;
  emitted: boolean;
}

export function newMismatchState(): MismatchState {
  return { belowStreak: 0, emitted: false };
}

/** Streak core: returns true when THIS sample triggers the one mismatch
 *  emission (then latches until a sample recovers above the threshold). */
export function observeSimilarity(
  state: MismatchState,
  similarity: number,
  threshold: number,
): boolean {
  if (similarity >= threshold) {
    state.belowStreak = 0;
    state.emitted = false; // re-arm
    return false;
  }
  state.belowStreak++;
  if (state.belowStreak >= MISMATCH_CONSECUTIVE && !state.emitted) {
    state.emitted = true;
    return true;
  }
  return false;
}

// ── Anchor storage (skip-graceful pre-0027) ─────────────────────────────────

interface AnchorRow {
  embedding: number[];
  dim: number;
  model_version: string;
}

/**
 * Store the enrolment anchor (browser-computed embedding of the consented,
 * explicitly-submitted selfie). Returns true only when the row was written —
 * false covers every dormant/failure path (no Supabase, pre-0027, conflict).
 * One anchor per session (UNIQUE session_id): first write wins; a re-submit
 * of identity verification does not silently re-anchor.
 */
export async function storeAnchor(
  sessionId: string,
  orgId: string,
  embedding: number[],
  modelVersion: string,
): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("identity_anchors").insert({
      session_id: sessionId,
      org_id: orgId,
      embedding,
      dim: embedding.length,
      model_version: modelVersion,
    });
    if (error) return false; // dormant (42P01/PGRST205), duplicate, or transient — all fail soft
    return true;
  } catch {
    return false;
  }
}

/** Read a session's anchor; null on every dormant/absent path. */
export async function readAnchor(sessionId: string): Promise<AnchorRow | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("identity_anchors")
      .select("embedding, dim, model_version")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { embedding: unknown; dim: unknown; model_version: unknown };
    if (!Array.isArray(row.embedding) || typeof row.model_version !== "string") return null;
    const embedding = row.embedding.filter((x): x is number => typeof x === "number");
    if (embedding.length === 0) return null;
    return { embedding, dim: embedding.length, model_version: row.model_version };
  } catch {
    return null;
  }
}

/** Hard-delete a session's anchor (rides the identity-delete endpoint —
 *  biometric minimization). Returns rows removed; 0 on every dormant path. */
export async function deleteAnchor(
  sessionId: string,
  org: { id: string; role?: "admin" | "partner" } | undefined,
): Promise<number> {
  if (!supabase) return 0;
  try {
    let del = supabase.from("identity_anchors").delete().eq("session_id", sessionId);
    if (org && org.role !== "admin") del = del.eq("org_id", org.id);
    const { data, error } = await del.select("id");
    if (error) return 0;
    return (data ?? []).length;
  } catch {
    return 0;
  }
}

// ── Continuity sample ingest ────────────────────────────────────────────────

// Per-session in-memory state: cached anchor (avoid a DB read per sample) +
// mismatch streak. Pruned via clearFaceContinuity on session end.
interface SessionContinuity {
  anchor: AnchorRow | null; // null = looked up and absent (negative-cached)
  anchorLoaded: boolean;
  state: MismatchState;
}

const sessions = new Map<string, SessionContinuity>();

export interface ContinuityResult {
  /** Similarity in [-1,1], rounded to 2dp — or null when not comparable
   *  (no anchor, model-version mismatch, bad vector). */
  similarity: number | null;
  compared: boolean;
}

/**
 * Compare one posted sample embedding against the session's anchor. The
 * sample vector lives only in this call. Logs integrity.face_match for every
 * successful compare and integrity.face_mismatch on the streak rule. Never
 * throws into the route.
 */
export async function recordContinuitySample(
  sessionId: string,
  embedding: number[],
  modelVersion: string,
): Promise<ContinuityResult> {
  try {
    let sc = sessions.get(sessionId);
    if (!sc) {
      sc = { anchor: null, anchorLoaded: false, state: newMismatchState() };
      sessions.set(sessionId, sc);
    }
    if (!sc.anchorLoaded) {
      sc.anchor = await readAnchor(sessionId);
      sc.anchorLoaded = true;
    }
    const anchor = sc.anchor;
    if (!anchor) return { similarity: null, compared: false }; // dormant / not enrolled
    if (anchor.model_version !== modelVersion) {
      return { similarity: null, compared: false }; // version-gated — never mis-score
    }
    const sim = cosineSimilarity(anchor.embedding, embedding);
    if (sim === null) return { similarity: null, compared: false };

    const rounded = Math.round(sim * 100) / 100;
    logEvent(sessionId, "integrity.face_match", "system", { similarity: rounded });
    if (observeSimilarity(sc.state, sim, env.FACE_MATCH_THRESHOLD)) {
      logEvent(sessionId, "integrity.face_mismatch", "system", { similarity: rounded });
    }
    return { similarity: rounded, compared: true };
  } catch {
    return { similarity: null, compared: false };
  }
}

/** Session-end / test cleanup. */
export function clearFaceContinuity(sessionId?: string): void {
  if (sessionId) sessions.delete(sessionId);
  else sessions.clear();
}
