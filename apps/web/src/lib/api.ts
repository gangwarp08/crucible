// All calls go to our own Fastify server — never to LiteLLM / E2B / Supabase directly.
export const SERVER_URL = process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:3001";

// Per-session JWT minted on POST /sessions. Stored in sessionStorage so it
// survives a tab refresh but not a tab close (a closed-tab candidate has to
// re-enter the invite code anyway — better than localStorage where an XSS
// could lift the token). Key includes the sessionId so concurrent sessions
// in different tabs don't trample each other.
const TOKEN_KEY_PREFIX = "crucible.session.token.";

function tokenKey(sessionId: string): string { return `${TOKEN_KEY_PREFIX}${sessionId}`; }

export function storeSessionToken(sessionId: string, token: string): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(tokenKey(sessionId), token); } catch { /* ignore */ }
}

export function getSessionToken(sessionId: string): string | null {
  if (typeof window === "undefined") return null;
  try { return window.sessionStorage.getItem(tokenKey(sessionId)); } catch { return null; }
}

/** Build `Authorization: Bearer <token>` for a given session. Returns an empty
 *  object when no token is stored — callers don't need to special-case. */
function authHeader(sessionId: string | null | undefined): Record<string, string> {
  if (!sessionId) return {};
  const token = getSessionToken(sessionId);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface ApiFetchOpts extends RequestInit {
  /** Session ID to look up the bearer token for. Omit for unauthenticated
   *  calls (e.g. POST /sessions, GET /api/scenarios). */
  sessionId?: string;
}

async function apiFetch<T>(path: string, init?: ApiFetchOpts): Promise<T> {
  const { sessionId, ...rest } = init ?? {};
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...rest,
    headers: {
      ...(rest.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...authHeader(sessionId),
      ...rest.headers,
    },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface CreateSessionResult {
  sessionId: string;
  deadline: string;
  scenarioId: string | null;
  /** Per-session JWT — must be sent as `Authorization: Bearer …` on every
   *  protected route, and as the `bearer.<token>` subprotocol on every WS
   *  connection. Stored automatically by createSession into sessionStorage. */
  token: string;
}

export async function createSession(
  opts?: { scenarioId?: string; inviteCode?: string },
): Promise<CreateSessionResult> {
  const body: Record<string, string> = {};
  if (opts?.scenarioId) body["scenarioId"] = opts.scenarioId;
  if (opts?.inviteCode) body["inviteCode"] = opts.inviteCode;
  const init: ApiFetchOpts = { method: "POST" };
  if (Object.keys(body).length > 0) {
    init.body = JSON.stringify(body);
  }
  try {
    const result = await apiFetch<CreateSessionResult>("/sessions", init);
    storeSessionToken(result.sessionId, result.token);
    return result;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("API error 401")) {
      throw new Error("Invalid invite code");
    }
    throw err;
  }
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
  status: "active" | "submitted" | "defending" | "completed";
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

export class ScenarioInviteRequiredError extends Error {
  constructor(slug: string) {
    super(`Scenario "${slug}" requires an invite code`);
    this.name = "ScenarioInviteRequiredError";
  }
}

/** Fetch a scenario's candidate-safe metadata (brief, constraints, deliverable
 *  components). Pass `inviteCode` if the server's INVITE_CODE gate is on; the
 *  Start screen probes once without one and only prompts the candidate if a
 *  401 comes back (so dev/preview without INVITE_CODE keeps zero-friction UX).
 *
 *  Throws ScenarioNotFoundError on 404, ScenarioInviteRequiredError on 401,
 *  generic Error on anything else. */
export async function getScenarioBySlug(
  slug: string,
  inviteCode?: string,
): Promise<Scenario> {
  const headers: Record<string, string> = {};
  if (inviteCode) headers["X-Invite-Code"] = inviteCode;
  const res = await fetch(`${SERVER_URL}/api/scenarios/${encodeURIComponent(slug)}`, { headers });
  if (res.status === 404) throw new ScenarioNotFoundError(slug);
  if (res.status === 401) throw new ScenarioInviteRequiredError(slug);
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Scenario>;
}

export interface ScenarioCatalogItem {
  slug:       string;
  title:      string;
  role:       string;
  difficulty: string | null;
  created_at: string;
}
/** Public catalog list. Returns minimal metadata only (no brief / no
 *  rubric); per-scenario detail still requires the invite code via
 *  getScenarioBySlug. */
export async function listScenarios(): Promise<ScenarioCatalogItem[]> {
  const res = await fetch(`${SERVER_URL}/api/scenarios`);
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { scenarios: ScenarioCatalogItem[] };
  return body.scenarios;
}

export async function getSession(sessionId: string): Promise<SessionInfo> {
  return apiFetch<SessionInfo>(`/sessions/${sessionId}`, { sessionId });
}

/** Manual session end. The server runs the shared teardown + auto-eval. */
export async function endSession(sessionId: string): Promise<void> {
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${getSessionToken(sessionId) ?? ""}` },
  });
}

export interface MessageHistoryItem {
  channel: "client" | "team";
  role: "candidate" | "persona";
  persona_name: string | null;
  text: string;
  ts: string;
}
/** Hydrate the workspace messaging panes after a refresh. Returns the
 *  persisted candidate + persona messages across both channels, ordered
 *  oldest → newest. */
export async function getMessageHistory(
  sessionId: string,
): Promise<MessageHistoryItem[]> {
  const r = await apiFetch<{ messages: MessageHistoryItem[] }>(
    `/api/sessions/${sessionId}/messages`,
    { sessionId },
  );
  return r.messages;
}

export interface AssistantHistoryItem {
  role: "user" | "assistant";
  text: string;
}
/** Hydrate the AI assistant pane after a refresh. Returns persisted
 *  user + assistant turns from the transcript table in chronological order.
 *  System rows are excluded server-side so they don't surface to the UI. */
export async function getAssistantHistory(
  sessionId: string,
): Promise<AssistantHistoryItem[]> {
  const r = await apiFetch<{ messages: AssistantHistoryItem[] }>(
    `/api/sessions/${sessionId}/transcript`,
    { sessionId },
  );
  return r.messages;
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
    headers: {
      "Content-Type": "application/json",
      ...authHeader(sessionId),
    },
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
  const data = await apiFetch<{ entries: FileEntry[] }>(`/files?${params.toString()}`, { sessionId });
  return data.entries;
}

export async function readFile(sessionId: string, path: string): Promise<string> {
  const params = new URLSearchParams({ sessionId, path });
  const data = await apiFetch<{ content: string }>(`/file?${params.toString()}`, { sessionId });
  return data.content;
}

export async function writeFile(
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  await apiFetch("/file", {
    method: "PUT",
    sessionId,
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
    sessionId,
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
    { sessionId },
  );
  return data.docs;
}

export async function recordDocView(sessionId: string, docId: string): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/docs/${encodeURIComponent(docId)}/view`, {
    method: "POST",
    sessionId,
    body: JSON.stringify({}),
  });
}

// ── Deliverable ─────────────────────────────────────────────────────────────

export async function getDeliverable(sessionId: string): Promise<Deliverable | null> {
  const data = await apiFetch<{ deliverable: Deliverable | null }>(
    `/api/sessions/${sessionId}/deliverable`,
    { sessionId },
  );
  return data.deliverable;
}

export async function saveDeliverable(
  sessionId: string,
  body: { status: DeliverableStatus; data: DeliverableData },
): Promise<Deliverable> {
  const res = await apiFetch<{ deliverable: Deliverable }>(
    `/api/sessions/${sessionId}/deliverable`,
    { method: "POST", sessionId, body: JSON.stringify(body) },
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
  // Lifecycle / verification / scorability (Slice 6.1–6.4). Present once 0014 ran.
  defense_outcome?: string | null;          // coherent | weak | declined | not_reached
  verification_cap_status?: string | null;  // none | applied | advisory_pending | confirmed | overridden
  scorable?: boolean | null;                // RD3: in the validity dataset?
  exclusion_reason?: string | null;         // excluded_infra | excluded_abandoned | ...
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
  score: number | null;           // integer 1-5, or null when not_assessed (RD4)
  assessed?: boolean;             // false → scenario surfaced no evidence; score is null
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

/** RD2 (Slice 6.3): a reviewer resolves an advisory verification cap.
 *  confirm → caps execution + recomputes overall; override → leaves it. */
export async function postVerificationCap(
  sessionId: string,
  decision: "confirm" | "override",
): Promise<{ verification_cap_status: string; execution_score?: number; overall_score?: number }> {
  const res = await fetch(`${SERVER_URL}/api/review/sessions/${sessionId}/verification-cap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Verification cap ${decision} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<{ verification_cap_status: string; execution_score?: number; overall_score?: number }>;
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

// ─── Partner outcome-invite links ───────────────────────────────────────────
// Admin generates a per-session link (open /api/review routes); the partner
// opens <origin>/feedback/<token> and submits outcomes (token-gated /api routes).

export type OutcomeInviteStatus = "active" | "submitted" | "expired" | "revoked";

export interface OutcomeInviteSummary {
  id: string;
  session_id: string;
  outcome_types: string[];
  expires_at: string;
  submitted_at: string | null;
  status: OutcomeInviteStatus;
}

export async function generateOutcomeInvite(
  sessionId: string,
  outcomeTypes?: string[],
): Promise<{ token: string; invite: OutcomeInviteSummary }> {
  const res = await fetch(`${SERVER_URL}/api/review/sessions/${sessionId}/outcome-invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(outcomeTypes ? { outcome_types: outcomeTypes } : {}),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ token: string; invite: OutcomeInviteSummary }>;
}

export async function listOutcomeInvites(sessionId: string): Promise<OutcomeInviteSummary[]> {
  const res = await fetch(`${SERVER_URL}/api/review/sessions/${sessionId}/outcome-invites`);
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { invites: OutcomeInviteSummary[] };
  return json.invites;
}

export async function revokeOutcomeInvite(inviteId: string): Promise<OutcomeInviteSummary> {
  const res = await fetch(`${SERVER_URL}/api/review/outcome-invites/${inviteId}/revoke`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { invite: OutcomeInviteSummary };
  return json.invite;
}

export interface OutcomeInviteContext {
  status: OutcomeInviteStatus;
  session_id: string;
  scenario_title: string | null;
  outcome_types: string[];
  expires_at: string;
}

export async function getOutcomeInvite(token: string): Promise<OutcomeInviteContext> {
  const res = await fetch(`${SERVER_URL}/api/outcome-invites/${encodeURIComponent(token)}`);
  if (res.status === 404) throw new NotFoundError("This feedback link is invalid or no longer exists.");
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<OutcomeInviteContext>;
}

export async function submitOutcomeInvite(
  token: string,
  values: Record<string, boolean | number>,
  candidateRef?: string,
): Promise<{ written: string[]; status: OutcomeInviteStatus }> {
  const res = await fetch(`${SERVER_URL}/api/outcome-invites/${encodeURIComponent(token)}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values, ...(candidateRef ? { candidate_ref: candidateRef } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<{ written: string[]; status: OutcomeInviteStatus }>;
}

// ─── "Talk to us" contact + call booking (marketing site) ───────────────────
// Slots are anonymous { start, end } windows derived server-side from the
// founder's calendar free/busy — no event details ever reach the browser.

export interface ContactSlot {
  start: string; // ISO datetime
  end: string;   // ISO datetime
}

export interface ContactSlotsResult {
  configured: boolean;
  timezone: string; // IANA tz the slots should be rendered in (e.g. America/New_York)
  slots: ContactSlot[];
}

export async function getContactSlots(): Promise<ContactSlotsResult> {
  return apiFetch<ContactSlotsResult>("/api/contact/slots");
}

export interface BookContactInput {
  name: string;
  email: string;
  query: string;
  /** ISO datetime of the chosen slot's start. Omit to send the note as an
   *  email instead of booking a call (interim mode). */
  slotStart?: string;
}

/** Thrown by bookContact when the chosen slot was booked out from under the
 *  visitor (server returned 409 slot_taken) — refetch slots and re-pick. */
export class SlotTakenError extends Error {
  constructor() {
    super("That slot was just taken");
    this.name = "SlotTakenError";
  }
}

export async function bookContact(input: BookContactInput): Promise<{ ok: boolean }> {
  try {
    return await apiFetch<{ ok: boolean }>("/api/contact", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("API error 409")) {
      throw new SlotTakenError();
    }
    throw err;
  }
}

// ─── Captured outcomes for a session (review page) ──────────────────────────
export interface SessionOutcome {
  outcome_type: string;
  value: boolean | number | null;
  source: string;
  captured_at: string;
}

export async function listSessionOutcomes(sessionId: string): Promise<SessionOutcome[]> {
  const res = await fetch(`${SERVER_URL}/api/review/sessions/${sessionId}/outcomes`);
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { outcomes: SessionOutcome[] };
  return body.outcomes;
}
