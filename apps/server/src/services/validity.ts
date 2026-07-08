// Validity instrumentation (validity-dashboard spec) — READ-ONLY aggregation
// over existing tables/services. This module adds NO measurement logic and NO
// writes: it is the cockpit that reads the instrument, safe to run mid-pilot.
//
// Governing properties (spec §1), enforced here — not in the routes, not in
// the browser:
//   - Version-aware: metrics never pool across a judge_prompt_version or
//     competency_model_version boundary. The CURRENT version set is derived
//     from the data (stamps of the newest complete evaluation under the
//     current judge prompt); anything else is the LEGACY segment, excluded
//     from every metric view and surfaced only by the versions panel.
//   - Scorable-only (RD3): metric views aggregate sessions.scorable IS TRUE
//     only. The exclusions view is the single exception — it reports on the
//     excluded set itself.
//   - Small-N-honest: below MIN_N (segments) / MIN_PAIRED_N (correlations)
//     the numeric fields are NULLED server-side and insufficient_n is set, so
//     no client can accidentally render an indefensible number.
//   - Server computes all arithmetic; reuses the existing correlation service
//     (outcomes.ts) rather than reimplementing it.

import { supabase } from "./supabase.js";
import { JUDGE_PROMPT_VERSION } from "./analysis-agent.js";
import {
  correlateOutcomes,
  OUTCOME_TYPES,
  type OutcomeType,
} from "./outcomes.js";

export const MIN_N = 10; // per-segment gate (signed off)
export const MIN_PAIRED_N = 20; // correlation paired-N gate (signed off)

// Discrimination flags (1–5 score scale): a competency whose scores bunch
// within ~half a band isn't separating candidates; an item that doesn't track
// the corrected total signals a construct/binding problem.
const BUNCHED_SD = 0.5;
const LOW_ITEM_TOTAL_R = 0.2;

export class ValidityError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidityError";
  }
}

export interface ValidityFilters {
  scenario_id?: string | undefined;
  family_id?: string | undefined;
  band?: string | undefined;
  from?: string | undefined; // ISO datetime, on sessions.created_at
  to?: string | undefined;
}

interface VersionContext {
  competency_model_version: string;
  detector_version: string;
  judge_prompt_version: string;
}

interface Envelope {
  version_context: VersionContext;
  min_n: number;
  generated_from: { scorable_sessions_n: number };
}

// ── Shared loader ─────────────────────────────────────────────────────────────
// One pass loads the joined evaluation/session/item rows every view consumes.
// All version scoping and scorability filtering happens HERE so no view can
// forget a guard.

interface EvalRow {
  id: string;
  session_id: string | null;
  scenario_id: string | null;
  overall_score: number | null;
  competency_model_version: number | string | null;
  detector_version: string | null;
  judge_prompt_version: string | null;
  scenario_version: string | number | null;
}

interface SessionRow {
  id: string;
  scenario_id: string | null;
  org_id: string | null;
  scorable: boolean | null;
  exclusion_reason: string | null;
  difficulty_band: string | null;
  status: string | null;
  created_at: string;
}

interface ItemRow {
  evaluation_id: string;
  competency: string;
  score: number | null;
  assessed: boolean | null;
  weight: number | null;
}

export interface ValidityDataset {
  /** Scorable sessions inside the CURRENT version context, post-filters. */
  current: Array<{ evaluation: EvalRow; session: SessionRow; items: ItemRow[] }>;
  /** Complete evaluations OUTSIDE the current version set (any scorability). */
  legacy: Array<{ evaluation: EvalRow; session: SessionRow | null }>;
  /** ALL filtered sessions with a scorability verdict (for exclusions). */
  sessions: SessionRow[];
  versionContext: VersionContext;
  scenarioSlugById: Map<string, string>;
  loadBearingByScenario: Map<string, Map<string, boolean>>;
}

function requireClient(): NonNullable<typeof supabase> {
  if (!supabase) throw new ValidityError("Supabase service-role client unavailable");
  return supabase;
}

export async function loadValidityDataset(
  filters: ValidityFilters,
): Promise<ValidityDataset> {
  const db = requireClient();

  // Scenario metadata first: slug map, family filter resolution, and the
  // rubric binding's load_bearing flags (read, never recomputed).
  const { data: scenRows, error: scErr } = await db
    .from("scenarios")
    .select("id, slug, family_id, rubric");
  if (scErr) throw new ValidityError(`scenarios read failed: ${scErr.message}`);
  const scenarios = (scenRows ?? []) as Array<{
    id: string; slug: string; family_id: string | null;
    rubric: Array<{ competency_key: string; load_bearing?: boolean }> | null;
  }>;
  const scenarioSlugById = new Map(scenarios.map((s) => [s.id, s.slug]));
  const loadBearingByScenario = new Map<string, Map<string, boolean>>();
  for (const s of scenarios) {
    const m = new Map<string, boolean>();
    for (const b of Array.isArray(s.rubric) ? s.rubric : []) {
      m.set(b.competency_key, b.load_bearing !== false);
    }
    loadBearingByScenario.set(s.id, m);
  }
  const familyScenarioIds = filters.family_id
    ? new Set(scenarios.filter((s) => s.family_id === filters.family_id).map((s) => s.id))
    : null;

  // Sessions with a scorability verdict (lifecycle finalizer ran), filtered.
  let sq = db
    .from("sessions")
    .select("id, scenario_id, org_id, scorable, exclusion_reason, difficulty_band, status, created_at")
    .not("scorable", "is", null);
  if (filters.scenario_id) sq = sq.eq("scenario_id", filters.scenario_id);
  if (filters.band) sq = sq.eq("difficulty_band", filters.band);
  if (filters.from) sq = sq.gte("created_at", filters.from);
  if (filters.to) sq = sq.lte("created_at", filters.to);
  const { data: sessRows, error: sErr } = await sq;
  if (sErr) throw new ValidityError(`sessions read failed: ${sErr.message}`);
  let sessions = (sessRows ?? []) as SessionRow[];
  if (familyScenarioIds) {
    sessions = sessions.filter((s) => s.scenario_id && familyScenarioIds.has(s.scenario_id));
  }
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  // Complete evaluations for those sessions.
  const evalRows: EvalRow[] = [];
  const sessionIds = sessions.map((s) => s.id);
  // .in() has practical URL limits — chunk defensively.
  for (let i = 0; i < sessionIds.length; i += 200) {
    const chunk = sessionIds.slice(i, i + 200);
    if (chunk.length === 0) break;
    const { data, error } = await db
      .from("evaluations")
      .select("id, session_id, scenario_id, overall_score, competency_model_version, detector_version, judge_prompt_version, scenario_version")
      .eq("status", "complete")
      .in("session_id", chunk);
    if (error) throw new ValidityError(`evaluations read failed: ${error.message}`);
    evalRows.push(...((data ?? []) as EvalRow[]));
  }

  // CURRENT version context = the code's judge prompt + the stamps of the
  // newest evaluation scored under it (competency model version lives in the
  // data, not a code constant). Legacy = any other judge/model stamp.
  const currentJudge = JUDGE_PROMPT_VERSION;
  const underCurrentJudge = evalRows.filter(
    (e) => String(e.judge_prompt_version ?? "") === currentJudge,
  );
  const modelVersions = [...new Set(
    underCurrentJudge.map((e) => String(e.competency_model_version ?? "")).filter(Boolean),
  )].sort((a, b) => Number(b) - Number(a));
  const currentModel = modelVersions[0] ?? "";
  const detectorVersions = [...new Set(
    underCurrentJudge.map((e) => String(e.detector_version ?? "")).filter(Boolean),
  )].sort((a, b) => Number(b) - Number(a));
  const versionContext: VersionContext = {
    competency_model_version: currentModel,
    detector_version: detectorVersions[0] ?? "",
    judge_prompt_version: currentJudge,
  };

  const isCurrent = (e: EvalRow): boolean =>
    String(e.judge_prompt_version ?? "") === currentJudge &&
    (currentModel === "" || String(e.competency_model_version ?? "") === currentModel);

  const currentEvals = evalRows.filter(
    (e) => isCurrent(e) && e.session_id && sessionById.get(e.session_id)?.scorable === true,
  );
  const legacy = evalRows
    .filter((e) => !isCurrent(e))
    .map((e) => ({ evaluation: e, session: e.session_id ? sessionById.get(e.session_id) ?? null : null }));

  // Items for the current, scorable evaluations only.
  const itemsByEval = new Map<string, ItemRow[]>();
  const evalIds = currentEvals.map((e) => e.id);
  for (let i = 0; i < evalIds.length; i += 200) {
    const chunk = evalIds.slice(i, i + 200);
    if (chunk.length === 0) break;
    const { data, error } = await db
      .from("evaluation_items")
      .select("evaluation_id, competency, score, assessed, weight")
      .in("evaluation_id", chunk);
    if (error) throw new ValidityError(`evaluation_items read failed: ${error.message}`);
    for (const r of (data ?? []) as ItemRow[]) {
      const arr = itemsByEval.get(r.evaluation_id) ?? [];
      arr.push(r);
      itemsByEval.set(r.evaluation_id, arr);
    }
  }

  return {
    current: currentEvals.map((e) => ({
      evaluation: e,
      session: sessionById.get(e.session_id!)!,
      items: itemsByEval.get(e.id) ?? [],
    })),
    legacy,
    sessions,
    versionContext,
    scenarioSlugById,
    loadBearingByScenario,
  };
}

function envelope(ds: ValidityDataset): Envelope {
  return {
    version_context: ds.versionContext,
    min_n: MIN_N,
    generated_from: { scorable_sessions_n: ds.current.length },
  };
}

// ── Shared math ───────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}
function stdev(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}
function pearsonR(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs), my = mean(ys);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i]! - mx) * (ys[i]! - my);
    vx += (xs[i]! - mx) ** 2;
    vy += (ys[i]! - my) ** 2;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}
function round4(v: number | null): number | null {
  return v === null ? null : Math.round(v * 1e4) / 1e4;
}

// ── 4.1 Discrimination ───────────────────────────────────────────────────────

export function computeDiscrimination(ds: ValidityDataset) {
  // Per competency, over assessed items with scores, paired with the CORRECTED
  // overall (overall minus this item's weighted contribution — correlating an
  // item against a total that contains it inflates r; weights sum to 1 per
  // binding, so overall_minus = (overall - w*s) / (1 - w)).
  const perCompetency = new Map<string, Array<{ score: number; correctedTotal: number | null }>>();
  for (const row of ds.current) {
    const overall = row.evaluation.overall_score;
    for (const it of row.items) {
      if (it.assessed !== true || typeof it.score !== "number") continue;
      const w = typeof it.weight === "number" ? it.weight : null;
      const correctedTotal =
        overall !== null && w !== null && w < 1
          ? (overall - w * it.score) / (1 - w)
          : null;
      const arr = perCompetency.get(it.competency) ?? [];
      arr.push({ score: it.score, correctedTotal });
      perCompetency.set(it.competency, arr);
    }
  }

  const segments = [...perCompetency.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([competency_key, rows]) => {
      const n = rows.length;
      if (n < MIN_N) {
        return {
          competency_key, n, mean: null, sd: null, cv: null,
          item_total_r: null, insufficient_n: true, flags: [] as string[],
        };
      }
      const scores = rows.map((r) => r.score);
      const m = mean(scores);
      const sd = stdev(scores, m);
      const cv = m !== 0 ? sd / m : null;
      const paired = rows.filter((r): r is { score: number; correctedTotal: number } => r.correctedTotal !== null);
      const itemTotalR = paired.length >= MIN_N
        ? pearsonR(paired.map((r) => r.score), paired.map((r) => r.correctedTotal))
        : null;
      const flags: string[] = [];
      if (sd < BUNCHED_SD) flags.push("bunched");
      if (itemTotalR !== null && itemTotalR < LOW_ITEM_TOTAL_R) flags.push("low_item_total");
      return {
        competency_key, n,
        mean: round4(m), sd: round4(sd), cv: round4(cv),
        item_total_r: round4(itemTotalR),
        insufficient_n: false, flags,
      };
    });

  return { ...envelope(ds), segments };
}

// ── 4.2 Not-assessed rates ───────────────────────────────────────────────────

export function computeNotAssessed(ds: ValidityDataset) {
  // Key: scenario × band × competency. Denominator = scorable current
  // evaluations whose scenario binds the competency (an item row exists);
  // numerator = those with assessed=false.
  const acc = new Map<string, { scenario_id: string; band: string | null; competency_key: string; bound_n: number; not_assessed_n: number }>();
  for (const row of ds.current) {
    const scenarioId = row.evaluation.scenario_id ?? row.session.scenario_id ?? "unknown";
    const band = row.session.difficulty_band;
    for (const it of row.items) {
      const key = `${scenarioId}|${band ?? ""}|${it.competency}`;
      const cur = acc.get(key) ?? {
        scenario_id: scenarioId, band, competency_key: it.competency,
        bound_n: 0, not_assessed_n: 0,
      };
      cur.bound_n += 1;
      if (it.assessed === false) cur.not_assessed_n += 1;
      acc.set(key, cur);
    }
  }
  const rows = [...acc.values()]
    .map((r) => ({
      ...r,
      scenario_slug: ds.scenarioSlugById.get(r.scenario_id) ?? r.scenario_id,
      load_bearing: ds.loadBearingByScenario.get(r.scenario_id)?.get(r.competency_key) ?? true,
      rate: r.bound_n > 0 ? Math.round((r.not_assessed_n / r.bound_n) * 1e4) / 1e4 : 0,
    }))
    .sort((a, b) => b.rate - a.rate || b.bound_n - a.bound_n);
  return { ...envelope(ds), rows };
}

// ── 4.3 Band-stratified distributions ────────────────────────────────────────

const HISTOGRAM_BUCKETS = ["1–1.5", "1.5–2", "2–2.5", "2.5–3", "3–3.5", "3.5–4", "4–4.5", "4.5–5"];

function histogram(scores: number[]): Array<{ bucket: string; count: number }> {
  const counts = new Array<number>(HISTOGRAM_BUCKETS.length).fill(0);
  for (const s of scores) {
    // 1..5 scale → bucket width 0.5; clamp the top edge into the last bucket.
    const idx = Math.min(Math.max(Math.floor((s - 1) / 0.5), 0), HISTOGRAM_BUCKETS.length - 1);
    counts[idx]! += 1;
  }
  return HISTOGRAM_BUCKETS.map((bucket, i) => ({ bucket, count: counts[i]! }));
}

function quantile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  const v = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
  return Math.round(v * 1e4) / 1e4;
}

export function computeDistributions(ds: ValidityDataset) {
  // Band × (competency | "overall"). Band is labeled on every row — the spec
  // forbids cross-band comparison without equating context, so the data never
  // leaves here unlabeled. Sessions with no band are grouped as "unbanded".
  const groups = new Map<string, number[]>();
  for (const row of ds.current) {
    const band = row.session.difficulty_band ?? "unbanded";
    if (typeof row.evaluation.overall_score === "number") {
      const k = `${band}|overall`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(row.evaluation.overall_score);
    }
    for (const it of row.items) {
      if (it.assessed !== true || typeof it.score !== "number") continue;
      const k = `${band}|${it.competency}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(it.score);
    }
  }
  const bands = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, scores]) => {
      const [band, competency_key] = key.split("|") as [string, string];
      const n = scores.length;
      if (n < MIN_N) {
        return { band, competency_key, n, insufficient_n: true, quantiles: null, histogram: [] };
      }
      const sorted = [...scores].sort((a, b) => a - b);
      return {
        band, competency_key, n, insufficient_n: false,
        quantiles: {
          p10: quantile(sorted, 0.1), p25: quantile(sorted, 0.25), p50: quantile(sorted, 0.5),
          p75: quantile(sorted, 0.75), p90: quantile(sorted, 0.9),
        },
        histogram: histogram(scores),
      };
    });
  return { ...envelope(ds), bands };
}

// ── 4.4 Score↔outcome correlation ────────────────────────────────────────────

export async function computeCorrelation(ds: ValidityDataset) {
  // Reuses the existing correlation service (outcomes.ts) — no reimplementation.
  // The paired-N gate is applied HERE, after the service returns, so a
  // coefficient below MIN_PAIRED_N is nulled server-side and can never render.
  // Pairs are restricted to the dataset's current+scorable session set.
  const allowedSessions = new Set(ds.current.map((r) => r.session.id));
  const competencies = [...new Set(
    ds.current.flatMap((r) => r.items.map((i) => i.competency)),
  )].sort();
  const targets: Array<string | null> = [null, ...competencies]; // null = overall

  const caveat = (n: number): string =>
    n < MIN_PAIRED_N
      ? `insufficient N (paired n=${n}, min=${MIN_PAIRED_N}) — no coefficient shown`
      : `paired n=${n}; descriptive only — small pilot samples shift easily, not a stable validity claim yet`;

  const pairs: Array<{
    outcome_type: string; competency_key: string; paired_n: number;
    r: number | null; insufficient_n: boolean; caveat: string;
  }> = [];
  for (const outcomeType of OUTCOME_TYPES) {
    for (const target of targets) {
      const res = await correlateOutcomes(outcomeType as OutcomeType, target);
      const kept = res.pairs.filter((p) => allowedSessions.has(p.session_id));
      const n = kept.length;
      const xs = kept.map((p) => p.outcome_num);
      const ys = kept.map((p) => p.score);
      const r = n >= MIN_PAIRED_N ? round4(pearsonR(xs, ys)) : null;
      pairs.push({
        outcome_type: outcomeType,
        competency_key: target ?? "overall",
        paired_n: n,
        r,
        insufficient_n: n < MIN_PAIRED_N,
        caveat: caveat(n),
      });
    }
  }
  return { ...envelope(ds), pairs };
}

// ── 4.5 Exclusion breakdown ──────────────────────────────────────────────────

export function computeExclusions(ds: ValidityDataset) {
  // The one view over NON-scorable sessions (spec §4 exception). Reads the
  // stored scorability verdicts — never recomputes them.
  const scorable = ds.sessions.filter((s) => s.scorable === true);
  const excluded = ds.sessions.filter((s) => s.scorable === false);
  const byReason = new Map<string, number>();
  for (const s of excluded) {
    const reason = s.exclusion_reason ?? "unknown";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const weekOf = (iso: string): string => {
    const d = new Date(iso);
    const day = (d.getUTCDay() + 6) % 7; // ISO week starts Monday
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  };
  const weeks = new Map<string, { scorable: number; excluded: number }>();
  for (const s of ds.sessions) {
    const w = weekOf(s.created_at);
    const cur = weeks.get(w) ?? { scorable: 0, excluded: 0 };
    if (s.scorable === true) cur.scorable += 1; else cur.excluded += 1;
    weeks.set(w, cur);
  }
  return {
    ...envelope(ds),
    totals: { scorable: scorable.length, excluded: excluded.length },
    by_reason: [...byReason.entries()].map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n),
    over_time: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([week, c]) => ({ week, ...c })),
  };
}

// ── 4.6 Version / drift boundary panel ──────────────────────────────────────

export function computeVersions(ds: ValidityDataset) {
  // Every (4-stamp) combination present in the filtered selection, current AND
  // legacy, each with its N — this panel operationalizes the "never compare
  // across versions" discipline so it isn't something to remember.
  const seg = new Map<string, { stamps: [string, string, string, string]; n: number; legacy: boolean }>();
  const add = (e: EvalRow, legacyFlag: boolean) => {
    const stamps: [string, string, string, string] = [
      String(e.competency_model_version ?? ""),
      String(e.detector_version ?? ""),
      String(e.judge_prompt_version ?? ""),
      String(e.scenario_version ?? ""),
    ];
    const key = stamps.join("|") + (legacyFlag ? "|L" : "");
    const cur = seg.get(key) ?? { stamps, n: 0, legacy: legacyFlag };
    cur.n += 1;
    seg.set(key, cur);
  };
  for (const row of ds.current) add(row.evaluation, false);
  for (const row of ds.legacy) add(row.evaluation, true);

  const segments = [...seg.values()]
    .sort((a, b) => Number(a.legacy) - Number(b.legacy) || b.n - a.n)
    .map((s) => ({
      competency_model_version: s.stamps[0],
      detector_version: s.stamps[1],
      judge_prompt_version: s.stamps[2],
      scenario_version: s.stamps[3],
      n: s.n,
      legacy: s.legacy,
    }));

  const boundary_warning = ds.legacy.length > 0
    ? `selection spans a version boundary: ${ds.legacy.length} evaluation(s) outside the current context (judge v${ds.versionContext.judge_prompt_version}/model v${ds.versionContext.competency_model_version}) are segregated as legacy and excluded from all metric views`
    : null;

  return { ...envelope(ds), segments, boundary_warning };
}
