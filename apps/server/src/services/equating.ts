// P5.3 — equating hook across band-matched family members.
//
// READ-ONLY seam toward a common score scale: once two members of a family
// have calibration stats in the same band (competency_difficulty_stats,
// migration 0020 / services/difficulty-stats.ts), this compares their
// mean_score per competency and flags whether the pair is on the same scale
// (gap <= EQUATING_MAX_GAP). It writes nothing, changes no scores, and is
// versioned with DIFFICULTY_STATS_VERSION — only stats rows computed under
// the current formula are compared.
//
// Thresholds are deliberately blunt for the pilot (this is a comparability
// SMOKE CHECK, not IRT equating — that's v2):
//   - EQUATING_MIN_N: a side needs >= 5 scored items before its mean means
//     anything;
//   - EQUATING_MAX_GAP: band-matched members whose competency means differ
//     by more than 0.75 (on the 1–5 scale) are flagged as NOT comparable.

import { supabase } from "./supabase.js";
import { DIFFICULTY_STATS_VERSION } from "./difficulty-stats.js";

export const EQUATING_MIN_N = 5;
export const EQUATING_MAX_GAP = 0.75;

export interface EquatingComparison {
  family: string;
  band: string;
  competency: string;
  scenarioA: string;
  scenarioB: string;
  meanA: number;
  meanB: number;
  nA: number;
  nB: number;
  gap: number;
  comparable: boolean;
  stats_version: string;
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Pure gap math — exported so verify-equating-hook.ts can assert the
 *  threshold logic without a database. */
export function compareMeans(meanA: number, meanB: number): { gap: number; comparable: boolean } {
  const gap = round4(Math.abs(meanA - meanB));
  return { gap, comparable: gap <= EQUATING_MAX_GAP };
}

interface FamilyMemberRow {
  id: string;
  difficulty: string | null;
}

interface StatsRow {
  scenario_id: string;
  difficulty_band: string;
  competency_key: string;
  n: number;
  mean_score: number | string | null;
  stats_version: string;
}

/** For each band of `familyId` with >= 2 member scenarios that have
 *  calibration stats (n >= EQUATING_MIN_N per side), compare mean_score per
 *  competency pairwise. Returns [] when the family is unknown, no band has
 *  two calibrated members, or migration 0020 isn't applied (graceful). */
export async function checkBandEquating(familyId: string): Promise<EquatingComparison[]> {
  if (!supabase) throw new Error("Supabase service-role client unavailable");

  const { data: memberRows, error: memErr } = await supabase
    .from("scenarios")
    .select("id, difficulty")
    .eq("family_id", familyId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true }); // deterministic tie-break
  if (memErr) throw new Error(`family members read failed: ${memErr.message}`);
  const members = (memberRows ?? []) as unknown as FamilyMemberRow[];
  if (members.length < 2) return [];

  // Bands with >= 2 members (keyed on each member's published difficulty —
  // isomorphs included: a calibrated isomorph IS comparable to its canonical).
  const membersByBand = new Map<string, string[]>();
  for (const m of members) {
    if (!m.difficulty) continue;
    const ids = membersByBand.get(m.difficulty) ?? [];
    ids.push(m.id);
    membersByBand.set(m.difficulty, ids);
  }

  const out: EquatingComparison[] = [];
  for (const [band, ids] of membersByBand) {
    if (ids.length < 2) continue;

    const { data: statRows, error: statErr } = await supabase
      .from("competency_difficulty_stats")
      .select("scenario_id, difficulty_band, competency_key, n, mean_score, stats_version")
      .in("scenario_id", ids)
      .eq("difficulty_band", band)
      .eq("stats_version", DIFFICULTY_STATS_VERSION);
    if (statErr) {
      // Migration 0020 not applied → table missing. Read-only hook: degrade
      // to "nothing comparable yet" rather than erroring the whole endpoint.
      if (/42P01|Could not find the table/i.test(statErr.message)) {
        console.warn("[equating] competency_difficulty_stats missing (0020 not applied) — returning []");
        return [];
      }
      throw new Error(`stats read failed: ${statErr.message}`);
    }

    // competency -> per-scenario calibrated sides (n gate applied here).
    const sides = new Map<string, Array<{ scenarioId: string; mean: number; n: number }>>();
    for (const r of (statRows ?? []) as unknown as StatsRow[]) {
      const mean = Number(r.mean_score);
      if (r.mean_score === null || !Number.isFinite(mean)) continue;
      if (r.n < EQUATING_MIN_N) continue;
      const list = sides.get(r.competency_key) ?? [];
      list.push({ scenarioId: r.scenario_id, mean, n: r.n });
      sides.set(r.competency_key, list);
    }

    for (const [competency, list] of sides) {
      if (list.length < 2) continue;
      // Deterministic order (family member order, i.e. created_at).
      list.sort((a, b) => ids.indexOf(a.scenarioId) - ids.indexOf(b.scenarioId));
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!;
          const b = list[j]!;
          const { gap, comparable } = compareMeans(a.mean, b.mean);
          out.push({
            family: familyId,
            band,
            competency,
            scenarioA: a.scenarioId,
            scenarioB: b.scenarioId,
            meanA: round4(a.mean),
            meanB: round4(b.mean),
            nA: a.n,
            nB: b.n,
            gap,
            comparable,
            stats_version: DIFFICULTY_STATS_VERSION,
          });
        }
      }
    }
  }

  return out;
}
