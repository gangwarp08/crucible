// P4.1 — cohort aggregation for the recruiter dashboard.
//
// One scenario = one cohort: every session routed to that scenario, ranked by
// overall_score, with per-competency scores, scorable/exclusion status,
// difficulty band, AI-Fluency placement, and the informational suspicion
// score. Pure assembly over Supabase reads (service-role, org-scoped at the
// APP layer per P2) — no LLM, no sandbox — so verify-cohort-dashboard.ts can
// exercise it directly without HTTP.
//
// Batch discipline: one sessions query, one evaluations query, one
// evaluation_items query, one session_links query, and ONE events query for
// ALL cohort sessions (filtered like 'integrity.%'), then group in memory.
// Cohorts are pilot-sized (LIMIT below); aggregation in JS is fine.
//
// Aggregates follow the P5.2 principle: mean/stddev are computed over
// SCORABLE sessions with a complete evaluation only — excluded sessions are
// counted, never averaged.

import { supabase } from "./supabase.js";
import { scopeToOrg, type OrgRow } from "./orgs.js";
import { computeSuspicionScore, type SuspicionEventInput } from "./suspicion-score.js";
import {
  AI_FLUENCY_COMPETENCY,
  aiFluencyPlacement,
  type AiFluencyPlacement,
} from "./ai-fluency.js";

const COHORT_SESSION_LIMIT = 500;
// Per-session cap in the single-session suspicion route is 1000; for the
// whole-cohort batch query we bound total rows instead.
const COHORT_INTEGRITY_EVENT_LIMIT = 20_000;

// ── P5.1: sessions.difficulty_band may not exist yet (0020 unapplied) ────────
// Same latch/retry pattern as routes/review.ts: select the column
// optimistically; on the first missing-column error flip the latch and retry
// (and keep running) without it — band renders as null instead of a 500.
let cohortBandColumnMissing = false;

function isMissingBandColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42703" && /difficulty_band/i.test(err.message ?? "");
}

export class CohortError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CohortError";
  }
}

export interface CohortCompetencyCell {
  key: string;
  score: number | null;
  assessed: boolean;
}

export interface CohortRow {
  session_id: string;
  candidate_label: string | null;
  status: string | null;
  end_reason: string | null;
  created_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  difficulty_band: string | null;
  scorable: boolean | null;
  exclusion_reason: string | null;
  defense_outcome: string | null;
  overall_score: number | null;
  evaluation_status: "complete" | "error" | null;
  competencies: CohortCompetencyCell[];
  /** Presentation-only mapping of the ai_orchestration score (ai-fluency.ts). */
  ai_fluency: AiFluencyPlacement | null;
  /** Informational (P1) — never feeds scores. */
  suspicion: { score: number; version: string };
  /** 1-based position among EVALUATED sessions (overall desc); null before
   *  an evaluation exists. */
  rank: number | null;
}

export interface CohortAggregates {
  n: number;
  scorable_count: number;
  excluded_count: number;
  /** Mean/stddev over scorable sessions with a complete evaluation; null when
   *  none exist. stddev is the population form (σ) — cohort = the population. */
  mean: number | null;
  stddev: number | null;
  scored_count: number;
}

export interface Cohort {
  scenario: { id: string; title: string; role: string };
  rows: CohortRow[];
  aggregates: CohortAggregates;
  /** True when the batched integrity-events read hit its row cap — suspicion
   *  scores for late sessions may be computed over a partial event set.
   *  Additive/informational; consumers may ignore it. */
  integrity_events_truncated: boolean;
}

interface SessionRow {
  id: string;
  org_id: string | null;
  status: string | null;
  end_reason: string | null;
  created_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  scorable: boolean | null;
  exclusion_reason: string | null;
  // Absent on a pre-0020 database (see the band-column latch above).
  difficulty_band?: string | null;
  defense_outcome: string | null;
}

const COHORT_SESSION_COLS =
  "id, org_id, status, end_reason, created_at, ended_at, duration_ms, scorable, exclusion_reason, defense_outcome";

/** Build the cohort view for one scenario, scoped to the calling org
 *  (P2: partner sees only its own sessions; admin sees all). Returns null
 *  when the scenario doesn't exist. */
export async function buildCohort(scenarioId: string, org?: OrgRow): Promise<Cohort | null> {
  if (!supabase) throw new CohortError("Supabase service-role client unavailable");

  const { data: scenario, error: scenErr } = await supabase
    .from("scenarios")
    .select("id, title, role")
    .eq("id", scenarioId)
    .maybeSingle();
  if (scenErr) throw new CohortError(`scenario lookup failed: ${scenErr.message}`);
  if (!scenario) return null;

  const readSessions = async (withBand: boolean) => {
    const res = await scopeToOrg(
      supabase!
        .from("sessions")
        .select(withBand ? `${COHORT_SESSION_COLS}, difficulty_band` : COHORT_SESSION_COLS)
        .eq("scenario_id", scenarioId),
      org,
    )
      .order("created_at", { ascending: true })
      .limit(COHORT_SESSION_LIMIT);
    // Dynamic select string defeats supabase-js's literal-type parser — the
    // projection above is what defines the runtime shape.
    return { data: res.data as unknown as SessionRow[] | null, error: res.error };
  };

  let sessRes = await readSessions(!cohortBandColumnMissing);
  if (sessRes.error && !cohortBandColumnMissing && isMissingBandColumn(sessRes.error)) {
    cohortBandColumnMissing = true;
    console.warn(
      "[cohort] sessions.difficulty_band missing (migration 0020 not applied) — building cohort without band",
    );
    sessRes = await readSessions(false);
  }
  if (sessRes.error) throw new CohortError(`cohort sessions read failed: ${sessRes.error.message}`);

  const sessions = sessRes.data ?? [];
  if (sessions.length === 0) {
    return {
      scenario: scenario as Cohort["scenario"],
      rows: [],
      aggregates: { n: 0, scorable_count: 0, excluded_count: 0, mean: null, stddev: null, scored_count: 0 },
      integrity_events_truncated: false,
    };
  }
  const ids = sessions.map((s) => s.id);

  // Batch reads — no dependencies between them.
  const [evalsRes, linksRes, eventsRes] = await Promise.all([
    supabase
      .from("evaluations")
      .select("id, session_id, overall_score, status, created_at")
      .in("session_id", ids)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }),
    supabase
      .from("session_links")
      .select("session_id, candidate_label")
      .in("session_id", ids),
    // ONE integrity query for the whole cohort (spec P4.1) — grouped below.
    // Ordered session_id → seq so that if the row cap bites, whole sessions
    // fall off the end rather than every session losing its tail.
    supabase
      .from("events")
      .select("session_id, seq, type, ts, payload")
      .in("session_id", ids)
      .like("type", "integrity.%")
      .order("session_id", { ascending: true })
      .order("seq", { ascending: true })
      .limit(COHORT_INTEGRITY_EVENT_LIMIT),
  ]);
  for (const res of [evalsRes, linksRes, eventsRes]) {
    if (res.error) throw new CohortError(`cohort child read failed: ${res.error.message}`);
  }

  // Latest evaluation per session — rows arrive newest-first (created_at DESC,
  // id DESC tiebreak, matching review_latest_evaluations semantics).
  interface EvalRow {
    id: string;
    session_id: string;
    overall_score: number | string | null;
    status: string;
  }
  const latestEval = new Map<string, EvalRow>();
  for (const r of (evalsRes.data ?? []) as EvalRow[]) {
    if (!latestEval.has(r.session_id)) latestEval.set(r.session_id, r);
  }

  const labelBySession = new Map<string, string>();
  for (const l of (linksRes.data ?? []) as Array<{ session_id: string | null; candidate_label: string }>) {
    if (l.session_id) labelBySession.set(l.session_id, l.candidate_label);
  }

  // Cap hit ⇒ some sessions' integrity events never arrived; surface that to
  // the response instead of silently under-scoring suspicion.
  const integrityEventsTruncated =
    (eventsRes.data?.length ?? 0) === COHORT_INTEGRITY_EVENT_LIMIT;

  const integrityBySession = new Map<string, SuspicionEventInput[]>();
  for (const e of (eventsRes.data ?? []) as Array<SuspicionEventInput & { session_id: string }>) {
    const list = integrityBySession.get(e.session_id);
    if (list) list.push(e);
    else integrityBySession.set(e.session_id, [e]);
  }

  // Per-competency scores for the latest evaluations only.
  const evalIds = [...latestEval.values()].map((e) => e.id);
  const itemsByEval = new Map<string, CohortCompetencyCell[]>();
  if (evalIds.length > 0) {
    const { data: items, error: itemsErr } = await supabase
      .from("evaluation_items")
      .select("evaluation_id, competency, score, assessed")
      .in("evaluation_id", evalIds)
      .order("competency", { ascending: true });
    if (itemsErr) throw new CohortError(`evaluation_items read failed: ${itemsErr.message}`);
    for (const it of (items ?? []) as Array<{
      evaluation_id: string; competency: string; score: number | string | null; assessed: boolean | null;
    }>) {
      const cell: CohortCompetencyCell = {
        key: it.competency,
        score: it.score === null ? null : Number(it.score),
        assessed: it.assessed !== false && it.score !== null,
      };
      const list = itemsByEval.get(it.evaluation_id);
      if (list) list.push(cell);
      else itemsByEval.set(it.evaluation_id, [cell]);
    }
  }

  const rows: CohortRow[] = sessions.map((s) => {
    const ev = latestEval.get(s.id);
    const cells = ev ? (itemsByEval.get(ev.id) ?? []) : [];
    const overall =
      ev && ev.status === "complete" && ev.overall_score !== null ? Number(ev.overall_score) : null;
    const aiCell = cells.find((c) => c.key === AI_FLUENCY_COMPETENCY);
    const suspicion = computeSuspicionScore(integrityBySession.get(s.id) ?? []);
    return {
      session_id: s.id,
      candidate_label: labelBySession.get(s.id) ?? null,
      status: s.status,
      end_reason: s.end_reason,
      created_at: s.created_at,
      ended_at: s.ended_at,
      duration_ms: s.duration_ms,
      difficulty_band: s.difficulty_band ?? null,
      scorable: s.scorable,
      exclusion_reason: s.exclusion_reason,
      defense_outcome: s.defense_outcome,
      overall_score: overall,
      evaluation_status: ev ? (ev.status as "complete" | "error") : null,
      competencies: cells,
      ai_fluency: aiFluencyPlacement(aiCell?.assessed ? aiCell.score : null),
      suspicion: { score: suspicion.score, version: suspicion.version },
      rank: null, // assigned after sorting
    };
  });

  // Rank by overall desc; unevaluated sessions sink to the bottom (rank null).
  rows.sort((a, b) => {
    const aHas = a.overall_score !== null;
    const bHas = b.overall_score !== null;
    if (aHas && bHas) return b.overall_score! - a.overall_score!;
    if (aHas) return -1;
    if (bHas) return 1;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
  let rank = 0;
  for (const r of rows) {
    if (r.overall_score !== null) r.rank = ++rank;
  }

  // Aggregates — only SCORABLE sessions with a complete evaluation enter the
  // mean/stddev (P5.2 principle: excluded sessions never move the stats).
  const scored = rows.filter((r) => r.scorable === true && r.overall_score !== null);
  const mean =
    scored.length > 0 ? scored.reduce((s, r) => s + r.overall_score!, 0) / scored.length : null;
  const stddev =
    mean !== null
      ? Math.sqrt(scored.reduce((s, r) => s + (r.overall_score! - mean) ** 2, 0) / scored.length)
      : null;

  return {
    scenario: scenario as Cohort["scenario"],
    rows,
    aggregates: {
      n: rows.length,
      scorable_count: rows.filter((r) => r.scorable === true).length,
      excluded_count: rows.filter((r) => r.scorable === false).length,
      mean: mean !== null ? Math.round(mean * 100) / 100 : null,
      stddev: stddev !== null ? Math.round(stddev * 100) / 100 : null,
      scored_count: scored.length,
    },
    integrity_events_truncated: integrityEventsTruncated,
  };
}
