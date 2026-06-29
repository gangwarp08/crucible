// Analysis Agent — the judge.
//
// Reads a completed session's condensed telemetry + the scenario's rubric +
// ground truth, fires one LLM call with response_format: json_object, then:
//   - validates the LLM's score-per-competency shape,
//   - filters out any evidence_seqs the LLM hallucinated (not in surfaced_seqs),
//   - computes the weighted overall SERVER-SIDE (we don't trust the model
//     to do the math),
//   - deletes any prior evaluation for the session (cascade drops items) and
//     inserts a fresh evaluations row + 8 evaluation_items rows,
//   - records cost as purpose: "analysis" (platform-side, master-key call),
//   - emits an ai.evaluation event for the recruiter timeline (via
//     events-direct.appendEvent so it works even after a server restart).
//
// Triggers:
//   - Auto: fire-and-forget from services/session.ts expireSession at the
//     very end (after telemetry flush + sandbox kill).
//   - Manual: routes/review.ts POST /sessions/:id/evaluate.

import { randomUUID } from "crypto";
import { env } from "../env.js";
import { supabase } from "./supabase.js";
import { chatCompletionWithMessages, type ChatMessage } from "./litellm.js";
import { recordCost } from "./telemetry.js";
import { appendEvent } from "./events-direct.js";
import { extractAndPersistEvidence, DETECTOR_VERSION } from "./evidence-extractor.js";
import { updateScenarioStats } from "./scenario-stats.js";
import {
  assembleAnalysisInput,
  AnalysisInputError,
  type AnalysisInput,
} from "./analysis-input.js";

export class AnalysisError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AnalysisError";
  }
}

// The competency SET is no longer hardcoded here — it comes from the canonical
// competency model (Slice 5.1). assembleAnalysisInput resolves the scenario's
// rubric binding into input.scenario.rubric; parseAndValidate iterates whatever
// competencies that resolved rubric declares. (The SYSTEM_PROMPT below still
// documents the current 8-competency schema by name; every v1 scenario binds
// the same 8, so the prompt and the resolved set agree. A future scenario that
// binds a different set would need the prompt schema generated from the keys.)

export interface EvaluationItem {
  competency: string;
  score: number; // integer 1-5
  weight: number;
  rationale: string;
  evidence: Array<{ event_seq: number; note: string }>;
}

export interface EvaluationResult {
  evaluation_id: string;
  session_id: string;
  overall_score: number;
  summary: string;
  model: string;
  status: "complete" | "error";
  items: EvaluationItem[];
}

const MODEL = "gemini-flash";
// Bump when the judge system prompt / scoring rubric in this file changes, so
// re-scoring + drift detection (Slice 5.7) can tell prompt revisions apart.
export const JUDGE_PROMPT_VERSION = "1";
// 8k headroom: 8 items × (rationale ~120 tok + 4 evidence × ~30 tok) +
// overall_summary ~250 tok ≈ 2k of actual content, plus the JSON scaffolding.
// 4k was too tight for dense sessions (15+ queries + 2 long AI prompts) — the
// gradient-check PROFILE C eval returned truncated mid-JSON at the prior cap.
const MAX_OUTPUT_TOKENS = 8_000;
const MAX_EVIDENCE_PER_ITEM = 4;

// ─── Judge system prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a strict but fair evaluator scoring a completed coding-assessment \
session against a fixed 8-competency rubric. You are the judge — not a \
candidate persona, and not the candidate's assistant.

You will receive a JSON document containing:
- rubric: the 8 competencies, each with weight + description + signals.
- ground_truth: the scenario's correct answers (numerical figures, the \
true root cause). This is hidden from the candidate; use it to grade \
correctness, not just plausibility.
- deliverable_spec: what the candidate was supposed to produce.
- success_criteria: the objective gates (must / bonus / tolerance).
- The candidate's deliverable (may be null if they didn't submit).
- The candidate's signal stream: messages they sent and received, db \
queries they ran, docs they viewed, AI-assistant turns, file snapshots, \
curveball reactions, and the constraint trajectory.
- evidence_units: DETERMINISTIC facts pre-computed by code from the event \
stream + ground truth — e.g. whether the candidate's dedup was correct, \
whether a status='succeeded' filter was missing, whether the corrected figure \
matched ground truth, AI-turn counts, whether the client/team were engaged. \
Treat these as STRONG, reliable signals and weigh them heavily for the \
objective competencies (data_fluency, execution). But they can be INCOMPLETE: \
e.g. figures_match_truth only matches a TOTAL figure written in the deliverable \
text, so a candidate who reported correct PER-MONTH figures may still show \
false. So: where a unit and the raw deliverable/signal AGREE, score with \
confidence; where they CONFLICT, look at the actual deliverable and signal to \
decide, rather than blindly following the unit. Use the signal stream for \
QUALITY and TONE (prose, collaboration, framing) where no unit applies.
- A list of valid event_seqs (\`surfaced_seqs\`). Every \`event_seq\` you \
cite as evidence MUST come from this list. Do NOT invent seqs.

For EACH of these 8 competencies (use these keys EXACTLY):
  problem_framing, customer_engagement, data_fluency, \
design_under_constraints, execution, ai_orchestration, teamwork, \
outcome_communication

Produce:
  - score: integer 1-5 (1=poor, 3=meets bar, 5=excellent).
  - rationale: 1-3 sentences grounded in what you saw in the signal.
  - evidence: array of up to ${MAX_EVIDENCE_PER_ITEM} items, each \
{ "event_seq": <int from surfaced_seqs>, "note": "<what this event shows>" }.

Also produce an overall_summary paragraph (3-5 sentences) capturing the \
candidate's main strengths, gaps, and whether they cleared the \
success_criteria.

Score conservatively. Reward correctness over activity. Penalize:
- ignoring the client (no clarifying questions, no status updates),
- acting on hints without testing them,
- never running the dedup query / never reading the docs,
- a deliverable that's missing components or numerically wrong,
- copy-pasting AI output without verification.
Reward:
- explicit hypothesis testing (especially refuting the refund red herring),
- a corrected figure within tolerance of ground truth,
- a board-ready summary in plain English,
- recommending the upstream idempotency fix.

SCORE EACH COMPETENCY ON ITS OWN EVIDENCE. A wrong final answer must NOT \
drag down process competencies that have independent evidence in the signal \
stream. If the candidate engaged thoughtfully with the team in the team \
channel, teamwork is scored on that exchange — separately from whether their \
final figures were right. If they wrote clean, well-structured client \
communication, that is real evidence for outcome_communication and \
customer_engagement regardless of execution correctness. Conversely, when \
execution IS right, do not inflate process scores that lack their own evidence.

THE EXCEPTION: confidently communicating an INCORRECT conclusion CAPS the \
relevant communication competency. Clean prose for the wrong answer cannot \
score 5 on outcome_communication — clarity is real but the message is wrong, \
which caps the band at roughly 3.

EXECUTION is a GRADUATED band, not a binary correctness check. Credit \
correct DIAGNOSIS and sound METHOD separately from final-figure precision. \
Use these anchors:
- 5/5: correct root cause + figures within ±2% of ground truth + working \
fix committed + an upstream remediation recommendation.
- 3/5: correct root cause AND sound method (e.g. dedup query actually run) \
but figures materially off from a specific identifiable error — e.g. found \
duplicates, dedup'd correctly, but missed the status='succeeded' filter so \
figures came back ~12% high; or correct figures but missing the bonus \
upstream-fix recommendation. The diagnosis and method are real; the figure \
is wrong for a nameable reason. This is genuinely mid, not a failure.
- 1/5: wrong root cause / naive uncorrected figures / no real fix attempted.

INTERACTIVE VERIFICATION (signal.verification): near the end a reviewer asked \
the candidate to DEFEND 2-3 consequential decisions, one answer each. When \
\`signal.verification.prompted\` is true, weigh the defense heavily: a \
deliverable that LOOKS correct but that the candidate CANNOT defend — vague or \
evasive answers, "I don't know", crediting the work to the AI, or contradicting \
their own queries — is NOT evidence of mastery. Such an undefended result CAPS \
the relevant competency (especially execution) at roughly 3, even if the figure \
matches ground truth, because we cannot trust an answer the candidate can't \
explain. The deterministic \`defense_weak\` evidence unit flags which \
competencies had a weak defense. Conversely, a specific, correct defense that \
shows real understanding is STRONG positive evidence for execution and \
data_fluency. When \`prompted\` is false, no verification occurred — ignore this \
section entirely and score on the rest of the signal as usual.

If the scenario's rubric includes per-competency \`anchors\`, treat those as \
authoritative for that scenario — they override these global anchors when \
they conflict.

DO NOT compute the overall_score yourself — we compute that server-side from \
your per-item scores + the rubric weights. Omit it.

Respond as JSON only, no markdown fences. Schema:
{
  "overall_summary": "...",
  "items": {
    "problem_framing":          { "score": 1-5, "rationale": "...", "evidence": [{"event_seq": N, "note": "..."}, ...] },
    "customer_engagement":      { "score": 1-5, "rationale": "...", "evidence": [...] },
    "data_fluency":             { ... },
    "design_under_constraints": { ... },
    "execution":                { ... },
    "ai_orchestration":         { ... },
    "teamwork":                 { ... },
    "outcome_communication":    { ... }
  }
}`;

// ─── Helpers ───────────────────────────────────────────────────────────────

function stripFences(s: string): string {
  const t = s.trim();
  if (t.startsWith("```")) {
    return t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  }
  return t;
}

interface RawItem {
  score?: unknown;
  rationale?: unknown;
  evidence?: unknown;
}
interface RawResponse {
  overall_summary?: unknown;
  items?: Record<string, RawItem | undefined>;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Parse + validate the LLM response. Filters hallucinated evidence_seqs.
 *  Missing competencies get score=1 + a "(no item returned)" rationale —
 *  surfaces the gap rather than hiding it. */
function parseAndValidate(
  raw: string,
  rubric: AnalysisInput["scenario"]["rubric"],
  surfacedSet: Set<number>,
): { items: EvaluationItem[]; summary: string } {
  let parsed: RawResponse;
  try {
    parsed = JSON.parse(stripFences(raw)) as RawResponse;
  } catch (err) {
    throw new AnalysisError(`LLM returned non-JSON: ${(err as Error).message}`);
  }

  const summary =
    typeof parsed.overall_summary === "string"
      ? parsed.overall_summary.trim()
      : "(no summary returned)";

  const items: EvaluationItem[] = [];
  // Iterate the competencies the resolved rubric declares (from the canonical
  // model binding), not a hardcoded list.
  for (const competency of Object.keys(rubric)) {
    const raw = parsed.items?.[competency];
    const weight =
      typeof rubric[competency]?.weight === "number" ? rubric[competency]!.weight : 0;

    if (!raw || typeof raw !== "object") {
      items.push({
        competency,
        score: 1,
        weight,
        rationale: "(no item returned by the judge)",
        evidence: [],
      });
      continue;
    }

    const rawScore = typeof raw.score === "number" ? raw.score : Number(raw.score);
    const score = clamp(
      Number.isFinite(rawScore) ? Math.round(rawScore) : 1,
      1,
      5,
    );
    const rationale =
      typeof raw.rationale === "string" ? raw.rationale.trim() : "";

    const evidence: EvaluationItem["evidence"] = [];
    const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
    for (const e of rawEvidence) {
      if (evidence.length >= MAX_EVIDENCE_PER_ITEM) break;
      if (!e || typeof e !== "object") continue;
      const seq = (e as { event_seq?: unknown }).event_seq;
      const note = (e as { note?: unknown }).note;
      if (typeof seq !== "number" || !Number.isInteger(seq)) continue;
      if (!surfacedSet.has(seq)) continue; // hallucinated — drop silently
      evidence.push({
        event_seq: seq,
        note: typeof note === "string" ? note.trim() : "",
      });
    }

    items.push({ competency, score, weight, rationale, evidence });
  }

  return { items, summary };
}

function weightedOverall(items: EvaluationItem[]): number {
  let total = 0;
  for (const it of items) total += it.score * it.weight;
  return Math.round(total * 100) / 100;
}

// ─── Persistence ───────────────────────────────────────────────────────────

interface VersionStamps {
  competencyModelVersion: number | null;
  detectorVersion: string | null;
  judgePromptVersion: string | null;
  scenarioVersion: number | null;
}

async function persistEvaluation(
  sessionId: string,
  scenarioId: string,
  overallScore: number,
  summary: string,
  status: "complete" | "error",
  items: EvaluationItem[],
  versions: VersionStamps,
): Promise<string> {
  if (!supabase) {
    throw new AnalysisError("Supabase client unavailable; cannot persist evaluation");
  }

  // Delete any prior evaluation for this session — cascade drops items.
  const { error: delErr } = await supabase
    .from("evaluations")
    .delete()
    .eq("session_id", sessionId);
  if (delErr) {
    console.error("[analysis] prior-evaluation delete failed", delErr.message);
    // Continue — INSERT will still succeed; the worst case is a duplicate
    // evaluations row for the session, surfaced by the verifier.
  }

  const evaluationId = randomUUID();
  const { error: insErr } = await supabase.from("evaluations").insert({
    id: evaluationId,
    session_id: sessionId,
    scenario_id: scenarioId,
    overall_score: overallScore,
    summary,
    model: MODEL,
    status,
    competency_model_version: versions.competencyModelVersion,
    detector_version: versions.detectorVersion,
    judge_prompt_version: versions.judgePromptVersion,
    scenario_version: versions.scenarioVersion,
  });
  if (insErr) {
    throw new AnalysisError(`evaluations insert failed: ${insErr.message}`);
  }

  if (items.length > 0) {
    const itemRows = items.map((it) => ({
      id: randomUUID(),
      evaluation_id: evaluationId,
      competency: it.competency,
      score: it.score,
      weight: it.weight,
      rationale: it.rationale,
      evidence: it.evidence,
    }));
    const { error: itemErr } = await supabase.from("evaluation_items").insert(itemRows);
    if (itemErr) {
      throw new AnalysisError(`evaluation_items insert failed: ${itemErr.message}`);
    }
  }

  return evaluationId;
}

// ─── Main entry ────────────────────────────────────────────────────────────

async function runStageB(sessionId: string): Promise<EvaluationResult> {
  let input: AnalysisInput;
  try {
    input = await assembleAnalysisInput(sessionId);
  } catch (err) {
    if (err instanceof AnalysisInputError) throw new AnalysisError(err.message);
    throw err;
  }

  // Resolve scenario_id again (we have it implicitly via input — read from the
  // session row's scenario_id). assembleAnalysisInput already validated.
  // Re-read it here for the persist call; cheap.
  const { data: sessRow } = await supabase!
    .from("sessions")
    .select("scenario_id")
    .eq("id", sessionId)
    .single();
  const scenarioId = (sessRow as unknown as { scenario_id: string } | null)?.scenario_id;
  if (!scenarioId) {
    throw new AnalysisError(`session ${sessionId} has no scenario_id`);
  }

  // Full provenance stamp for this verdict (Slice 5.7). competency_model_version
  // landed in 5.1; the other three legs let drift detection re-score the anchor
  // set whenever any of them changes.
  const versions: VersionStamps = {
    competencyModelVersion: input.scenario.competency_model_version,
    detectorVersion: DETECTOR_VERSION,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    scenarioVersion: input.scenario.scenario_version,
  };

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(input) },
  ];

  const t0 = Date.now();
  let result: Awaited<ReturnType<typeof chatCompletionWithMessages>>;
  try {
    // Master key — the per-session key has been revoked by expireSession,
    // and analysis is platform cost (CLAUDE.md Hard Rule 1 confines provider
    // keys to LiteLLM; the master key here is just the gateway auth).
    result = await chatCompletionWithMessages(env.LITELLM_MASTER_KEY, messages, {
      responseFormat: "json_object",
      maxTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[analysis] LLM call failed for session ${sessionId}:`, message);
    // Persist a status='error' marker so the recruiter UI shows that the
    // evaluation was attempted but failed (vs. "never run").
    const evaluationId = await persistEvaluation(
      sessionId,
      scenarioId,
      0,
      `Evaluation failed: ${message}`,
      "error",
      [],
      versions,
    );
    void appendEvent(sessionId, "ai.evaluation", "system", {
      evaluation_id: evaluationId,
      overall_score: 0,
      model: MODEL,
      status: "error",
      error: message,
    });
    throw new AnalysisError(`analysis LLM call failed: ${message}`);
  }
  const latencyMs = Date.now() - t0;

  const surfacedSet = new Set<number>(input.surfaced_seqs);
  let items: EvaluationItem[];
  let summary: string;
  try {
    const parsed = parseAndValidate(result.text, input.scenario.rubric, surfacedSet);
    items = parsed.items;
    summary = parsed.summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[analysis] response parse failed for session ${sessionId}:`, message);
    const evaluationId = await persistEvaluation(
      sessionId,
      scenarioId,
      0,
      `Response parse failed: ${message}. Raw start: ${result.text.slice(0, 200)}`,
      "error",
      [],
      versions,
    );
    void appendEvent(sessionId, "ai.evaluation", "system", {
      evaluation_id: evaluationId,
      overall_score: 0,
      model: MODEL,
      status: "error",
      error: message,
    });
    throw new AnalysisError(message);
  }

  const overallScore = weightedOverall(items);

  const evaluationId = await persistEvaluation(
    sessionId,
    scenarioId,
    overallScore,
    summary,
    "complete",
    items,
    versions,
  );

  // Refresh the scenario's running aggregates (Slice 5.7). Fire-and-forget +
  // non-fatal: a stats failure must never block the evaluation result.
  void updateScenarioStats(scenarioId).catch((err) => {
    console.error(
      `[analysis] scenario_stats update failed for scenario ${scenarioId}:`,
      (err as Error).message,
    );
  });

  // Cost ledger entry — NOT added to session.spend_usd since this is on the
  // platform master key, not the per-session key. The cumulative_spend_usd
  // is the session's existing tally; the cost row is purely attributional.
  const { data: spendRow } = await supabase!
    .from("sessions")
    .select("spend_usd")
    .eq("id", sessionId)
    .single();
  const existingSpend = Number(
    (spendRow as unknown as { spend_usd: number | string } | null)?.spend_usd ?? 0,
  );
  void recordCost(sessionId, {
    model: MODEL,
    promptTokens: result.usage?.promptTokens ?? 0,
    completionTokens: result.usage?.completionTokens ?? 0,
    costUsd: result.responseCost ?? 0,
    cumulativeSpendUsd: existingSpend,
    purpose: "analysis",
    ...(result.callId && { litellmCallId: result.callId }),
  });

  // Recruiter-timeline marker. Lands even if the session entry is gone from
  // memory (the analysis agent often runs on historical sessions via the
  // manual re-evaluate endpoint).
  void appendEvent(sessionId, "ai.evaluation", "system", {
    evaluation_id: evaluationId,
    overall_score: overallScore,
    model: MODEL,
    status: "complete",
    latency_ms: latencyMs,
    prompt_tokens: result.usage?.promptTokens ?? 0,
    completion_tokens: result.usage?.completionTokens ?? 0,
  });

  return {
    evaluation_id: evaluationId,
    session_id: sessionId,
    overall_score: overallScore,
    summary,
    model: MODEL,
    status: "complete",
    items,
  };
}

/**
 * Full evaluation (auto-eval on session end + POST /evaluate):
 * Stage A deterministic extraction → Stage B LLM judge over the units + signal.
 */
export async function runAnalysisAgent(sessionId: string): Promise<EvaluationResult> {
  // Stage A — deterministic evidence extraction (Slice 5.2). Runs BEFORE the
  // judge so Stage B reads fresh units. Non-fatal: a detector failure must
  // never block the evaluation (Stage B can still judge the raw signal).
  try {
    const units = await extractAndPersistEvidence(sessionId);
    console.log(`[analysis] extracted ${units.length} evidence units for session ${sessionId}`);
  } catch (err) {
    console.error(
      `[analysis] evidence extraction failed for session ${sessionId}:`,
      (err as Error).message,
    );
  }
  return runStageB(sessionId);
}

/**
 * Re-score over STORED evidence units only — no Stage A re-extraction and no
 * session replay (Slice 5.3). This is the cheap calibration / model A-B path:
 * the deterministic units are fixed, so re-running Stage B re-interprets them
 * for a single LLM call against a historical session.
 */
export async function reinterpretEvaluation(sessionId: string): Promise<EvaluationResult> {
  return runStageB(sessionId);
}
