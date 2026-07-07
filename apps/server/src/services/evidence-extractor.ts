// L5 Stage A — deterministic evidence extraction (Slice 5.2).
//
// Reads a completed session's append-only event stream + the scenario's
// ground_truth.json and emits typed EVIDENCE UNITS: small, deterministic facts
// each tied to a competency and the exact event_seqs that produced it. No LLM
// here — these features repeat exactly across runs, which is what makes the
// downstream judge (Stage B, Slice 5.3) reliable and auditable.
//
// Reads strictly from durable storage (Supabase + filesystem), mirroring
// analysis-input — so it works post-session and on historical sessions.
//
// Detectors come in two tiers: scenario-AGNOSTIC (query/deliverable/AI/message
// shape — run for any scenario) and fde-db-triage-SPECIFIC (dedup correctness,
// status filter, corrected-figure match — keyed off the scenario slug). Adding
// a scenario means adding a detector block, not touching the agnostic core.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "./supabase.js";

// Bump when detector logic changes so re-scoring/drift can tell versions apart.
// v2 (7.2): product-sense fork detectors (ps_fork_user_protected /
// _shortcut_taken / _reasoning_present) feeding design_under_constraints.
// v3 (P3.2): family-2 detectors (fde-api-integration domain signals + that
// family's native ps_fork_* detectors). INERT on family 1: every new detector
// is gated on slug.startsWith("fde-api-integration"), so re-scoring any
// fde-db-triage* session emits units identical to v2 modulo this stamp
// (asserted by scripts/verify-family1-drift-inert.ts).
export const DETECTOR_VERSION = "3";

// DISSOCIABILITY GUARD (7.2 + P3.2): the product-sense fork measures Product
// Sense ONLY — in the shared competency model that construct lives on
// design_under_constraints. Every ps_fork_* unit in EVERY family MUST bind to
// this key and NEVER to "teamwork" (Teamwork stays a separate session-wide
// signal). Enforced by verify-ps-fork-units.ts (family 1) and
// verify-family2-units.ts (family 2).
export const PS_FORK_COMPETENCY = "design_under_constraints";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");

export interface EvidenceUnit {
  competency_key: string;
  kind: string;
  /** boolean | number | structured — interpreted by Stage B. */
  value: unknown;
  /** Detector importance/confidence (0..1); refined in Slice 5.3. */
  weight: number;
  event_seqs: number[];
  detector_version: string;
}

export class EvidenceExtractorError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "EvidenceExtractorError";
  }
}

export interface EventRow {
  seq: number;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
}

interface QueryEvent {
  seq: number;
  sql: string;
  status: string;
  row_count: number | undefined;
  error: string | undefined;
}

// ─── Durable read ────────────────────────────────────────────────────────────

interface SessionContext {
  slug: string;
  datasetRef: string | null;
  events: EventRow[];
  groundTruth: Record<string, unknown>;
}

async function loadContext(sessionId: string): Promise<SessionContext> {
  if (!supabase) {
    throw new EvidenceExtractorError("Supabase client unavailable; cannot extract evidence");
  }

  const { data: sessRow, error: sessErr } = await supabase
    .from("sessions")
    .select("scenario_id")
    .eq("id", sessionId)
    .single();
  if (sessErr || !sessRow) {
    throw new EvidenceExtractorError(`session read failed: ${sessErr?.message}`);
  }
  const scenarioId = (sessRow as { scenario_id: string | null }).scenario_id;
  if (!scenarioId) {
    throw new EvidenceExtractorError(`session ${sessionId} has no scenario_id`);
  }

  const { data: scenRow, error: scenErr } = await supabase
    .from("scenarios")
    .select("slug, dataset_ref")
    .eq("id", scenarioId)
    .single();
  if (scenErr || !scenRow) {
    throw new EvidenceExtractorError(`scenario read failed: ${scenErr?.message}`);
  }
  const { slug, dataset_ref: datasetRef } = scenRow as { slug: string; dataset_ref: string | null };

  const { data: eventsRaw, error: evErr } = await supabase
    .from("events")
    .select("seq, type, actor, payload")
    .eq("session_id", sessionId)
    .order("seq", { ascending: true });
  if (evErr) {
    throw new EvidenceExtractorError(`events read failed: ${evErr.message}`);
  }
  const events = (eventsRaw ?? []) as unknown as EventRow[];

  let groundTruth: Record<string, unknown> = {};
  if (datasetRef) {
    try {
      groundTruth = JSON.parse(
        readFileSync(resolve(REPO_ROOT, datasetRef, "ground_truth.json"), "utf8"),
      ) as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `[evidence-extractor] no ground_truth.json for dataset_ref=${datasetRef}:`,
        (err as Error).message,
      );
    }
  }

  return { slug, datasetRef, events, groundTruth };
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function unit(
  competency_key: string,
  kind: string,
  value: unknown,
  event_seqs: number[],
  weight = 1,
): EvidenceUnit {
  return { competency_key, kind, value, weight, event_seqs, detector_version: DETECTOR_VERSION };
}

function asQueries(events: EventRow[]): QueryEvent[] {
  return events
    .filter((e) => e.type === "db.query")
    .map((e) => ({
      seq: e.seq,
      sql: typeof e.payload.sql === "string" ? e.payload.sql : "",
      status: typeof e.payload.status === "string" ? e.payload.status : "error",
      row_count: typeof e.payload.row_count === "number" ? e.payload.row_count : undefined,
      error: typeof e.payload.error === "string" ? e.payload.error : undefined,
    }));
}

/** Extract candidate dollar amounts from free text (handles $, commas, M/K). */
function parseDollarAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /\$?\s*([\d][\d,]*\.?\d*)\s*(m(?:illion)?|k)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const suf = (m[2] ?? "").toLowerCase();
    out.push(suf.startsWith("m") ? n * 1e6 : suf === "k" ? n * 1e3 : n);
  }
  return out;
}

// ─── Detectors ───────────────────────────────────────────────────────────────

/** Scenario-agnostic — run for every scenario. */
function agnosticDetectors(events: EventRow[]): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  const queries = asQueries(events);
  const ok = queries.filter((q) => q.status === "ok");
  const errs = queries.filter((q) => q.status !== "ok");
  const firstQuerySeq = queries.length ? queries[0]!.seq : null;

  const drafts = events.filter((e) => e.type === "deliverable.draft");
  const submits = events.filter((e) => e.type === "deliverable.submit");
  const lastDeliverable = [...submits, ...drafts].sort((a, b) => b.seq - a.seq)[0] ?? null;
  const aiTurns = events.filter((e) => e.type === "ai.assistant.candidate");
  const aiResponses = events.filter((e) => e.type === "ai.assistant.response");
  const clientMsgs = events.filter((e) => e.type === "message.client.candidate");
  const teamMsgs = events.filter((e) => e.type === "message.team.candidate");

  // data_fluency — query hygiene
  units.push(unit("data_fluency", "query_error_count",
    { errors: errs.length, total: queries.length },
    errs.map((q) => q.seq)));

  // execution — deliverable presence + completeness
  const delivData = (lastDeliverable?.payload.data ?? null) as Record<string, unknown> | null;
  units.push(unit("execution", "deliverable_present", lastDeliverable !== null,
    lastDeliverable ? [lastDeliverable.seq] : []));
  if (delivData) {
    const requiredFields = [
      "corrected_monthly_revenue", "root_cause_finding",
      "client_facing_summary", "decisions_and_tradeoffs",
    ];
    const missing = requiredFields.filter((f) => {
      const v = delivData[f];
      return typeof v !== "string" || v.trim() === "";
    });
    units.push(unit("execution", "required_fields_present",
      { complete: missing.length === 0, missing },
      lastDeliverable ? [lastDeliverable.seq] : []));
  }

  // execution — iterated after a failed query (error then a later success)
  const firstErr = errs[0];
  const recovered = firstErr ? ok.find((q) => q.seq > firstErr.seq) : undefined;
  units.push(unit("execution", "iterated_after_failure", recovered !== undefined,
    firstErr && recovered ? [firstErr.seq, recovered.seq] : []));

  // execution — verified after drafting (a successful query after the first draft)
  const firstDraftSeq = drafts.length ? drafts[0]!.seq : null;
  const verifyQuery = firstDraftSeq !== null ? ok.find((q) => q.seq > firstDraftSeq) : undefined;
  units.push(unit("execution", "verified_before_submit", verifyQuery !== undefined,
    firstDraftSeq !== null && verifyQuery ? [firstDraftSeq, verifyQuery.seq] : []));

  // design_under_constraints — wasteful SELECT * scans
  const selectStar = ok.filter((q) => /select\s+\*/i.test(q.sql));
  units.push(unit("design_under_constraints", "wasteful_select_star_count",
    selectStar.length, selectStar.map((q) => q.seq)));

  // ai_orchestration — usage volume
  const aiTokens = aiResponses.reduce(
    (s, e) => s + (typeof e.payload.total_tokens === "number" ? e.payload.total_tokens : 0), 0);
  units.push(unit("ai_orchestration", "ai_turn_count", aiTurns.length, aiTurns.map((e) => e.seq)));
  units.push(unit("ai_orchestration", "ai_token_spend", aiTokens, aiResponses.map((e) => e.seq)));

  // problem_framing — asked the client before querying
  const clarifier = firstQuerySeq !== null
    ? clientMsgs.find((e) => e.seq < firstQuerySeq)
    : clientMsgs[0];
  units.push(unit("problem_framing", "clarifier_before_first_query", clarifier !== undefined,
    clarifier ? [clarifier.seq] : []));

  // customer_engagement / teamwork — channel engagement counts
  units.push(unit("customer_engagement", "client_update_count", clientMsgs.length,
    clientMsgs.map((e) => e.seq)));
  units.push(unit("teamwork", "team_engaged_count", teamMsgs.length, teamMsgs.map((e) => e.seq)));

  return units;
}

// A candidate defense is WEAK when it's missing, trivially short, or a refusal/
// deflection ("I don't know", "the AI did it"). Deterministic so strong vs weak
// runs separate reliably; Stage B still reads the raw transcript for nuance.
const MIN_DEFENSE_CHARS = 25;
const DEFENSE_REFUSAL_RE =
  /\b(i don'?t know|not sure|no idea|dunno|can'?t recall|don'?t remember|the (ai|assistant|copilot) (did|wrote|made)|not certain|unsure|i guess|no clue)\b/i;

function isWeakDefense(answer: string | undefined): boolean {
  if (answer === undefined) return true;            // unanswered
  const t = answer.trim();
  if (t.length < MIN_DEFENSE_CHARS) return true;    // trivially short
  return DEFENSE_REFUSAL_RE.test(t);                // refusal / deflection
}

/** Scenario-agnostic L4 verification (Slice 5.4b). Emits units ONLY when a
 *  verification exchange actually fired — so non-verified sessions keep their
 *  exact prior unit set. Pairs each verifier prompt with its answer by index;
 *  a deliverable the candidate cannot defend surfaces as defense_weak=true on
 *  the competency that decision mapped to (plus an overall engagement unit). */
function verificationDetectors(events: EventRow[]): EvidenceUnit[] {
  const prompts = events.filter((e) => e.type === "verification.prompt");
  if (prompts.length === 0) return [];

  const responses = events.filter((e) => e.type === "verification.response");
  const units: EvidenceUnit[] = [];

  // index → { competency_key, seqs, answer? }
  const byIndex = new Map<number, { competency: string; seqs: number[]; answer?: string }>();
  for (const e of prompts) {
    const p = e.payload ?? {};
    const idx = typeof p["index"] === "number" ? p["index"] : byIndex.size;
    const competency = typeof p["competency_key"] === "string" ? p["competency_key"] : "execution";
    byIndex.set(idx, { competency, seqs: [e.seq] });
  }
  for (const e of responses) {
    const p = e.payload ?? {};
    const idx = typeof p["index"] === "number" ? p["index"] : -1;
    const slot = byIndex.get(idx);
    if (!slot) continue;
    slot.answer = typeof p["text"] === "string" ? p["text"] : "";
    slot.seqs.push(e.seq);
  }

  // Per-competency weak/strong aggregation.
  const perCompetency = new Map<string, { weak: number; total: number; seqs: number[] }>();
  let weakCount = 0;
  for (const slot of byIndex.values()) {
    const weak = isWeakDefense(slot.answer);
    if (weak) weakCount += 1;
    const agg = perCompetency.get(slot.competency) ?? { weak: 0, total: 0, seqs: [] };
    agg.total += 1;
    if (weak) agg.weak += 1;
    agg.seqs.push(...slot.seqs);
    perCompetency.set(slot.competency, agg);
  }

  const allSeqs = [...prompts, ...responses].map((e) => e.seq).sort((a, b) => a - b);
  units.push(unit("execution", "verification_engaged",
    { prompted: true, questions: prompts.length, answered: responses.length, weak_count: weakCount },
    allSeqs));

  for (const [competency, agg] of perCompetency) {
    units.push(unit(competency, "defense_weak",
      { weak: agg.weak > 0, n_weak: agg.weak, n_total: agg.total },
      agg.seqs));
  }

  return units;
}

/** fde-db-triage family — duplicate/status/figure correctness vs ground truth. */
function fdeDbTriageDetectors(events: EventRow[], gt: Record<string, unknown>): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  const ok = asQueries(events).filter((q) => q.status === "ok");

  // data_fluency — dedup by external_payment_id present
  const dedupRe =
    /(\bmin\s*\(\s*id\s*\)|\bdistinct\b|row_number\s*\(|group\s+by[^;]*external_payment_id)/i;
  const dedupQueries = ok.filter((q) => /external_payment_id/i.test(q.sql) && dedupRe.test(q.sql));
  units.push(unit("data_fluency", "dedup_correct", dedupQueries.length > 0,
    dedupQueries.map((q) => q.seq)));

  // data_fluency — revenue computed WITHOUT a status='succeeded' filter
  const revenueQueries = ok.filter((q) => /sum\s*\(\s*amount_cents\s*\)/i.test(q.sql));
  const statusFilterRe = /status\s*=\s*['"]succeeded['"]/i;
  const anyFiltered = revenueQueries.some((q) => statusFilterRe.test(q.sql));
  units.push(unit("data_fluency", "status_filter_missing",
    revenueQueries.length > 0 && !anyFiltered,
    revenueQueries.map((q) => q.seq)));

  // execution — corrected figure in the deliverable matches ground truth (±2%)
  const corrected = gt.corrected_monthly_cents as Record<string, number> | undefined;
  const submits = events.filter((e) => e.type === "deliverable.submit");
  const lastSubmit = submits.sort((a, b) => b.seq - a.seq)[0] ?? null;
  if (corrected && lastSubmit) {
    const monthDollars = Object.values(corrected).map((c) => c / 100);
    const totalDollars = monthDollars.reduce((s, c) => s + c, 0);
    const data = (lastSubmit.payload.data ?? {}) as Record<string, unknown>;
    const text = typeof data.corrected_monthly_revenue === "string"
      ? data.corrected_monthly_revenue : "";
    const amounts = parseDollarAmounts(text);
    // Relative distance from a target, trying both a dollars and cents reading
    // of each parsed number (candidates report either $3.9M or 394203852 cents).
    const bestRelTo = (target: number): number => {
      let best = Number.POSITIVE_INFINITY;
      for (const a of amounts) {
        for (const cand of [a, a / 100]) {
          const rel = Math.abs(cand - target) / target;
          if (rel < best) best = rel;
        }
      }
      return best;
    };
    const totalRel = bestRelTo(totalDollars);
    // How many of the corrected monthly figures appear (±2%) in the text — a
    // candidate who reported correct per-month figures got it right even if
    // they never wrote the total.
    const monthMatches = monthDollars.filter((m) => bestRelTo(m) <= 0.02).length;
    const matched = totalRel <= 0.02 || monthMatches >= 2;
    units.push(unit("execution", "figures_match_truth",
      { matched,
        best_rel_delta: Number.isFinite(totalRel) ? Math.round(totalRel * 1e4) / 1e4 : null,
        month_matches: monthMatches,
        corrected_total_dollars: Math.round(totalDollars * 100) / 100 },
      [lastSubmit.seq]));
  }

  return units;
}

/** Product-Sense fork (7.2) — the design_under_constraints judgment when Sam
 *  pitches the ship-the-raw-number shortcut. Fires ONLY when the fork was
 *  actually presented (curveball.fired for shortcut_suggestion). Feeds
 *  design_under_constraints ONLY — never teamwork (dissociability). The
 *  deliverable outcome (protected vs shortcut) is the PRIMARY evidence; the
 *  team-channel reasoning is corroborating, never sole. */
function psForkDetectors(events: EventRow[], gt: Record<string, unknown>): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  const forkFired = events.filter(
    (e) =>
      e.type === "curveball.fired" &&
      (e.payload as Record<string, unknown> | undefined)?.["curveball_id"] === "shortcut_suggestion",
  );
  if (forkFired.length === 0) return units; // fork never presented → nothing to measure
  const forkSeq = forkFired[0]!.seq;

  const naive = gt.naive_monthly_cents as Record<string, number> | undefined;
  const corrected = gt.corrected_monthly_cents as Record<string, number> | undefined;
  const submits = events.filter((e) => e.type === "deliverable.submit");
  const lastSubmit = submits.sort((a, b) => b.seq - a.seq)[0] ?? null;

  if (naive && corrected && lastSubmit) {
    const data = (lastSubmit.payload.data ?? {}) as Record<string, unknown>;
    const text = typeof data.corrected_monthly_revenue === "string" ? data.corrected_monthly_revenue : "";
    const amounts = parseDollarAmounts(text);
    const matchesCents = (cents: number): boolean => {
      const target = cents / 100;
      for (const a of amounts) for (const cand of [a, a / 100]) {
        if (Math.abs(cand - target) / target <= 0.02) return true;
      }
      return false;
    };
    // Bug months = any month where naive differs from corrected (derived, so the
    // detector works for the isomorph's own figures too). Non-bug months are
    // identical in both, so they can't distinguish the shortcut from the
    // reconciled figure. Require ALL bug months to match a set before
    // attributing the choice — the naive and reconciled per-month figures are
    // close enough (~1.4% between one naive month and an adjacent reconciled
    // month) that a single-month match would misattribute.
    const bugMonths = Object.keys(corrected).filter((m) => naive[m] !== undefined && naive[m] !== corrected[m]);
    const naiveHits = bugMonths.filter((m) => matchesCents(naive[m]!)).length;
    const corrHits = bugMonths.filter((m) => matchesCents(corrected[m]!)).length;
    const userProtected = bugMonths.length > 0 && corrHits === bugMonths.length; // reconciled figure shipped
    const shortcutTaken =
      bugMonths.length > 0 && naiveHits === bugMonths.length && corrHits < bugMonths.length; // overstated figure shipped
    units.push(unit("design_under_constraints", "ps_fork_user_protected",
      { protected: userProtected, corrected_month_hits: corrHits }, [forkSeq, lastSubmit.seq]));
    units.push(unit("design_under_constraints", "ps_fork_shortcut_taken",
      { taken: shortcutTaken, naive_month_hits: naiveHits }, [forkSeq, lastSubmit.seq]));
  }

  // Corroborating: candidate articulated user/business-impact reasoning on the
  // team channel AFTER the fork was raised (supports, never sole evidence).
  const reasoningRe =
    /(accura|misleading|overstat|inflat|wrong|incorrect|correctness|reconcil|dedup|duplicat|board|trust|integrity|right number|real number|off by|actual|double.?count|can'?t (just )?ship)/i;
  const reasoningMsgs = events.filter(
    (e) =>
      e.type === "message.team.candidate" &&
      e.seq > forkSeq &&
      reasoningRe.test(String((e.payload as Record<string, unknown> | undefined)?.["text"] ?? "")),
  );
  units.push(unit("design_under_constraints", "ps_fork_reasoning_present",
    reasoningMsgs.length > 0, reasoningMsgs.map((e) => e.seq)));

  return units;
}

// ─── Family 2: fde-api-integration (P3.2 — DORMANT until family activation) ──
//
// The second scenario family: the candidate debugs a failing third-party API
// integration (expired/misused auth, missing pagination, absent retry/
// idempotency handling, upstream contract drift). These detectors are gated in
// runDetectors on slug.startsWith("fde-api-integration") and therefore NEVER
// fire on family-1 (fde-db-triage*) sessions — that inertness is the v3 drift
// boundary asserted by verify-family1-drift-inert.ts.

/** Candidate-authored text, one entry per event, for domain-signal scanning:
 *  SQL (log-table investigation), team/client messages, AI-assistant prompts,
 *  deliverable draft/submit string fields, and decoded terminal input. */
function candidateTextCorpus(events: EventRow[]): Array<{ seq: number; text: string }> {
  const out: Array<{ seq: number; text: string }> = [];
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.type) {
      case "db.query":
        if (typeof p.sql === "string") out.push({ seq: e.seq, text: p.sql });
        break;
      case "message.team.candidate":
      case "message.client.candidate":
      case "ai.assistant.candidate":
        if (typeof p.text === "string") out.push({ seq: e.seq, text: p.text });
        break;
      case "deliverable.draft":
      case "deliverable.submit": {
        const data = (p.data ?? {}) as Record<string, unknown>;
        const text = Object.values(data).filter((v): v is string => typeof v === "string").join("\n");
        if (text) out.push({ seq: e.seq, text });
        break;
      }
      case "pty.input": {
        // Terminal keystrokes arrive base64-encoded; decode for word-level scanning.
        if (typeof p.data === "string") {
          try { out.push({ seq: e.seq, text: Buffer.from(p.data, "base64").toString("utf8") }); }
          catch { /* not base64 — skip */ }
        }
        break;
      }
    }
  }
  return out;
}

// Domain-signal patterns. Presence-tier evidence: Stage B grades quality; these
// establish deterministically WHERE (event_seqs) the candidate engaged each
// failure mode of the integration.
const API_AUTH_RE =
  /(401|403|unauthorized|forbidden|(expired|stale|invalid|rotat\w*) [\w-]*\s?(token|key|credential)|token (expired|refresh)|refresh(ed|ing)? the (access )?token|api[\s_-]?key|bearer|authorization header|oauth|hmac|signature)/i;
const API_PAGINATION_RE =
  /(paginat|next[\s_-]?page|page[\s_-]?token|cursor|has_more|per_page|page_size|\bpage=|\boffset=|\blimit=|all (the )?pages|first page only)/i;
const API_RETRY_RE =
  /(retr(y|ies|ied|ying)|backoff|exponential|idempoten|rate[\s_-]?limit|429|timeout|circuit[\s_-]?breaker|dedup\w* (the )?(request|webhook|event)s?|at[\s_-]?least[\s_-]?once|exactly[\s_-]?once)/i;
const API_CONTRACT_DRIFT_RE =
  /((schema|contract|payload|response|field|format|shape) (chang|drift|renam|remov|differ|mismatch)|breaking change|api version|\/v\d+\/|deprecat|(renamed|removed|missing|moved) (a |the )?field|snake_?case|camel_?case)/i;

/** fde-api-integration family — domain signals over the candidate corpus.
 *  Competency mapping stays inside the shared 8-competency model (Hard Rule of
 *  P3: no new competencies): auth fix → execution; pagination completeness →
 *  data_fluency (the family's "missing rows" analog of family 1's dedup);
 *  retry/idempotency robustness → design_under_constraints (a design decision,
 *  NOT a ps_fork_* unit); contract-drift diagnosis → data_fluency (root-cause
 *  from data evidence, the analog of family 1's status_filter/dedup units). */
function fdeApiIntegrationDetectors(events: EventRow[]): EvidenceUnit[] {
  const corpus = candidateTextCorpus(events);
  const scan = (re: RegExp): { hits: number; seqs: number[] } => {
    const seqs = corpus.filter((c) => re.test(c.text)).map((c) => c.seq);
    return { hits: seqs.length, seqs };
  };

  const auth = scan(API_AUTH_RE);
  const pagination = scan(API_PAGINATION_RE);
  const retry = scan(API_RETRY_RE);
  const drift = scan(API_CONTRACT_DRIFT_RE);

  return [
    unit("execution", "api_auth_fix_evidence",
      { present: auth.hits > 0, hits: auth.hits }, auth.seqs),
    unit("data_fluency", "api_pagination_handled",
      { present: pagination.hits > 0, hits: pagination.hits }, pagination.seqs),
    unit("design_under_constraints", "api_retry_idempotency_handled",
      { present: retry.hits > 0, hits: retry.hits }, retry.seqs),
    unit("data_fluency", "api_contract_drift_diagnosed",
      { present: drift.hits > 0, hits: drift.hits }, drift.seqs),
  ];
}

// ── Family-2 product-sense fork ──────────────────────────────────────────────
//
// The teammate proposes HARDCODING a workaround (pin the expected value /
// special-case the failing account) that ships faster but silently breaks
// edge-case users. Accept vs reject must be observable in the DELIVERABLE
// (Stage-A primary evidence); team-channel reasoning corroborates, never sole.
//
// CONTRACT with the family-2 content (migration 0023 / encode scripts):
//   - curveball id "hardcode_workaround" (override: ground_truth.ps_fork.curveball_id)
//   - ground_truth.ps_fork may override the marker patterns below via
//     shortcut_markers / robust_markers (arrays of regex sources) so isomorphs
//     with different domain skins keep detection deterministic.

const PS_FORK2_DEFAULT_CURVEBALL_ID = "hardcode_workaround";
// Evidence the deliverable ships the hardcoded/special-cased workaround.
const PS_FORK2_SHORTCUT_MARKERS = [
  "hard[\\s-]?cod", "special[\\s-]?cas", "stub(bed)?\\s+(out\\s+)?(the\\s+)?(response|value|call)",
  "pin(ned)?\\s+(the\\s+)?(value|response|version)", "workaround", "temporary fix", "band[\\s-]?aid",
];
// Evidence the deliverable ships the robust fix (root cause addressed for all users).
const PS_FORK2_ROBUST_MARKERS = [
  "paginat", "cursor", "next[\\s_-]?page", "token refresh", "refresh(ed|ing|es)?\\s+the\\s+(access\\s+)?token",
  "retr(y|ies)", "backoff", "idempoten", "schema (chang|drift)", "contract (chang|drift)",
  "root cause", "all (users|customers|accounts|pages)", "edge[\\s-]?case",
];
// A shortcut marker preceded (within a short window) by negation is a REJECTION
// of the shortcut, not an acceptance — "we did not hardcode it" must not read
// as taking the shortcut. Family 1 dodged this with numeric figures; the text
// analog needs the negation window.
const PS_FORK2_NEGATION_RE =
  /(\bno\b|\bnot\b|n['’]t|never|avoid\w*|instead of|rather than|reject\w*|declin\w*|refus\w*|without|against)\s*(\S+\s+){0,4}$/i;
// Corroborating user/business-impact reasoning on the team channel.
const PS_FORK2_REASONING_RE =
  /(edge[\s-]?case|breaks?\s+(for|other|when)|silent(ly)?\s+(fail|drop|break)|wrong (data|results?|numbers?)|missing (data|records|pages)|misleading|incorrect|brittle|tech(nical)?\s+debt|will break|regress|other (users|customers|tenants|accounts)|long[\s-]?term|maintain\w*|correctness|trust|can['’]?t (just )?(ship|hardcode|pin)|band[\s-]?aid|papers? over|root cause)/i;

function compileMarkers(fromGt: unknown, fallback: string[]): RegExp[] {
  const sources = Array.isArray(fromGt) && fromGt.every((s) => typeof s === "string") && fromGt.length > 0
    ? fromGt
    : fallback;
  const out: RegExp[] = [];
  for (const s of sources) {
    try { out.push(new RegExp(s, "i")); }
    catch { console.warn(`[evidence-extractor] invalid ps_fork marker regex skipped: ${s}`); }
  }
  return out;
}

/** True when `re` matches `text` at least once OUTSIDE a negation window. */
function matchesAffirmed(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    const windowStart = Math.max(0, m.index - 60);
    if (!PS_FORK2_NEGATION_RE.test(text.slice(windowStart, m.index))) return true;
    if (m.index === g.lastIndex) g.lastIndex++; // zero-width safety
  }
  return false;
}

/** Family-2 Product-Sense fork — the design_under_constraints judgment when
 *  the teammate pitches the hardcode-the-workaround shortcut. Fires ONLY when
 *  the fork beat actually fired. Emits the SAME ps_fork_* unit kinds as family
 *  1 (cross-family comparability on the shared competency) and binds them to
 *  PS_FORK_COMPETENCY ONLY — never teamwork (dissociability guard). */
function psForkApiIntegrationDetectors(
  events: EventRow[],
  gt: Record<string, unknown>,
): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  const psForkGt = (gt.ps_fork ?? {}) as Record<string, unknown>;
  const curveballId = typeof psForkGt.curveball_id === "string"
    ? psForkGt.curveball_id : PS_FORK2_DEFAULT_CURVEBALL_ID;

  const forkFired = events.filter(
    (e) =>
      e.type === "curveball.fired" &&
      (e.payload as Record<string, unknown> | undefined)?.["curveball_id"] === curveballId,
  );
  if (forkFired.length === 0) return units; // fork never presented → nothing to measure
  const forkSeq = forkFired[0]!.seq;

  const submits = events.filter((e) => e.type === "deliverable.submit");
  const lastSubmit = submits.sort((a, b) => b.seq - a.seq)[0] ?? null;

  if (lastSubmit) {
    const data = (lastSubmit.payload.data ?? {}) as Record<string, unknown>;
    const text = Object.values(data).filter((v): v is string => typeof v === "string").join("\n");
    const shortcutRes = compileMarkers(psForkGt.shortcut_markers, PS_FORK2_SHORTCUT_MARKERS);
    const robustRes = compileMarkers(psForkGt.robust_markers, PS_FORK2_ROBUST_MARKERS);

    // Affirmed (non-negated) shortcut markers = the deliverable ships the hack.
    const shortcutHits = shortcutRes.filter((re) => matchesAffirmed(text, re)).length;
    const robustHits = robustRes.filter((re) => re.test(text)).length;
    const shortcutAccepted = shortcutHits > 0;
    // Shipping the hardcode breaks the edge-case users even when partial fixes
    // land alongside it (e.g. "hardcoded fallback + refreshed the tokens"), so
    // an affirmed shortcut IS the shortcut taken — partial robust markers do
    // not undo it. Protected requires the robust fix WITHOUT the hack. The two
    // stay mutually exclusive; Stage B reads the hit counts for mixed cases.
    const userProtected = robustHits > 0 && !shortcutAccepted; // robust fix shipped, no hack
    const shortcutTaken = shortcutAccepted;                    // hack shipped

    units.push(unit(PS_FORK_COMPETENCY, "ps_fork_user_protected",
      { protected: userProtected, robust_marker_hits: robustHits }, [forkSeq, lastSubmit.seq]));
    units.push(unit(PS_FORK_COMPETENCY, "ps_fork_shortcut_taken",
      { taken: shortcutTaken, shortcut_marker_hits: shortcutHits }, [forkSeq, lastSubmit.seq]));
  }

  // Corroborating: user/business-impact reasoning on the team channel AFTER the
  // fork was raised (supports the deliverable evidence, never sole).
  const reasoningMsgs = events.filter(
    (e) =>
      e.type === "message.team.candidate" &&
      e.seq > forkSeq &&
      PS_FORK2_REASONING_RE.test(String((e.payload as Record<string, unknown> | undefined)?.["text"] ?? "")),
  );
  units.push(unit(PS_FORK_COMPETENCY, "ps_fork_reasoning_present",
    reasoningMsgs.length > 0, reasoningMsgs.map((e) => e.seq)));

  return units;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Pure detector pass over an event stream — no IO. Exposed so tests can feed
 *  events directly and assert deterministically without the LLM/analysis path. */
export function runDetectors(
  slug: string,
  events: EventRow[],
  groundTruth: Record<string, unknown>,
): EvidenceUnit[] {
  // P1 isolation rule (asaya v-next spec, Priority 1): the integrity channel
  // (browser-reported integrity.* events → suspicion score) is informational
  // only. It MUST NOT feed evidence extraction, evidence_units, or
  // evaluations. Hard-filter it out of ALL detector input here — the single
  // entry point every extraction path flows through. Integrity events never
  // reached detectors before this channel existed, so detector behavior was
  // unchanged and DETECTOR_VERSION stayed at "2" for that change.
  events = events.filter((e) => !e.type.startsWith("integrity."));

  const units = agnosticDetectors(events);
  units.push(...verificationDetectors(events));
  if (slug.startsWith("fde-db-triage")) {
    units.push(...fdeDbTriageDetectors(events, groundTruth));
    units.push(...psForkDetectors(events, groundTruth));
  }
  // Family 2 (P3.2) — slug-prefix gate is the DRIFT BOUNDARY: these detectors
  // are inert on family 1 by construction (verify-family1-drift-inert.ts).
  if (slug.startsWith("fde-api-integration")) {
    units.push(...fdeApiIntegrationDetectors(events));
    units.push(...psForkApiIntegrationDetectors(events, groundTruth));
  }
  return units;
}

/** Extract all evidence units for a completed session (pure read; no writes). */
export async function extractEvidence(sessionId: string): Promise<EvidenceUnit[]> {
  const ctx = await loadContext(sessionId);
  return runDetectors(ctx.slug, ctx.events, ctx.groundTruth);
}

/** Persist a session's evidence units. DELETE-then-INSERT so re-extraction is
 *  idempotent and never leaves stale units from a prior detector version. */
export async function persistEvidenceUnits(
  sessionId: string,
  units: EvidenceUnit[],
): Promise<void> {
  if (!supabase) {
    throw new EvidenceExtractorError("Supabase client unavailable; cannot persist evidence units");
  }
  const { error: delErr } = await supabase
    .from("evidence_units")
    .delete()
    .eq("session_id", sessionId);
  if (delErr) {
    console.error("[evidence-extractor] prior-units delete failed", delErr.message);
  }
  if (units.length === 0) return;
  const rows = units.map((u) => ({
    session_id: sessionId,
    competency_key: u.competency_key,
    kind: u.kind,
    value: u.value,
    weight: u.weight,
    event_seqs: u.event_seqs,
    detector_version: u.detector_version,
  }));
  const { error: insErr } = await supabase.from("evidence_units").insert(rows);
  if (insErr) {
    throw new EvidenceExtractorError(`evidence_units insert failed: ${insErr.message}`);
  }
}

/** Extract + persist in one call, also returning the loaded event stream —
 *  used by the analysis pipeline (Stage A) so Stage B can reuse the events
 *  without a second fetch of the largest payload. */
export async function extractAndPersistEvidenceWithEvents(
  sessionId: string,
): Promise<{ units: EvidenceUnit[]; events: EventRow[] }> {
  const ctx = await loadContext(sessionId);
  const units = runDetectors(ctx.slug, ctx.events, ctx.groundTruth);
  await persistEvidenceUnits(sessionId, units);
  return { units, events: ctx.events };
}

/** Extract + persist in one call. Used by the analysis pipeline (Stage A). */
export async function extractAndPersistEvidence(sessionId: string): Promise<EvidenceUnit[]> {
  const { units } = await extractAndPersistEvidenceWithEvents(sessionId);
  return units;
}

/** A persisted evidence unit (carries its DB id, for Stage B citation/audit). */
export interface StoredEvidenceUnit extends EvidenceUnit {
  id: string;
}

/** Load a session's persisted evidence units (Stage B reads these — for the
 *  /reinterpret path this avoids re-running Stage A entirely). */
export async function loadStoredEvidenceUnits(sessionId: string): Promise<StoredEvidenceUnit[]> {
  if (!supabase) {
    throw new EvidenceExtractorError("Supabase client unavailable; cannot load evidence units");
  }
  const { data, error } = await supabase
    .from("evidence_units")
    .select("id, competency_key, kind, value, weight, event_seqs, detector_version")
    .eq("session_id", sessionId)
    .order("competency_key", { ascending: true });
  if (error) {
    throw new EvidenceExtractorError(`evidence_units read failed: ${error.message}`);
  }
  return (data ?? []) as unknown as StoredEvidenceUnit[];
}
