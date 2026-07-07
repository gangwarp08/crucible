// P4 — AI-Fluency Index: a PRESENTATION-ONLY mapping of the ai_orchestration
// competency score onto a three-band spectrum. It introduces NO new
// measurement — the underlying score is the single source of truth; this is
// a recruiter-facing label and must always be presented as informational.
//
// Signed-off thresholds:  < 2.5 AI-Dependent · 2.5–3.9 AI-Augmented ·
// >= 4 AI-Orchestrator. (Scores between 3.9 and 4 land in AI-Augmented —
// the boundary is "reaches 4".)

export const AI_FLUENCY_COMPETENCY = "ai_orchestration";

export type AiFluencyPlacement = "ai_dependent" | "ai_augmented" | "ai_orchestrator";

export const AI_FLUENCY_LABELS: Record<AiFluencyPlacement, string> = {
  ai_dependent: "AI-Dependent",
  ai_augmented: "AI-Augmented",
  ai_orchestrator: "AI-Orchestrator",
};

/** Map an ai_orchestration score (1–5, possibly null / not assessed) to its
 *  spectrum placement. Null in → null out: no score means no placement, never
 *  a default band. */
export function aiFluencyPlacement(
  score: number | null | undefined,
): AiFluencyPlacement | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  if (score >= 4) return "ai_orchestrator";
  if (score >= 2.5) return "ai_augmented";
  return "ai_dependent";
}
