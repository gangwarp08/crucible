// RD3 (Slice 6.4): scorable vs excluded, with reason codes.
//
// A session enters the partner-facing validity dataset ONLY when every floor
// holds. When one fails, the session is EXCLUDED with a reason code — never
// scored 1. The point is to stop "infra hiccup" / "candidate quit early" /
// "scenario never surfaced the competency" from masquerading as "weak
// candidate." Every input here is recomputable (terminal reason, deliverable,
// evidence units, duration, defense outcome), so scorability can be re-derived
// whenever those inputs change — and a human can override the stored result.
//
// Pure function (no I/O): the analysis agent assembles the input from the same
// AnalysisInput the judge saw and persists the result; the verifier exercises
// this directly.

export type ExclusionReason =
  | "excluded_infra" // dirty terminal — error / budget / orphaned. Masks all other signal.
  | "excluded_abandoned" // too little engagement to be a real attempt.
  | "excluded_no_deliverable" // engaged, but submitted nothing to score.
  | "excluded_defense_unreachable" // verification fired but never reached the candidate (RD2 not_reached).
  | "excluded_insufficient_evidence"; // too few load-bearing competencies actually surfaced.

export interface ScorabilityResult {
  scorable: boolean;
  exclusionReason: ExclusionReason | null;
}

export interface ScorabilityInput {
  // sessions.end_reason. Clean ONLY for {manual, timeout}; anything else
  // (error, budget, orphaned, null) is an infra/abnormal terminal.
  endReason: string | null;
  // Did the candidate submit any non-empty deliverable field?
  deliverableNonEmpty: boolean;
  // Active session minutes (sessions.duration_ms / 60000), or null if unknown.
  activeDurationMin: number | null;
  // Candidate-driven activity count (queries + messages + AI turns + doc views
  // + file writes) — the "meaningful event count" alternative to the time floor.
  meaningfulEventCount: number;
  // Distinct load-bearing competencies with ≥1 evidence unit this session.
  loadBearingAssessedCount: number;
  // RD2 defense outcome. "not_reached" ⇒ the defense never reached the
  // candidate (verifier error / deadline / UI) — an evidence-sufficiency
  // problem, not a candidate failure. null ⇒ verification never fired (not a gate).
  defenseOutcome: string | null;
}

// Starting thresholds — calibrate on cohort 1, do NOT hard-freeze.
export const SCORABILITY_THRESHOLDS = {
  minActiveMinutes: 10,
  minMeaningfulEvents: 8,
  minLoadBearingAssessed: 3,
} as const;

const CLEAN_TERMINALS = new Set(["manual", "timeout"]);

function exclude(reason: ExclusionReason): ScorabilityResult {
  return { scorable: false, exclusionReason: reason };
}

/**
 * Decide scorability. Order matters — the first failing floor wins, most
 * signal-masking first:
 *   1. dirty terminal      → excluded_infra        (masks everything else)
 *   2. low engagement      → excluded_abandoned    (a 2-min quit isn't an attempt,
 *                                                    regardless of what it left behind)
 *   3. empty deliverable   → excluded_no_deliverable
 *   4. defense unreachable → excluded_defense_unreachable
 *   5. thin evidence       → excluded_insufficient_evidence
 */
export function computeScorability(i: ScorabilityInput): ScorabilityResult {
  const t = SCORABILITY_THRESHOLDS;

  if (!CLEAN_TERMINALS.has(i.endReason ?? "")) return exclude("excluded_infra");

  const engaged =
    (i.activeDurationMin ?? 0) >= t.minActiveMinutes ||
    i.meaningfulEventCount >= t.minMeaningfulEvents;
  if (!engaged) return exclude("excluded_abandoned");

  if (!i.deliverableNonEmpty) return exclude("excluded_no_deliverable");

  if (i.defenseOutcome === "not_reached") return exclude("excluded_defense_unreachable");

  if (i.loadBearingAssessedCount < t.minLoadBearingAssessed) {
    return exclude("excluded_insufficient_evidence");
  }

  return { scorable: true, exclusionReason: null };
}
