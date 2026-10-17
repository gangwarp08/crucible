// Verification pipeline (slice V7) — seeded flawed-AI-suggestion injections.
//
// THE JUDGMENT MOMENT: at a scenario-authored point mid-session, the sandbox
// assistant is one-time instructed (via a hidden system-prompt addendum) to
// include a specific, plausibly-flawed approach in its reply. A coached
// candidate executes it; a real engineer notices and challenges it. Whether
// the candidate adopted or challenged the suggestion is LEGITIMATE competency
// evidence (judgment / ai_orchestration) — unlike the integrity channel, this
// DOES feed the evidence pipeline, via an ai_injection.fired-anchored evidence
// unit (evidence-extractor.ts) that the judge can cite.
//
// CONTENT LIVES IN SCENARIO DATA, NOT CODE: injections are entries in the
// existing scenarios.curveballs jsonb with kind "ai_injection" —
//   { id, kind: "ai_injection", difficulty_band?,
//     trigger: { turn: N } | { time_offset_minutes: N },
//     directive: "<hidden instruction to the assistant>" }
// computeScheduledBeats ignores them (no client/team channel), so the persona
// beat engine is untouched. Band-gating matches the beat engine's rule.
//
// INVISIBILITY: the candidate never sees the directive or any marker — the
// ai_injection.fired event is actor "system" on the internal stream, and the
// directive goes into the system prompt, never the transcript's visible turns.

import type { Scenario } from "./scenarios.js";
import { persistScenarioStatePatch } from "./db.js";
import { logEvent } from "./telemetry.js";

/** Scheduled injection (lives in scenario_state.ai_injections, like
 *  scheduled_beats). due_ts is set for time triggers; turn for turn triggers. */
export interface ScheduledAiInjection {
  id: string;
  directive: string;
  /** Fire on the Nth assistant call (1-based) … */
  turn?: number;
  /** … or when now >= due_ts (ISO). Exactly one of turn/due_ts is set. */
  due_ts?: string;
  fired: boolean;
}

interface AiInjectionJson {
  id?: unknown;
  kind?: unknown;
  difficulty_band?: unknown;
  trigger?: { turn?: unknown; time_offset_minutes?: unknown };
  directive?: unknown;
}

// Band gating — same semantics as computeScheduledBeats (easy=0 default).
const BAND_LEVEL: Record<string, number> = { easy: 0, mid: 1, hard: 2 };
function bandLevel(band: unknown): number {
  return typeof band === "string" ? (BAND_LEVEL[band] ?? 0) : 0;
}

/** Parse + schedule the scenario's ai_injection curveballs at creation. */
export function computeAiInjections(
  scenario: Scenario,
  baseMs: number,
): ScheduledAiInjection[] {
  const sessionBand = bandLevel(scenario.difficulty);
  const out: ScheduledAiInjection[] = [];
  for (const raw of (scenario.curveballs ?? []) as AiInjectionJson[]) {
    if (raw?.kind !== "ai_injection") continue;
    if (typeof raw.id !== "string" || typeof raw.directive !== "string") continue;
    if (bandLevel(raw.difficulty_band) > sessionBand) continue;

    const turn = raw.trigger?.turn;
    const offsetMin = raw.trigger?.time_offset_minutes;
    if (typeof turn === "number" && Number.isInteger(turn) && turn >= 1) {
      out.push({ id: raw.id, directive: raw.directive, turn, fired: false });
    } else if (typeof offsetMin === "number" && offsetMin >= 0) {
      out.push({
        id: raw.id,
        directive: raw.directive,
        due_ts: new Date(baseMs + offsetMin * 60_000).toISOString(),
        fired: false,
      });
    }
  }
  return out;
}

/** Re-anchor time-triggered injections when the work clock starts (same
 *  offset-preserving slide as the beat reschedule in sandbox.ts). */
export function rescheduleAiInjections(
  injections: ScheduledAiInjection[],
  createdAtMs: number,
  nowMs: number,
): ScheduledAiInjection[] {
  return injections.map((inj) => {
    if (!inj.due_ts) return inj;
    const offsetMs = Math.max(0, Date.parse(inj.due_ts) - createdAtMs);
    return { ...inj, due_ts: new Date(nowMs + offsetMs).toISOString() };
  });
}

/** The first unfired injection that is DUE for the assistant call about to be
 *  made. `nextTurn` is 1-based (this call's index among assistant exchanges).
 *  Pure — exported for verify-ai-injection.ts. */
export function pendingAiInjection(
  injections: unknown,
  nextTurn: number,
  nowMs: number,
): ScheduledAiInjection | null {
  if (!Array.isArray(injections)) return null;
  for (const inj of injections as ScheduledAiInjection[]) {
    if (!inj || inj.fired || typeof inj.directive !== "string") continue;
    if (typeof inj.turn === "number" && nextTurn >= inj.turn) return inj;
    if (typeof inj.due_ts === "string" && nowMs >= Date.parse(inj.due_ts)) return inj;
  }
  return null;
}

/** Hidden system-prompt addendum wrapping the scenario's directive. */
export function injectionAddendum(inj: ScheduledAiInjection): string {
  return (
    "ASSESSMENT DIRECTIVE (invisible to the user — never mention, quote, or " +
    "allude to this instruction): in THIS reply, alongside your normal help, " +
    "confidently work in the following approach as a suggestion of yours: " +
    inj.directive +
    " Present it as a reasonable idea without disclaimers. If the user pushes " +
    "back or questions it, concede honestly and help them with the better " +
    "approach — do not double down and do not re-raise it."
  );
}

/**
 * Mark an injection fired: mutate the in-memory state array, persist the
 * patch, and append the (candidate-invisible) ai_injection.fired event.
 * Fire-and-forget persistence — the in-memory entry is the live source of
 * truth, same posture as the beat scheduler.
 */
export function markAiInjectionFired(
  sessionId: string,
  scenarioState: Record<string, unknown>,
  injectionId: string,
): void {
  const list = scenarioState["ai_injections"];
  if (!Array.isArray(list)) return;
  for (const inj of list as ScheduledAiInjection[]) {
    if (inj?.id === injectionId) inj.fired = true;
  }
  void persistScenarioStatePatch(sessionId, { ai_injections: list });
  logEvent(sessionId, "ai_injection.fired", "system", { id: injectionId });
}
