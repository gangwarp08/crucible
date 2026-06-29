// L6 scenario_stats — running per-(scenario, competency) aggregates (Slice 5.7).
//
// Recomputed after each evaluation persists (fire-and-forget from the analysis
// agent). Proto-difficulty signal: as sessions accrue, mean_score + pass_rate +
// n per competency show how hard a scenario plays for real candidates, feeding
// the v2 difficulty calibration without committing to IRT yet.
//
// Full recompute over the scenario's completed evaluations (not an incremental
// running mean) so a re-scored or deleted evaluation can't leave the aggregate
// stale — correctness over cleverness at MVP volumes.

import { supabase } from "./supabase.js";

const PASS_THRESHOLD = 3; // score >= 3 == "meets bar"

export class ScenarioStatsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ScenarioStatsError";
  }
}

export interface ScenarioStatRow {
  scenario_id: string;
  competency_key: string;
  n: number;
  mean_score: number;
  pass_rate: number;
}

/** Recompute + upsert scenario_stats for one scenario from its completed
 *  evaluations' items. Best-effort: callers invoke it fire-and-forget. */
export async function updateScenarioStats(scenarioId: string): Promise<ScenarioStatRow[]> {
  if (!supabase) throw new ScenarioStatsError("Supabase service-role client unavailable");

  // Completed evaluations for the scenario → their item scores.
  const { data: evalRows, error: eErr } = await supabase
    .from("evaluations")
    .select("id")
    .eq("scenario_id", scenarioId)
    .eq("status", "complete");
  if (eErr) throw new ScenarioStatsError(`evaluations read failed: ${eErr.message}`);
  const evalIds = ((evalRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (evalIds.length === 0) return [];

  const { data: itemRows, error: iErr } = await supabase
    .from("evaluation_items")
    .select("competency, score")
    .in("evaluation_id", evalIds);
  if (iErr) throw new ScenarioStatsError(`evaluation_items read failed: ${iErr.message}`);

  // Aggregate per competency.
  const agg = new Map<string, { sum: number; pass: number; n: number }>();
  for (const r of (itemRows ?? []) as Array<{ competency: string; score: number | string }>) {
    const score = Number(r.score);
    if (!Number.isFinite(score)) continue;
    const a = agg.get(r.competency) ?? { sum: 0, pass: 0, n: 0 };
    a.sum += score;
    if (score >= PASS_THRESHOLD) a.pass += 1;
    a.n += 1;
    agg.set(r.competency, a);
  }

  const rows: ScenarioStatRow[] = [];
  const upsertRows = [] as Array<Record<string, unknown>>;
  const nowIso = new Date().toISOString();
  for (const [competency, a] of agg) {
    const mean = Math.round((a.sum / a.n) * 1e4) / 1e4;
    const passRate = Math.round((a.pass / a.n) * 1e4) / 1e4;
    rows.push({ scenario_id: scenarioId, competency_key: competency, n: a.n, mean_score: mean, pass_rate: passRate });
    upsertRows.push({
      scenario_id: scenarioId,
      competency_key: competency,
      n: a.n,
      mean_score: mean,
      pass_rate: passRate,
      updated_at: nowIso,
    });
  }

  if (upsertRows.length > 0) {
    const { error: upErr } = await supabase
      .from("scenario_stats")
      .upsert(upsertRows, { onConflict: "scenario_id,competency_key" });
    if (upErr) throw new ScenarioStatsError(`scenario_stats upsert failed: ${upErr.message}`);
  }
  return rows;
}
