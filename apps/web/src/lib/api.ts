// All calls go to our own Fastify server — never to LiteLLM / E2B / Supabase directly.
const SERVER_URL = process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:3001";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface CreateSessionResult {
  sessionId: string;
  deadline: string;
  scenarioId: string | null;
}

export async function createSession(
  opts?: { scenarioId?: string },
): Promise<CreateSessionResult> {
  const init: RequestInit = { method: "POST" };
  if (opts?.scenarioId) {
    init.body = JSON.stringify({ scenarioId: opts.scenarioId });
  }
  return apiFetch<CreateSessionResult>("/sessions", init);
}

export interface ScenarioConstraints {
  time_minutes: number | null;
  tokens: number | null;
  compute_minutes: number | null;
  money_usd: number | null;
  memory_mb: number | null;
}

export interface ScenarioBalances {
  tokens: number | null;
  compute_minutes: number | null;
}

export type DeliverableStatus = "draft" | "submitted";

export interface DeliverableData {
  corrected_monthly_revenue: string;
  root_cause_finding: string;
  client_facing_summary: string;
  decisions_and_tradeoffs: string;
}

export interface Deliverable {
  status: DeliverableStatus;
  data: DeliverableData;
  updated_at: string;
}

export interface SessionInfo {
  sessionId: string;
  deadline: string;
  budget: number;
  spend: number;
  status: "active" | "completed";
  // null when this session has no scenario (legacy generic mode); otherwise
  // the live game-mechanic token balance the AI assistant draws from.
  scenarioTokensRemaining: number | null;
  // Static snapshot of the starting constraint values; HUD denominators.
  scenarioConstraints: ScenarioConstraints | null;
  // Live values for the hard-resource HUD indicators (tokens, compute).
  scenarioBalances: ScenarioBalances | null;
  // Latest deliverable mirrored from scenario_state.deliverable.
  deliverable: Deliverable | null;
  // Frozen presentation metadata for the candidate UI (null when this
  // session has no scenario).
  scenarioTitle:      string | null;
  scenarioBrief:      string | null;
  scenarioRole:       string | null;
  scenarioDifficulty: string | null;
}

// ── Candidate-safe scenario lookup ──────────────────────────────────────────

export interface ScenarioDeliverableComponent {
  key: string;
  label: string;
  what: string;
}

export interface Scenario {
  id: string;
  slug: string;
  title: string;
  role: string;
  difficulty: string | null;
  brief: string | null;
  constraints: ScenarioConstraints;
  deliverable_components: ScenarioDeliverableComponent[];
}

export class ScenarioNotFoundError extends Error {
  constructor(slug: string) {
    super(`Scenario "${slug}" not found`);
    this.name = "ScenarioNotFoundError";
  }
}

/** Fetch a scenario's candidate-safe metadata (brief, constraints, deliverable
 *  components). Throws ScenarioNotFoundError on 404 so the caller can render
 *  a clean "not found" state distinct from other failures. */
export async function getScenarioBySlug(slug: string): Promise<Scenario> {
  const res = await fetch(`${SERVER_URL}/api/scenarios/${encodeURIComponent(slug)}`);
  if (res.status === 404) throw new ScenarioNotFoundError(slug);
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Scenario>;
}

export async function getSession(sessionId: string): Promise<SessionInfo> {
  return apiFetch<SessionInfo>(`/sessions/${sessionId}`);
}

export interface ChatResponse {
  reply: string;
  spend: number;
  budget: number;
  // null when session has no scenario; otherwise the remaining game-mechanic
  // tokens AFTER this call's deduction.
  scenarioTokensRemaining: number | null;
}

export interface ChatError {
  // "budget_exhausted" | "token_budget_exhausted" | ...
  error: string;
  message: string;
  spend?: number;
  budget?: number;
  scenarioTokensRemaining?: number | null;
}

/** Throws on network error; returns ChatError shape on 402 (caller must handle). */
export async function sendChat(
  sessionId: string,
  prompt: string,
): Promise<ChatResponse | ChatError> {
  const res = await fetch(`${SERVER_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, prompt }),
  });
  return res.json() as Promise<ChatResponse | ChatError>;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

export async function listFiles(
  sessionId: string,
  path: string,
): Promise<FileEntry[]> {
  const params = new URLSearchParams({ sessionId, path });
  const data = await apiFetch<{ entries: FileEntry[] }>(`/files?${params.toString()}`);
  return data.entries;
}

export async function readFile(sessionId: string, path: string): Promise<string> {
  const params = new URLSearchParams({ sessionId, path });
  const data = await apiFetch<{ content: string }>(`/file?${params.toString()}`);
  return data.content;
}

export async function writeFile(
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  await apiFetch("/file", {
    method: "PUT",
    body: JSON.stringify({ sessionId, path, content }),
  });
}

// ── Data Explorer (in-sandbox SQLite query) ─────────────────────────────────

export type QueryOk = {
  status: "ok";
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
  // Live compute-minutes balance after this query's deduction; null when no
  // scenario is bound. Lets the HUD update without a separate poll.
  scenarioComputeRemaining: number | null;
};

export type QueryError = {
  status: "error";
  error: string;
  durationMs: number;
  scenarioComputeRemaining: number | null;
};

export type QueryResult = QueryOk | QueryError;

export async function runQuery(
  sessionId: string,
  sql: string,
): Promise<QueryResult> {
  return apiFetch<QueryResult>(`/api/sessions/${sessionId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
}

// ── Scenario docs ───────────────────────────────────────────────────────────

export interface ScenarioDoc {
  id: string;
  title: string;
  body: string;
}

export async function listScenarioDocs(sessionId: string): Promise<ScenarioDoc[]> {
  const data = await apiFetch<{ docs: ScenarioDoc[] }>(
    `/api/sessions/${sessionId}/docs`,
  );
  return data.docs;
}

export async function recordDocView(sessionId: string, docId: string): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/docs/${encodeURIComponent(docId)}/view`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// ── Deliverable ─────────────────────────────────────────────────────────────

export async function getDeliverable(sessionId: string): Promise<Deliverable | null> {
  const data = await apiFetch<{ deliverable: Deliverable | null }>(
    `/api/sessions/${sessionId}/deliverable`,
  );
  return data.deliverable;
}

export async function saveDeliverable(
  sessionId: string,
  body: { status: DeliverableStatus; data: DeliverableData },
): Promise<Deliverable> {
  const res = await apiFetch<{ deliverable: Deliverable }>(
    `/api/sessions/${sessionId}/deliverable`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return res.deliverable;
}

// ── Recruiter review ────────────────────────────────────────────────────────

export interface ReviewSession {
  id: string;
  status: string;
  end_reason: string | null;
  model: string | null;
  created_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  spend_usd: number | string;
  event_count: number;
  messages: number;
  file_saves: number;
  // Null when the session has no scenario or hasn't been evaluated yet.
  overall_score: number | null;
  evaluation_status: "complete" | "error" | null;
}

export async function listReviewSessions(): Promise<ReviewSession[]> {
  const data = await apiFetch<{ sessions: ReviewSession[] }>("/api/review/sessions");
  return data.sessions;
}

// ── Session detail bundle ───────────────────────────────────────────────────

export interface ReviewSessionFull {
  id: string;
  status: string;
  end_reason: string | null;
  sandbox_id: string | null;
  template: string | null;
  litellm_key_alias: string | null;
  model: string | null;
  budget_usd: number | string;
  spend_usd: number | string;
  timeout_min: number;
  deadline: string;
  ended_at: string | null;
  duration_ms: number | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
}

export interface ReviewEvent {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  actor: string;
  ts: string;
  payload: Record<string, unknown>;
}

export interface ReviewTranscriptRow {
  id: string;
  seq: number;
  role: "system" | "user" | "assistant";
  content: string;
  ts: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | string | null;
  latency_ms: number | null;
  finish_reason: string | null;
  litellm_call_id: string | null;
}

export interface ReviewFileSnapshot {
  id: string;
  ts: string;
  path: string;
  content: string | null;
  action: string;
  size_bytes: number | null;
  content_hash: string | null;
}

export interface ReviewCostRow {
  id: string;
  ts: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | string;
  cumulative_spend_usd: number | string | null;
  litellm_call_id: string | null;
  transcript_id: string | null;
}

export interface ReviewEvaluationItem {
  competency: string;             // e.g. "data_fluency"
  score: number;                  // integer 1-5
  weight: number;                 // 0..1, from scenarios.rubric
  rationale: string;
  evidence: Array<{ event_seq: number; note: string }>;
  created_at: string;
}

export interface ReviewEvaluation {
  id: string;
  session_id: string;
  scenario_id: string | null;
  overall_score: number | string; // numeric in pg; supabase-js sometimes returns string
  summary: string | null;
  model: string | null;
  status: "complete" | "error";
  created_at: string;
  items: ReviewEvaluationItem[];
}

export interface ReviewSessionDetail {
  session: ReviewSessionFull;
  events: ReviewEvent[];
  transcript: ReviewTranscriptRow[];
  fileSnapshots: ReviewFileSnapshot[];
  cost: ReviewCostRow[];
  evaluation: ReviewEvaluation | null;
}

/** Trigger the Analysis Agent to (re)evaluate a completed session. Replaces
 *  any prior evaluation for the session_id. Returns the new evaluation row
 *  but callers usually want to refetch the full detail too — the analysis
 *  also emits an ai.evaluation event that the timeline should pick up. */
export async function postEvaluate(sessionId: string): Promise<unknown> {
  // Fastify rejects empty payloads when Content-Type is application/json;
  // send "{}" explicitly. The route ignores the body.
  const res = await fetch(`${SERVER_URL}/api/review/sessions/${sessionId}/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Re-evaluate failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export async function getReviewSessionDetail(id: string): Promise<ReviewSessionDetail> {
  const res = await fetch(`${SERVER_URL}/api/review/sessions/${id}`);
  if (res.status === 404) throw new NotFoundError("Session not found");
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<ReviewSessionDetail>;
}
