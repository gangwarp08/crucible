// L6 outcome capture (Slice 5.5).
//
// Owns the outcome data model at the boundary: the Zod schema partners/CSV must
// satisfy, the service-role insert (with scenario backfill from the session),
// and the correlation query that joins outcomes → sessions → evaluations so we
// can ask "does the assessment score predict the real-world outcome?".
//
// outcome_value is stored as { value: <bool|number> } so one JSONB column fits
// every outcome type. The numeric projection (bool→1/0) is what correlation
// uses. Org/tenant scoping lands in Slice 5.7; here every read/write is
// service-role only (CLAUDE.md Hard Rule §2).

import { z } from "zod";
import { supabase } from "./supabase.js";

export class OutcomesError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "OutcomesError";
  }
}

// Minimum viable outcome set (asaya plan Q3). Validated here at the boundary
// rather than via a DB CHECK so it can grow without a migration.
export const OUTCOME_TYPES = [
  "hired",
  "ramp_weeks",
  "manager_rating_90d",
  "retained_90d",
] as const;
export type OutcomeType = (typeof OUTCOME_TYPES)[number];

export type OutcomeSource = "csv" | "webhook" | "manual" | "partner_form";

// Per-type value validation. `value` is supplied flat by the caller and stored
// as { value } in outcome_value.
export const OutcomeInputSchema = z
  .object({
    candidate_ref: z.string().min(1).max(200),
    session_id: z.string().uuid().nullish(),
    scenario_id: z.string().uuid().nullish(),
    outcome_type: z.enum(OUTCOME_TYPES),
    value: z.union([z.boolean(), z.number()]),
    captured_at: z.string().datetime().optional(),
  })
  .superRefine((d, ctx) => {
    const boolTypes: OutcomeType[] = ["hired", "retained_90d"];
    if (boolTypes.includes(d.outcome_type) && typeof d.value !== "boolean") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: `${d.outcome_type} requires a boolean value` });
    }
    if (d.outcome_type === "ramp_weeks") {
      if (typeof d.value !== "number" || !Number.isFinite(d.value) || d.value < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "ramp_weeks requires a non-negative number" });
      }
    }
    if (d.outcome_type === "manager_rating_90d") {
      if (typeof d.value !== "number" || !Number.isInteger(d.value) || d.value < 1 || d.value > 5) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "manager_rating_90d requires an integer 1-5" });
      }
    }
  });

export type OutcomeInput = z.infer<typeof OutcomeInputSchema>;

export interface OutcomeRow {
  id: string;
  candidate_ref: string;
  session_id: string | null;
  scenario_id: string | null;
  outcome_type: string;
  outcome_value: { value: boolean | number };
  source: string;
  captured_at: string;
}

/** Project an outcome value onto a number for correlation: bool→1/0, num→num. */
export function numericOutcomeValue(value: boolean | number): number {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

/** Insert one validated outcome. When session_id is given but scenario_id is
 *  not, backfill scenario_id from the session so the row is self-describing. */
export async function insertOutcome(input: OutcomeInput, source: OutcomeSource): Promise<OutcomeRow> {
  if (!supabase) throw new OutcomesError("Supabase service-role client unavailable");

  let scenarioId = input.scenario_id ?? null;
  if (input.session_id && !scenarioId) {
    const { data: sess, error } = await supabase
      .from("sessions")
      .select("scenario_id")
      .eq("id", input.session_id)
      .maybeSingle();
    if (error) throw new OutcomesError(`session lookup failed: ${error.message}`);
    if (!sess) throw new OutcomesError(`session ${input.session_id} not found`);
    scenarioId = (sess as { scenario_id: string | null }).scenario_id;
  }

  const row = {
    candidate_ref: input.candidate_ref,
    session_id: input.session_id ?? null,
    scenario_id: scenarioId,
    outcome_type: input.outcome_type,
    outcome_value: { value: input.value },
    source,
    ...(input.captured_at ? { captured_at: input.captured_at } : {}),
  };

  const inserted = await supabase.from("outcomes").insert(row).select().single();
  if (inserted.error) throw new OutcomesError(`outcome insert failed: ${inserted.error.message}`);
  return inserted.data as unknown as OutcomeRow;
}

// ─── Per-session read (recruiter review) ─────────────────────────────────────

export interface SessionOutcome {
  outcome_type: string;
  value: boolean | number | null;
  source: string;
  captured_at: string;
}

/** All captured outcomes for one session, newest first — powers the review
 *  page's "real-world outcome" view next to the assessment score. */
export async function listSessionOutcomes(sessionId: string): Promise<SessionOutcome[]> {
  if (!supabase) throw new OutcomesError("Supabase service-role client unavailable");
  const { data, error } = await supabase
    .from("outcomes")
    .select("outcome_type, outcome_value, source, captured_at")
    .eq("session_id", sessionId)
    .order("captured_at", { ascending: false });
  if (error) throw new OutcomesError(`session outcomes read failed: ${error.message}`);
  return ((data ?? []) as Array<{
    outcome_type: string;
    outcome_value: { value: boolean | number } | null;
    source: string;
    captured_at: string;
  }>).map((r) => ({
    outcome_type: r.outcome_type,
    value: r.outcome_value?.value ?? null,
    source: r.source,
    captured_at: r.captured_at,
  }));
}

// ─── Correlation ─────────────────────────────────────────────────────────────

export interface CorrelationPair {
  session_id: string;
  candidate_ref: string;
  outcome_num: number;       // numeric projection of the outcome value
  score: number;             // overall_score, or the competency item score
}

export interface CorrelationResult {
  outcome_type: string;
  competency: string | null; // null → correlated against overall_score
  n: number;
  pearson_r: number | null;  // null when n < 2 or zero variance
  pairs: CorrelationPair[];
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null; // no variance → correlation undefined
  return Math.round((cov / Math.sqrt(vx * vy)) * 1e4) / 1e4;
}

/**
 * Correlate a given outcome_type against assessment scores across all linked,
 * completed sessions. competency=null → overall_score; otherwise the per-item
 * score for that competency. Runs end-to-end against stored data.
 */
export async function correlateOutcomes(
  outcomeType: OutcomeType,
  competency: string | null = null,
): Promise<CorrelationResult> {
  if (!supabase) throw new OutcomesError("Supabase service-role client unavailable");

  const { data: outcomeRows, error: oErr } = await supabase
    .from("outcomes")
    .select("session_id, candidate_ref, outcome_value")
    .eq("outcome_type", outcomeType)
    .not("session_id", "is", null);
  if (oErr) throw new OutcomesError(`outcomes read failed: ${oErr.message}`);

  const outcomes = (outcomeRows ?? []) as Array<{
    session_id: string;
    candidate_ref: string;
    outcome_value: { value: boolean | number } | null;
  }>;
  const sessionIds = [...new Set(outcomes.map((o) => o.session_id))];
  if (sessionIds.length === 0) {
    return { outcome_type: outcomeType, competency, n: 0, pearson_r: null, pairs: [] };
  }

  // Completed evaluations for those sessions → overall_score per session.
  const { data: evalRows, error: eErr } = await supabase
    .from("evaluations")
    .select("id, session_id, overall_score, status")
    .in("session_id", sessionIds)
    .eq("status", "complete");
  if (eErr) throw new OutcomesError(`evaluations read failed: ${eErr.message}`);
  const evals = (evalRows ?? []) as Array<{
    id: string; session_id: string; overall_score: number | string;
  }>;
  const evalBySession = new Map(evals.map((e) => [e.session_id, e]));

  // When correlating a specific competency, pull its item score per evaluation.
  let itemScoreByEval = new Map<string, number>();
  if (competency) {
    const evalIds = evals.map((e) => e.id);
    if (evalIds.length > 0) {
      const { data: itemRows, error: iErr } = await supabase
        .from("evaluation_items")
        .select("evaluation_id, competency, score")
        .in("evaluation_id", evalIds)
        .eq("competency", competency);
      if (iErr) throw new OutcomesError(`evaluation_items read failed: ${iErr.message}`);
      itemScoreByEval = new Map(
        ((itemRows ?? []) as Array<{ evaluation_id: string; score: number }>).map((r) => [r.evaluation_id, Number(r.score)]),
      );
    }
  }

  const pairs: CorrelationPair[] = [];
  for (const o of outcomes) {
    const ev = evalBySession.get(o.session_id);
    if (!ev) continue;
    const score = competency
      ? itemScoreByEval.get(ev.id)
      : Number(ev.overall_score);
    if (score === undefined || !Number.isFinite(score)) continue;
    if (!o.outcome_value || o.outcome_value.value === undefined) continue;
    pairs.push({
      session_id: o.session_id,
      candidate_ref: o.candidate_ref,
      outcome_num: numericOutcomeValue(o.outcome_value.value),
      score,
    });
  }

  const r = pearson(pairs.map((p) => p.outcome_num), pairs.map((p) => p.score));
  return { outcome_type: outcomeType, competency, n: pairs.length, pearson_r: r, pairs };
}
