// Telemetry condensation for the Analysis Agent.
//
// Reads everything we know about a completed session from Supabase + the
// scenario's ground_truth.json from disk, partitions events by type, caps
// each section, and returns a single structured AnalysisInput that fits
// comfortably under the gateway's prompt budget.
//
// Loads strictly from durable storage (Supabase + filesystem) — no
// dependency on the in-memory sessionRegistry. This means the manual
// re-evaluate endpoint works on any historical session, including ones
// from before the server restarted.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedRubricItem } from "@crucible/shared";
import { supabase } from "./supabase.js";
import { resolveScenarioRubric } from "./competencies.js";

const here = dirname(fileURLToPath(import.meta.url));
// apps/server/src/services/ → repo root is 4 levels up.
const REPO_ROOT = resolve(here, "../../../..");

const SCENARIOS_SELECT =
  "id, slug, rubric, deliverable_spec, success_criteria, docs, dataset_ref, " +
  "client_persona, team_persona, constraints";

// ─── Public types ──────────────────────────────────────────────────────────

export interface CondensedMessage {
  seq: number;
  channel: "client" | "team";
  role: "candidate" | "persona";
  persona_name?: string;
  text: string;
  proactive?: boolean;
}

export interface CondensedDbQuery {
  seq: number;
  sql: string;
  status: "ok" | "error";
  row_count?: number;
  duration_ms: number;
  error?: string;
}

export interface CondensedDocView {
  seq: number;
  doc_id: string;
  title: string;
}

export interface CondensedAssistantTurn {
  candidate_seq: number;
  candidate_text: string;
  response_seq: number | null;
  response_text: string | null;
  total_tokens: number | null;
}

export interface CondensedCurveball {
  seq: number;
  curveball_id: string;
  channel: "client" | "team";
  t_offset_ms: number;
  // The next few candidate-side events in any channel after the curveball
  // fired. Captures "what the candidate did in response".
  followup_event_seqs: number[];
  followup_summary: string;
}

export interface ConstraintSummary {
  tokens_final: number | null;
  tokens_initial: number | null;
  compute_minutes_final: number | null;
  compute_minutes_initial: number | null;
  db_query_count: number;
  sandbox_command_count: number;
  ai_assistant_call_count: number;
}

export interface CondensedDeliverable {
  status: "draft" | "submitted";
  data: {
    corrected_monthly_revenue: string;
    root_cause_finding: string;
    client_facing_summary: string;
    decisions_and_tradeoffs: string;
  };
  updated_at: string;
}

export interface CondensedFileSnapshot {
  path: string;
  content: string;
  truncated: boolean;
}

export interface AnalysisInput {
  session: {
    id: string;
    scenario_slug: string;
    ended_at: string | null;
    end_reason: string | null;
    duration_min: number | null;
    spend_usd_final: number;
  };
  scenario: {
    // Resolved from the scenario's rubric BINDING against the canonical model
    // (Slice 5.1). Mirrors the pre-rebind rubric item shape, so the LLM input
    // is unchanged.
    rubric: Record<string, ResolvedRubricItem>;
    // The competency model version this evaluation runs under — stamped onto
    // the evaluations row so scores stay comparable as the construct evolves.
    competency_model_version: number;
    deliverable_spec: Record<string, unknown>;
    success_criteria: Record<string, unknown>;
    docs: Array<{ id: string; title: string }>;
  };
  ground_truth: Record<string, unknown>;
  signal: {
    messages: CondensedMessage[];
    db_queries: CondensedDbQuery[];
    doc_views: CondensedDocView[];
    ai_assistant: CondensedAssistantTurn[];
    curveballs: CondensedCurveball[];
    constraint_summary: ConstraintSummary;
    deliverable: CondensedDeliverable | null;
    file_snapshots: CondensedFileSnapshot[];
    truncation_notes: string[];
  };
  // Set of every event seq surfaced anywhere in `signal` — used by the agent
  // to validate the LLM-cited evidence_seqs are real (no hallucinated seqs).
  surfaced_seqs: number[];
}

export class AnalysisInputError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AnalysisInputError";
  }
}

// ─── Caps (soft — sections get a "…[truncated]" marker when they hit) ─────

const MAX_MESSAGES = 25;
const MAX_MESSAGE_CHARS = 500;
const MAX_QUERIES = 20;
const MAX_QUERY_CHARS = 500;
const MAX_ASSISTANT_PAIRS = 10;
const MAX_ASSISTANT_CHARS = 700;
const MAX_FILE_SNAPSHOTS = 5;
const MAX_FILE_CHARS = 1_000;
const MAX_DELIVERABLE_FIELD_CHARS = 2_000;
const CURVEBALL_FOLLOWUP_COUNT = 3;

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…[truncated]";
}

// ─── Main entry ────────────────────────────────────────────────────────────

interface EventRow {
  seq: number;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  scenario_id: string | null;
  scenario_state: Record<string, unknown> | null;
  status: string;
  ended_at: string | null;
  end_reason: string | null;
  duration_ms: number | null;
  spend_usd: number | string | null;
  created_at: string;
}

interface ScenarioRow {
  id: string;
  slug: string;
  // Stored as a rubric BINDING array (Slice 5.1); validated + resolved against
  // the canonical model by resolveScenarioRubric.
  rubric: unknown;
  deliverable_spec: Record<string, unknown>;
  success_criteria: Record<string, unknown>;
  docs: Array<Record<string, unknown>>;
  dataset_ref: string | null;
  client_persona: Record<string, unknown>;
  team_persona: Record<string, unknown>;
  constraints: Record<string, number>;
}

interface FileSnapRow {
  path: string;
  content: string | null;
  ts: string;
}

export async function assembleAnalysisInput(sessionId: string): Promise<AnalysisInput> {
  if (!supabase) {
    throw new AnalysisInputError("Supabase service-role client unavailable");
  }

  // ── 1. Session row ───────────────────────────────────────────────────
  const { data: sessionData, error: sessErr } = await supabase
    .from("sessions")
    .select(
      "id, scenario_id, scenario_state, status, ended_at, end_reason, " +
      "duration_ms, spend_usd, created_at",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (sessErr) {
    throw new AnalysisInputError(`session read failed: ${sessErr.message}`);
  }
  if (!sessionData) {
    throw new AnalysisInputError(`session ${sessionId} not found`);
  }
  const sessionRow = sessionData as unknown as SessionRow;
  if (!sessionRow.scenario_id) {
    throw new AnalysisInputError(
      `session ${sessionId} has no scenario — Analysis Agent requires a scenario-bound session`,
    );
  }
  if (!sessionRow.ended_at) {
    throw new AnalysisInputError(
      `session ${sessionId} has not ended — call DELETE /sessions/:id first or wait for the orchestrator timeout`,
    );
  }

  // ── 2. Scenario row ─────────────────────────────────────────────────
  const { data: scenarioData, error: scenErr } = await supabase
    .from("scenarios")
    .select(SCENARIOS_SELECT)
    .eq("id", sessionRow.scenario_id)
    .single();
  if (scenErr || !scenarioData) {
    throw new AnalysisInputError(`scenario read failed: ${scenErr?.message}`);
  }
  const scenarioRow = scenarioData as unknown as ScenarioRow;

  // ── 2b. Resolve the rubric binding against the canonical competency model.
  // Produces the effective per-competency rubric (weights + anchors + scoring
  // notes) the judge consumes, plus the model version to stamp on the verdict.
  const { version: competencyModelVersion, resolved } = await resolveScenarioRubric(
    scenarioRow.rubric,
  );

  // ── 3. Ground truth from disk ───────────────────────────────────────
  let groundTruth: Record<string, unknown> = {};
  const datasetRef = scenarioRow.dataset_ref as string | null;
  if (datasetRef) {
    try {
      const gtPath = resolve(REPO_ROOT, datasetRef, "ground_truth.json");
      groundTruth = JSON.parse(readFileSync(gtPath, "utf8"));
    } catch (err) {
      console.warn(
        `[analysis-input] could not read ground_truth.json for dataset_ref=${datasetRef}:`,
        (err as Error).message,
      );
    }
  }

  // ── 4. Events ────────────────────────────────────────────────────────
  const { data: eventsRaw, error: evErr } = await supabase
    .from("events")
    .select("seq, type, actor, payload")
    .eq("session_id", sessionId)
    .order("seq", { ascending: true });
  if (evErr) {
    throw new AnalysisInputError(`events read failed: ${evErr.message}`);
  }
  const events = (eventsRaw ?? []) as unknown as EventRow[];

  // ── 5. File snapshots — latest per path ─────────────────────────────
  const { data: snapsRaw } = await supabase
    .from("file_snapshots")
    .select("path, content, ts")
    .eq("session_id", sessionId)
    .order("ts", { ascending: true });
  const latestByPath = new Map<string, { content: string | null; ts: string }>();
  for (const s of ((snapsRaw ?? []) as unknown as FileSnapRow[])) {
    latestByPath.set(s.path, { content: s.content, ts: s.ts });
  }

  // ── 6. Condense events into typed buckets ───────────────────────────
  const truncationNotes: string[] = [];
  const surfaced = new Set<number>();

  // Messages (client + team, candidate + persona)
  const allMessages: CondensedMessage[] = [];
  for (const e of events) {
    if (!e.type.startsWith("message.")) continue;
    const parts = e.type.split(".");
    const channel = parts[1] as "client" | "team";
    const role = parts[2] as "candidate" | "persona";
    const p = e.payload ?? {};
    const m: CondensedMessage = {
      seq: e.seq,
      channel,
      role,
      text: clip(typeof p["text"] === "string" ? p["text"] : "", MAX_MESSAGE_CHARS),
    };
    if (typeof p["persona_name"] === "string") m.persona_name = p["persona_name"];
    if (p["proactive"] === true) m.proactive = true;
    allMessages.push(m);
  }
  const messages = allMessages.slice(-MAX_MESSAGES);
  if (allMessages.length > MAX_MESSAGES) {
    truncationNotes.push(
      `messages: kept last ${MAX_MESSAGES} of ${allMessages.length}`,
    );
  }
  for (const m of messages) surfaced.add(m.seq);

  // db.query
  const allQueries: CondensedDbQuery[] = [];
  for (const e of events) {
    if (e.type !== "db.query") continue;
    const p = e.payload ?? {};
    const q: CondensedDbQuery = {
      seq: e.seq,
      sql: clip(typeof p["sql"] === "string" ? p["sql"] : "", MAX_QUERY_CHARS),
      status: p["status"] === "error" ? "error" : "ok",
      duration_ms: typeof p["duration_ms"] === "number" ? p["duration_ms"] : 0,
    };
    if (typeof p["row_count"] === "number") q.row_count = p["row_count"];
    if (typeof p["error"] === "string") q.error = clip(p["error"], 200);
    allQueries.push(q);
  }
  const db_queries = allQueries.slice(-MAX_QUERIES);
  if (allQueries.length > MAX_QUERIES) {
    truncationNotes.push(
      `db_queries: kept last ${MAX_QUERIES} of ${allQueries.length}`,
    );
  }
  for (const q of db_queries) surfaced.add(q.seq);

  // doc.view (small — keep all)
  const doc_views: CondensedDocView[] = [];
  for (const e of events) {
    if (e.type !== "doc.view") continue;
    const p = e.payload ?? {};
    if (typeof p["doc_id"] === "string" && typeof p["title"] === "string") {
      doc_views.push({ seq: e.seq, doc_id: p["doc_id"], title: p["title"] });
      surfaced.add(e.seq);
    }
  }

  // AI assistant — pair candidate + next response
  const allPairs: CondensedAssistantTurn[] = [];
  let pendingCandidate: { seq: number; text: string } | null = null;
  for (const e of events) {
    if (e.type === "ai.assistant.candidate") {
      const p = e.payload ?? {};
      pendingCandidate = {
        seq: e.seq,
        text: clip(typeof p["text"] === "string" ? p["text"] : "", MAX_ASSISTANT_CHARS),
      };
    } else if (e.type === "ai.assistant.response" && pendingCandidate) {
      const p = e.payload ?? {};
      allPairs.push({
        candidate_seq: pendingCandidate.seq,
        candidate_text: pendingCandidate.text,
        response_seq: e.seq,
        response_text: clip(
          typeof p["text"] === "string" ? p["text"] : "",
          MAX_ASSISTANT_CHARS,
        ),
        total_tokens: typeof p["total_tokens"] === "number" ? p["total_tokens"] : null,
      });
      pendingCandidate = null;
    }
  }
  // Trailing candidate with no response (e.g. failed call)
  if (pendingCandidate) {
    allPairs.push({
      candidate_seq: pendingCandidate.seq,
      candidate_text: pendingCandidate.text,
      response_seq: null,
      response_text: null,
      total_tokens: null,
    });
  }
  const ai_assistant = allPairs.slice(-MAX_ASSISTANT_PAIRS);
  if (allPairs.length > MAX_ASSISTANT_PAIRS) {
    truncationNotes.push(
      `ai_assistant: kept last ${MAX_ASSISTANT_PAIRS} of ${allPairs.length}`,
    );
  }
  for (const a of ai_assistant) {
    surfaced.add(a.candidate_seq);
    if (a.response_seq !== null) surfaced.add(a.response_seq);
  }

  // curveball.fired + the next N candidate-meaningful events after each
  const curveballs: CondensedCurveball[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type !== "curveball.fired") continue;
    const p = e.payload ?? {};
    const followupSeqs: number[] = [];
    const followupBits: string[] = [];
    for (let j = i + 1; j < events.length && followupSeqs.length < CURVEBALL_FOLLOWUP_COUNT; j++) {
      const fe = events[j]!;
      // Count anything candidate-initiated as a follow-up.
      if (fe.actor !== "candidate") continue;
      followupSeqs.push(fe.seq);
      const fp = fe.payload ?? {};
      if (fe.type === "db.query") {
        followupBits.push(
          `db.query: ${clip(typeof fp["sql"] === "string" ? fp["sql"] : "", 80)}`,
        );
      } else if (fe.type.startsWith("message.")) {
        followupBits.push(
          `${fe.type}: ${clip(typeof fp["text"] === "string" ? fp["text"] : "", 80)}`,
        );
      } else if (fe.type === "ai.assistant.candidate") {
        followupBits.push(
          `assistant prompt: ${clip(typeof fp["text"] === "string" ? fp["text"] : "", 80)}`,
        );
      } else {
        followupBits.push(fe.type);
      }
    }
    curveballs.push({
      seq: e.seq,
      curveball_id: typeof p["curveball_id"] === "string" ? p["curveball_id"] : "?",
      channel: (p["channel"] === "client" ? "client" : "team"),
      t_offset_ms: typeof p["t_offset_ms"] === "number" ? p["t_offset_ms"] : 0,
      followup_event_seqs: followupSeqs,
      followup_summary: followupBits.join(" / ") || "(none)",
    });
    surfaced.add(e.seq);
    for (const s of followupSeqs) surfaced.add(s);
  }

  // Constraint summary
  const scenarioState = (sessionRow.scenario_state ?? {}) as Record<string, unknown>;
  const initial = (scenarioState["budget_initial"] ?? {}) as Record<string, unknown>;
  let dbQueryCount = 0;
  let sandboxCommandCount = 0;
  let aiAssistantCallCount = 0;
  for (const e of events) {
    if (e.type === "db.query") dbQueryCount++;
    else if (e.type === "ai.assistant.candidate") aiAssistantCallCount++;
    else if (e.type === "constraint.spend") {
      const p = e.payload ?? {};
      if (p["reason"] === "sandbox_command") sandboxCommandCount++;
    }
  }
  const constraint_summary: ConstraintSummary = {
    tokens_final: typeof scenarioState["tokens"] === "number" ? scenarioState["tokens"] : null,
    tokens_initial: typeof initial["tokens"] === "number" ? initial["tokens"] : null,
    compute_minutes_final:
      typeof scenarioState["compute_minutes"] === "number" ? scenarioState["compute_minutes"] : null,
    compute_minutes_initial:
      typeof initial["compute_minutes"] === "number" ? initial["compute_minutes"] : null,
    db_query_count: dbQueryCount,
    sandbox_command_count: sandboxCommandCount,
    ai_assistant_call_count: aiAssistantCallCount,
  };

  // Deliverable: prefer scenario_state.deliverable (the canonical mirror),
  // but fall back to the latest deliverable.submit / deliverable.draft event
  // payload if the mirror is missing. The mirror is best-effort persisted via
  // a fire-and-forget persistScenarioState that races with other concurrent
  // scenario_state writes (token + compute deductions) and can be clobbered
  // — see services/db.ts. The events table is the durable record either way.
  let deliverable: CondensedDeliverable | null = null;
  let rawDel = scenarioState["deliverable"] as Record<string, unknown> | undefined;
  if (!rawDel) {
    // Scan back-to-front for the last deliverable event (submit takes priority
    // over draft within the same point in time, but since we walk by seq the
    // latest write always wins).
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type !== "deliverable.submit" && e.type !== "deliverable.draft") continue;
      const p = e.payload ?? {};
      rawDel = {
        status: e.type === "deliverable.submit" ? "submitted" : "draft",
        data: p["data"] ?? {},
        updated_at: typeof p["updated_at"] === "string" ? p["updated_at"] : "",
      };
      break;
    }
  }
  if (rawDel && typeof rawDel === "object") {
    const rawData = (rawDel["data"] ?? {}) as Record<string, unknown>;
    deliverable = {
      status: rawDel["status"] === "submitted" ? "submitted" : "draft",
      updated_at: typeof rawDel["updated_at"] === "string" ? rawDel["updated_at"] : "",
      data: {
        corrected_monthly_revenue: clip(
          typeof rawData["corrected_monthly_revenue"] === "string"
            ? rawData["corrected_monthly_revenue"]
            : "",
          MAX_DELIVERABLE_FIELD_CHARS,
        ),
        root_cause_finding: clip(
          typeof rawData["root_cause_finding"] === "string"
            ? rawData["root_cause_finding"]
            : "",
          MAX_DELIVERABLE_FIELD_CHARS,
        ),
        client_facing_summary: clip(
          typeof rawData["client_facing_summary"] === "string"
            ? rawData["client_facing_summary"]
            : "",
          MAX_DELIVERABLE_FIELD_CHARS,
        ),
        decisions_and_tradeoffs: clip(
          typeof rawData["decisions_and_tradeoffs"] === "string"
            ? rawData["decisions_and_tradeoffs"]
            : "",
          MAX_DELIVERABLE_FIELD_CHARS,
        ),
      },
    };
  }

  // File snapshots — latest per path
  const allSnaps = Array.from(latestByPath.entries()).map(([path, s]) => ({
    path,
    content: s.content ?? "",
    truncated: (s.content?.length ?? 0) > MAX_FILE_CHARS,
  }));
  const file_snapshots: CondensedFileSnapshot[] = allSnaps
    .slice(0, MAX_FILE_SNAPSHOTS)
    .map((s) => ({
      path: s.path,
      content: clip(s.content, MAX_FILE_CHARS),
      truncated: s.truncated,
    }));
  if (allSnaps.length > MAX_FILE_SNAPSHOTS) {
    truncationNotes.push(
      `file_snapshots: kept ${MAX_FILE_SNAPSHOTS} of ${allSnaps.length} (alphabetical, by latest ts per path)`,
    );
  }

  // Scenario docs — just title + id for context (bodies elide; the candidate
  // viewed them via doc_views events).
  const docsRaw = (scenarioRow.docs ?? []) as Array<Record<string, unknown>>;
  const docs = docsRaw
    .filter(
      (d) => typeof d["id"] === "string" && typeof d["title"] === "string",
    )
    .map((d) => ({ id: d["id"] as string, title: d["title"] as string }));

  // Duration
  const duration_min =
    typeof sessionRow.duration_ms === "number"
      ? Math.round((sessionRow.duration_ms / 60_000) * 10) / 10
      : null;

  return {
    session: {
      id: sessionId,
      scenario_slug: scenarioRow.slug as string,
      ended_at: sessionRow.ended_at as string | null,
      end_reason: sessionRow.end_reason as string | null,
      duration_min,
      spend_usd_final: Number(sessionRow.spend_usd ?? 0),
    },
    scenario: {
      rubric: resolved.rubric,
      competency_model_version: competencyModelVersion,
      deliverable_spec: scenarioRow.deliverable_spec as Record<string, unknown>,
      success_criteria: scenarioRow.success_criteria as Record<string, unknown>,
      docs,
    },
    ground_truth: groundTruth,
    signal: {
      messages,
      db_queries,
      doc_views,
      ai_assistant,
      curveballs,
      constraint_summary,
      deliverable,
      file_snapshots,
      truncation_notes: truncationNotes,
    },
    surfaced_seqs: Array.from(surfaced).sort((a, b) => a - b),
  };
}
