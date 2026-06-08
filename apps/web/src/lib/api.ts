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

export async function createSession(): Promise<{ sessionId: string; deadline: string }> {
  return apiFetch("/sessions", { method: "POST" });
}

export interface SessionInfo {
  sessionId: string;
  deadline: string;
  budget: number;
  spend: number;
  status: "active" | "completed";
}

export async function getSession(sessionId: string): Promise<SessionInfo> {
  return apiFetch<SessionInfo>(`/sessions/${sessionId}`);
}

export interface ChatResponse {
  reply: string;
  spend: number;
  budget: number;
}

export interface ChatError {
  error: string;
  message: string;
  spend?: number;
  budget?: number;
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

export interface ReviewSessionDetail {
  session: ReviewSessionFull;
  events: ReviewEvent[];
  transcript: ReviewTranscriptRow[];
  fileSnapshots: ReviewFileSnapshot[];
  cost: ReviewCostRow[];
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
