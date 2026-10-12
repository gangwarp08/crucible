// Verification slice (detector v5) — server-side typing-rhythm drift detection.
//
// Consumes the client's integrity.typing_window feature stream (aggregated
// rhythm statistics; see lib/typing-dynamics.ts — raw keystrokes never leave
// the browser) and authors a server-side integrity.typing_drift event when the
// rhythm shows a sustained step change against the session-start baseline —
// the signature of a mid-session person swap (proxy handoff).
//
// Same posture as geo-integrity.ts: SERVER-authored derived events on the
// informational integrity channel; deterministic; never throws into the
// request path; never feeds competency scoring (evidence-extractor filters
// integrity.*).
//
// DETECTION RULE (deliberately simple + deterministic):
//   - Baseline: mean of mean_iki_ms over the first BASELINE_WINDOWS qualifying
//     windows (n >= MIN_WINDOW_KEYS). Until the baseline exists, nothing fires.
//   - Drift: a window whose mean_iki_ms deviates from the baseline by more
//     than max(ABS_DELTA_MS, REL_DELTA * baseline) counts toward a streak;
//     DRIFT_CONSECUTIVE such windows in a row → ONE integrity.typing_drift
//     event. The streak then re-arms only after a window back inside the band
//     (a sustained new rhythm emits once, not continuously — mirrors the
//     webcam-presence streak pattern).

import { logEvent } from "./telemetry.js";

export const BASELINE_WINDOWS = 5;
export const MIN_WINDOW_KEYS = 30;
export const ABS_DELTA_MS = 40;
export const REL_DELTA = 0.35;
export const DRIFT_CONSECUTIVE = 2;

export interface TypingWindowFeatures {
  n: number;
  mean_iki_ms: number;
}

interface DriftState {
  baselineSamples: number[]; // mean_iki of qualifying windows until baseline set
  baseline: number | null;
  driftStreak: number;
  emitted: boolean; // latched while the rhythm stays outside the band
  windowsSeen: number;
}

// In-memory, per-session — same lifecycle posture as the integrity rate
// limiter (routes/integrity.ts): tiny entries, pruned via clearTypingDrift on
// session end, and worst-case lost on a server restart (drift detection
// simply restarts its baseline — acceptable for an informational signal).
const states = new Map<string, DriftState>();

/** Pure decision core — exported for verify-typing-drift.ts. Returns whether
 *  THIS window triggers a drift emission, mutating the state. */
export function observeWindow(state: DriftState, w: TypingWindowFeatures): boolean {
  state.windowsSeen++;
  if (w.n < MIN_WINDOW_KEYS) return false; // thin window — ignore entirely

  if (state.baseline === null) {
    state.baselineSamples.push(w.mean_iki_ms);
    if (state.baselineSamples.length >= BASELINE_WINDOWS) {
      state.baseline =
        state.baselineSamples.reduce((s, v) => s + v, 0) / state.baselineSamples.length;
    }
    return false;
  }

  const band = Math.max(ABS_DELTA_MS, REL_DELTA * state.baseline);
  const outside = Math.abs(w.mean_iki_ms - state.baseline) > band;

  if (!outside) {
    state.driftStreak = 0;
    state.emitted = false; // re-arm: a later new rhythm is a new signal
    return false;
  }
  state.driftStreak++;
  if (state.driftStreak >= DRIFT_CONSECUTIVE && !state.emitted) {
    state.emitted = true;
    return true;
  }
  return false;
}

/** Fresh state — exported for the verify script. */
export function newDriftState(): DriftState {
  return { baselineSamples: [], baseline: null, driftStreak: 0, emitted: false, windowsSeen: 0 };
}

/**
 * Feed one accepted integrity.typing_window payload into the session's drift
 * tracker. Called from the integrity ingest route AFTER the event was admitted
 * and logged. Fire-and-forget: never throws.
 */
export function recordTypingWindow(sessionId: string, payload: Record<string, unknown>): void {
  try {
    const n = payload["n"];
    const mean = payload["mean_iki_ms"];
    if (typeof n !== "number" || typeof mean !== "number") return;

    let state = states.get(sessionId);
    if (!state) {
      state = newDriftState();
      states.set(sessionId, state);
    }
    if (observeWindow(state, { n, mean_iki_ms: mean })) {
      // Derived values only — enough for a reviewer to see the magnitude of
      // the step change and when it happened; no raw timings.
      logEvent(sessionId, "integrity.typing_drift", "system", {
        baseline_mean_ms: Math.round(state.baseline ?? 0),
        window_mean_ms: Math.round(mean),
        windows: state.windowsSeen,
      });
    }
  } catch {
    /* informational channel — never disturb ingest */
  }
}

/** Session-end / test cleanup. */
export function clearTypingDrift(sessionId?: string): void {
  if (sessionId) states.delete(sessionId);
  else states.clear();
}
