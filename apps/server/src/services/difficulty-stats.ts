// P5.2 competency_difficulty_stats — per-(scenario, difficulty band, competency)
// calibration aggregates (v-next, migration 0020).
//
// Same recompute+upsert shape as scenario-stats.ts, plus a stale-row prune:
// after the upsert, (band, competency) rows for the scenario that are no
// longer in the computed set are deleted, so re-scores / deletes / band
// changes can't leave the aggregate stale. Two deliberate differences:
//
//   1. Only sessions with scorable IS TRUE enter the aggregate (RD3: excluded
//      sessions are not in the validity dataset, so they must not calibrate
//      difficulty either).
//   2. Grouped by the session's difficulty_band, falling back to the
//      scenario's own difficulty when the session band is null (P5.1 routing
//      lands separately; pre-routing sessions calibrate under the scenario's
//      published band). Sessions with neither are skipped.
//
// NEVER THROWS. Callers invoke it fire-and-forget next to updateScenarioStats,
// and migration 0020 may not be applied yet — a missing table/column must
// degrade to a logged no-op, not an unhandled rejection.

import { supabase } from "./supabase.js";

export const DIFFICULTY_STATS_VERSION = "1";

const PASS_THRESHOLD = 3; // score >= 3 == "meets bar" (same bar as scenario-stats)

export interface DifficultyStatRow {
  scenario_id: string;
  difficulty_band: string;
  competency_key: string;
  n: number;
  mean_score: number;
  pass_rate: number;
  spread: number;
  stats_version: string;
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Recompute + upsert competency_difficulty_stats for one scenario from the
 *  completed evaluations of its SCORABLE sessions, grouped by difficulty band.
 *  Fire-and-forget safe: logs and returns [] on any failure (including
 *  migration 0020 not yet applied). */
export async function updateDifficultyStats(scenarioId: string): Promise<DifficultyStatRow[]> {
  try {
    return await recompute(scenarioId);
  } catch (err) {
    console.error(
      `[difficulty-stats] update failed for scenario ${scenarioId} (non-fatal):`,
      (err as Error).message,
    );
    return [];
  }
}

async function recompute(scenarioId: string): Promise<DifficultyStatRow[]> {
  if (!supabase) throw new Error("Supabase service-role client unavailable");

  // Scenario's own difficulty = fallback band for sessions without a stamped
  // difficulty_band.
  const { data: scenRow, error: scErr } = await supabase
    .from("scenarios")
    .select("difficulty")
    .eq("id", scenarioId)
    .maybeSingle();
  if (scErr) throw new Error(`scenarios read failed: ${scErr.message}`);
  const fallbackBand = (scenRow as { difficulty: string | null } | null)?.difficulty ?? null;

  // Completed evaluations for the scenario.
  const { data: evalRows, error: eErr } = await supabase
    .from("evaluations")
    .select("id, session_id")
    .eq("scenario_id", scenarioId)
    .eq("status", "complete");
  if (eErr) throw new Error(`evaluations read failed: ${eErr.message}`);
  const evals = (evalRows ?? []) as Array<{ id: string; session_id: string | null }>;
  if (evals.length === 0) return [];

  // Their sessions — only scorable IS TRUE calibrates. Reading difficulty_band
  // here is the first touch of migration 0020's column; if it isn't applied
  // yet this read fails and the wrapper degrades gracefully.
  const sessionIds = [...new Set(evals.map((e) => e.session_id).filter((s): s is string => !!s))];
  if (sessionIds.length === 0) return [];
  const { data: sessRows, error: sErr } = await supabase
    .from("sessions")
    .select("id, scorable, difficulty_band")
    .in("id", sessionIds);
  if (sErr) throw new Error(`sessions read failed: ${sErr.message}`);

  const bandBySession = new Map<string, string>();
  for (const s of (sessRows ?? []) as Array<{
    id: string;
    scorable: boolean | null;
    difficulty_band: string | null;
  }>) {
    if (s.scorable !== true) continue; // scorable IS TRUE only (null/false excluded)
    const band = s.difficulty_band ?? fallbackBand;
    if (band) bandBySession.set(s.id, band);
  }

  const bandByEval = new Map<string, string>();
  for (const e of evals) {
    const band = e.session_id ? bandBySession.get(e.session_id) : undefined;
    if (band) bandByEval.set(e.id, band);
  }
  if (bandByEval.size === 0) return [];

  const { data: itemRows, error: iErr } = await supabase
    .from("evaluation_items")
    .select("evaluation_id, competency, score")
    .in("evaluation_id", [...bandByEval.keys()]);
  if (iErr) throw new Error(`evaluation_items read failed: ${iErr.message}`);

  // Aggregate scores per (band, competency). Scores kept as arrays so the
  // population stddev is exact (two-pass) — fine at calibration volumes.
  const agg = new Map<string, Map<string, number[]>>(); // band -> competency -> scores
  for (const r of (itemRows ?? []) as Array<{
    evaluation_id: string;
    competency: string;
    score: number | string | null;
  }>) {
    const band = bandByEval.get(r.evaluation_id);
    if (!band) continue;
    const score = Number(r.score);
    if (r.score === null || !Number.isFinite(score)) continue; // unassessed items don't calibrate
    const byCompetency = agg.get(band) ?? new Map<string, number[]>();
    const scores = byCompetency.get(r.competency) ?? [];
    scores.push(score);
    byCompetency.set(r.competency, scores);
    agg.set(band, byCompetency);
  }

  const rows: DifficultyStatRow[] = [];
  const nowIso = new Date().toISOString();
  for (const [band, byCompetency] of agg) {
    for (const [competency, scores] of byCompetency) {
      const n = scores.length;
      const mean = scores.reduce((a, b) => a + b, 0) / n;
      const pass = scores.filter((s) => s >= PASS_THRESHOLD).length;
      const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n; // population
      rows.push({
        scenario_id: scenarioId,
        difficulty_band: band,
        competency_key: competency,
        n,
        mean_score: round4(mean),
        pass_rate: round4(pass / n),
        spread: round4(Math.sqrt(variance)),
        stats_version: DIFFICULTY_STATS_VERSION,
      });
    }
  }

  if (rows.length > 0) {
    const { error: upErr } = await supabase
      .from("competency_difficulty_stats")
      .upsert(
        rows.map((r) => ({ ...r, updated_at: nowIso })),
        { onConflict: "scenario_id,difficulty_band,competency_key" },
      );
    if (upErr) throw new Error(`competency_difficulty_stats upsert failed: ${upErr.message}`);
  }

  // Full-recompute semantics: rows whose (band, competency) is no longer in
  // the computed set (session band changed, re-score dropped a competency,
  // sessions became unscorable) are deleted so the aggregate can't go stale.
  const computedKeys = new Set(rows.map((r) => `${r.difficulty_band}\u0000${r.competency_key}`));
  const { data: existing, error: exErr } = await supabase
    .from("competency_difficulty_stats")
    .select("difficulty_band, competency_key")
    .eq("scenario_id", scenarioId);
  if (exErr) throw new Error(`competency_difficulty_stats read failed: ${exErr.message}`);
  const staleByBand = new Map<string, string[]>();
  for (const r of (existing ?? []) as Array<{ difficulty_band: string; competency_key: string }>) {
    if (computedKeys.has(`${r.difficulty_band}\u0000${r.competency_key}`)) continue;
    const keys = staleByBand.get(r.difficulty_band) ?? [];
    keys.push(r.competency_key);
    staleByBand.set(r.difficulty_band, keys);
  }
  for (const [band, keys] of staleByBand) {
    const { error: delErr } = await supabase
      .from("competency_difficulty_stats")
      .delete()
      .eq("scenario_id", scenarioId)
      .eq("difficulty_band", band)
      .in("competency_key", keys);
    if (delErr) throw new Error(`competency_difficulty_stats delete failed: ${delErr.message}`);
  }

  return rows;
}
