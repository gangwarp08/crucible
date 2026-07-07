// AI-Fluency Index — presentation-only labels for the server-computed
// placement (mirror of apps/server/src/services/ai-fluency.ts thresholds:
// < 2.5 AI-Dependent · 2.5–3.9 AI-Augmented · >= 4 AI-Orchestrator). The
// browser never re-derives the placement from scores; it only renders what
// the server sent, ALWAYS marked informational.

import type { AiFluencyPlacement } from "./api";

export const AI_FLUENCY_LABELS: Record<AiFluencyPlacement, string> = {
  ai_dependent: "AI-Dependent",
  ai_augmented: "AI-Augmented",
  ai_orchestrator: "AI-Orchestrator",
};

/** Spectrum order, left (least fluent) → right (most fluent). */
export const AI_FLUENCY_SPECTRUM: AiFluencyPlacement[] = [
  "ai_dependent",
  "ai_augmented",
  "ai_orchestrator",
];

export function aiFluencyLabel(placement: AiFluencyPlacement | null): string {
  return placement ? AI_FLUENCY_LABELS[placement] : "—";
}
