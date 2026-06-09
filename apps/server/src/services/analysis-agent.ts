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

const COMPETENCIES = [
  "problem_framing",
  "customer_engagement",
  "data_fluency",
  "design_under_constraints",
  "execution",
  "ai_orchestration",
  "teamwork",
  "outcome_communication",
] as const;
type Competency = (typeof COMPETENCIES)[number];

export interface EvaluationItem {
  competency: Competency;
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
const MAX_OUTPUT_TOKENS = 4_000;
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
  items?: Partial<Record<Competency, RawItem>>;
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
  for (const competency of COMPETENCIES) {
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

async function persistEvaluation(
  sessionId: string,
  scenarioId: string,
  overallScore: number,
  summary: string,
  status: "complete" | "error",
  items: EvaluationItem[],
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

export async function runAnalysisAgent(sessionId: string): Promise<EvaluationResult> {
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
  );

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
