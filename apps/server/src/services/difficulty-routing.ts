// P5.1 — difficulty routing at session creation.
//
// A session link can carry a requested difficulty band (migration 0022).
// When that link is consumed, session creation resolves the canonical
// scenario to the family sibling published in the requested band — BEFORE
// the sandbox is created. This is the honest half of "dynamic engine":
// routing chooses a pre-calibrated item; it NEVER adapts mid-session
// (running sessions are immutable — nothing re-routes or restamps a band
// after the sessions row is inserted; see verify-difficulty-routing.ts).
//
// Sibling selection ground truth (migration 0011):
//   - same family_id
//   - scenarios.difficulty === the requested band
//   - isomorph_of IS NULL (isomorphs are alternate FORMS, never routing
//     targets — the canonical member of each band is)
//
// NEVER FAILS THE SESSION: any miss (no family, no sibling in that band,
// DB error, scenario not found) falls back to the ORIGINAL scenario with
// routed:false so the candidate always gets an assessment.

import { supabase } from "./supabase.js";

export const DIFFICULTY_BANDS = ["easy", "mid", "hard"] as const;
export type DifficultyBand = (typeof DIFFICULTY_BANDS)[number];

export function isDifficultyBand(v: unknown): v is DifficultyBand {
  return typeof v === "string" && (DIFFICULTY_BANDS as readonly string[]).includes(v);
}

export interface BandRouting {
  /** The scenario to instantiate — the band sibling when routing succeeded,
   *  else the original scenario (never null: routing never fails a session). */
  scenarioId: string;
  /** Did the requested band get satisfied? false = fallback to the original. */
  routed: boolean;
  requestedBand: DifficultyBand;
  /** The EFFECTIVE band — the routed scenario's own difficulty. This (not the
   *  requested band) is what gets stamped on sessions.difficulty_band, so a
   *  fallback session is recorded under the band it actually ran at. */
  effectiveBand: DifficultyBand | null;
}

/** Pure: which band gets stamped on the session for a scenario that runs with
 *  the given published difficulty? Non-band values (null / legacy strings)
 *  stamp nothing. Exported so the verifier can test the stamping logic
 *  without creating a session. */
export function effectiveBandForStamp(scenarioDifficulty: string | null | undefined): DifficultyBand | null {
  return isDifficultyBand(scenarioDifficulty) ? scenarioDifficulty : null;
}

interface ScenarioBandRow {
  id: string;
  family_id: string | null;
  difficulty: string | null;
}

/** Resolve the scenario to instantiate for a requested band.
 *
 *  - scenario.difficulty === band → the scenario itself (routed:true);
 *  - else the family sibling WHERE family_id matches AND difficulty = band
 *    AND isomorph_of IS NULL (routed:true);
 *  - else (or on ANY error) the original scenario with routed:false.
 */
export async function resolveScenarioForBand(
  scenarioId: string,
  band: DifficultyBand,
): Promise<BandRouting> {
  const fallback = (difficulty: string | null): BandRouting => ({
    scenarioId,
    routed: false,
    requestedBand: band,
    effectiveBand: effectiveBandForStamp(difficulty),
  });

  try {
    if (!supabase) return fallback(null);

    const { data: original, error: origErr } = await supabase
      .from("scenarios")
      .select("id, family_id, difficulty")
      .eq("id", scenarioId)
      .maybeSingle();
    if (origErr || !original) {
      if (origErr) {
        console.error(`[difficulty-routing] scenario read failed for ${scenarioId}:`, origErr.message);
      }
      return fallback(null);
    }
    const orig = original as unknown as ScenarioBandRow;

    // Already in the requested band — trivially routed.
    if (orig.difficulty === band) {
      return { scenarioId, routed: true, requestedBand: band, effectiveBand: band };
    }
    if (!orig.family_id) return fallback(orig.difficulty);

    // Canonical family sibling in the requested band. isomorph_of IS NULL:
    // isomorphs are measurement forms, never direct routing targets. Ordered
    // by created_at so the pick is deterministic if a band ever has two
    // canonical members.
    const { data: sibling, error: sibErr } = await supabase
      .from("scenarios")
      .select("id, family_id, difficulty")
      .eq("family_id", orig.family_id)
      .eq("difficulty", band)
      .is("isomorph_of", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (sibErr) {
      console.error(`[difficulty-routing] sibling read failed for family ${orig.family_id}:`, sibErr.message);
      return fallback(orig.difficulty);
    }
    if (!sibling) return fallback(orig.difficulty);

    return {
      scenarioId: (sibling as unknown as ScenarioBandRow).id,
      routed: true,
      requestedBand: band,
      effectiveBand: band,
    };
  } catch (err) {
    // Routing must never fail a session start.
    console.error(`[difficulty-routing] unexpected failure for ${scenarioId}:`, (err as Error).message);
    return fallback(null);
  }
}
