// RD2 (Slice 6.3): deterministic defense-outcome classification + the
// verification-driven execution cap.
//
// Until 6.3 the cap lived ONLY in the judge prompt ("an undefended result CAPS
// execution at ~3"), which made it (a) non-deterministic and (b) impossible to
// gate behind human review. This module pulls the cap OUT of the prompt and
// makes it a deterministic post-processing step: classify the defense, decide a
// cap status, and — under the pilot advisory flag — record it as
// `advisory_pending` so a human confirms before it touches the official score.
//
// Pure functions only (no I/O): the analysis agent computes these from the same
// verification transcript the judge saw, and the verifier outcomes verifier
// exercises them directly.

import type { CondensedVerification } from "./analysis-input.js";
import type { DefenseOutcome, VerificationCapStatus } from "./session-lifecycle.js";

// The execution band a confirmed verification cap collapses to. A deliverable
// the candidate cannot defend is worth at most "meets bar" on execution —
// never the 4-5 that signals real mastery — even when the final figure happens
// to match ground truth, because we cannot trust an answer they can't explain.
export const VERIFICATION_CAP_SCORE = 3;

// Answers that disclaim authorship/understanding rather than defend the work.
// Matched case-insensitively against the trimmed answer.
const REFUSAL_RE =
  /\b(i\s*(don'?t|do\s*not)\s*know|no\s*idea|not\s*sure|the\s*(ai|model|assistant|bot)\s*(did|wrote|made|built|generated)|chatgpt|claude\s*did|can'?t\s*(remember|recall|explain)|i\s*(forget|forgot)|i\s*just\s*(copied|pasted)|decline\b|i'?ll\s*pass|skip\s*(this|that)?)\b/i;

// Below this an answer is too terse to be a real defense of a consequential
// decision — a one-word "yes" / "the query" is non-committal, not coherent.
const MIN_SUBSTANTIVE_CHARS = 25;

export type AnswerClass = "strong" | "weak" | "refusal";

/** Classify ONE candidate defense answer. Deterministic, no LLM. */
export function classifyAnswer(text: string): AnswerClass {
  const t = text.trim();
  if (t.length === 0) return "refusal";
  if (REFUSAL_RE.test(t)) return "refusal";
  if (t.length < MIN_SUBSTANTIVE_CHARS) return "weak";
  return "strong";
}

/**
 * Session-level defense outcome from the verification transcript.
 *
 *  - null         verification never fired — not a defense at all, no penalty
 *  - "not_reached" prompted but the candidate never answered (deadline / UI /
 *                  infra). NOT the candidate's fault → never caps.
 *  - "declined"   answered, but EVERY answer is a refusal ("I don't know",
 *                  credits the AI). Goes to human review.
 *  - "weak"       answered, but ≥1 answer is non-substantive / evasive.
 *  - "coherent"   every answer is substantive.
 */
export function computeDefenseOutcome(v: CondensedVerification): DefenseOutcome | null {
  if (!v.prompted) return null;
  const answers = v.turns.filter((t) => t.role === "candidate").map((t) => t.text);
  if (answers.length === 0) return "not_reached";
  const classes = answers.map(classifyAnswer);
  if (classes.every((c) => c === "refusal")) return "declined";
  if (classes.some((c) => c !== "strong")) return "weak";
  return "coherent";
}

/**
 * Map a defense outcome to a verification cap status. Pure.
 *
 *  advisory=true  → a cappable outcome (weak / declined) becomes
 *                   "advisory_pending": recorded, NOT applied to the official
 *                   score until a human confirms in review.
 *  advisory=false → a cappable outcome becomes "applied": the deterministic cap
 *                   bites immediately (legacy auto-cap behaviour).
 *
 * coherent / not_reached / null never cap → "none".
 */
export function capStatusFor(
  outcome: DefenseOutcome | null,
  advisory: boolean,
): VerificationCapStatus {
  if (outcome === "weak" || outcome === "declined") {
    return advisory ? "advisory_pending" : "applied";
  }
  return "none";
}

/**
 * Apply the execution cap to a scored item list (returns a NEW list). Only the
 * `execution` competency is capped — it is the load-bearing "did they actually
 * do the work" band the verification probes. Items already at/below the cap are
 * unchanged, so this is idempotent.
 */
export function applyExecutionCap<T extends { competency: string; score: number | null }>(
  items: T[],
): T[] {
  return items.map((it) =>
    it.competency === "execution" && it.score !== null && it.score > VERIFICATION_CAP_SCORE
      ? { ...it, score: VERIFICATION_CAP_SCORE }
      : it,
  );
}
