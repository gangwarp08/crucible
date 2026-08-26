// Shared session-driver layer for the robustness harness.
//
// Generalizes the create/auth/WS/query/deliverable helpers that
// sim-fde-realistic.ts and verify-pro-discrimination.ts each copy inline, so
// the persona-driven candidate agent can drive ANY scenario (looked up by
// slug) rather than the single hard-coded fde-db-triage-pro.
//
// Nothing here changes server behavior — it only talks to the same public
// endpoints those scripts already use. Budget/timeout/detector logic is
// untouched (CLAUDE.md Hard Rules 4–7).

import { config as loadEnv } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";
import WS from "ws";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../..");
loadEnv({ path: resolve(REPO_ROOT, ".env") });

export const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF
    ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`
    : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Null when Supabase creds are absent — callers use this to SKIP cleanly
 *  (mirrors family2-harness.ts guard) instead of throwing at import time. */
export const supabase: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        realtime: { transport: WebSocket as any },
      })
    : null;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry a transient-failure-prone call (network blips, 503 capacity, and
 *  short host outages such as a laptop briefly sleeping). Only retries errors
 *  whose message looks transient — never a real 4xx/logic error. Backoff grows
 *  to ~30s so a multi-minute blip is ridden out rather than failing the run. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 7): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = (e as Error)?.message ?? "";
      if (!/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|network|\b50[023]\b|429/i.test(msg)) throw e;
      await sleep(Math.min(30_000, 2000 * (i + 1)) + 500);
    }
  }
  throw lastErr;
}

// ─── Per-session auth tokens (minted on POST /sessions) ─────────────────────

const tokens = new Map<string, string>();
export function authHeaders(sessionId: string): Record<string, string> {
  const t = tokens.get(sessionId);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// ─── Scenario lookup + session bootstrap ────────────────────────────────────

export interface DeliverableComponent {
  key: string;
  label: string;
  what?: string;
}

/** Candidate-visible session state returned by GET /sessions/:id. This is the
 *  exact context a real candidate's UI has — brief, deliverable field keys,
 *  dataset table names, persona headers — so it's what we hand the agent. */
export interface SessionBootstrap {
  scenarioTitle: string | null;
  scenarioBrief: string | null;
  scenarioDifficulty: string | null;
  deliverableComponents: DeliverableComponent[] | null;
  datasetTables: string[] | null;
  datasetKind: string | null; // "sqlite" | "git_repo" | null
  clientPersona: { name?: string; role?: string } | null;
  teamPersona: { name?: string; role?: string } | null;
  scenarioConstraints: Record<string, number | null> | null;
}

export async function getScenarioIdBySlug(slug: string): Promise<string> {
  if (!supabase) throw new Error("supabase unavailable");
  const { data, error } = await supabase
    .from("scenarios").select("id").eq("slug", slug).single();
  if (error || !data) throw new Error(`could not load scenario ${slug}: ${error?.message}`);
  return (data as { id: string }).id;
}

/** Mint a single-use session link owned by an org (via its X-Org-Key). A
 *  session started from this link inherits the org, so all synthetic sessions
 *  land under the dedicated robustness org — visible to that org's review key
 *  and to admin, and kept out of the default asaya tenant. */
export async function mintSessionLink(
  orgKey: string,
  candidateLabel: string,
  scenarioId?: string,
): Promise<string> {
  const body: Record<string, unknown> = { candidateLabel };
  if (scenarioId) body.scenarioId = scenarioId;
  const r = await fetch(`${SERVER_URL}/api/review/session-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Org-Key": orgKey },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`session-link mint failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { token: string };
  return j.token;
}

export async function createSession(
  scenarioId: string,
  opts: { beatTimingOverridesMs?: Record<string, number>; linkToken?: string } = {},
): Promise<{ sessionId: string; token: string | null }> {
  const body: Record<string, unknown> = { scenarioId };
  if (opts.beatTimingOverridesMs) body.beatTimingOverridesMs = opts.beatTimingOverridesMs;
  if (opts.linkToken) body.linkToken = opts.linkToken;
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { sessionId: string; token?: string };
  if (j.token) tokens.set(j.sessionId, j.token);
  return { sessionId: j.sessionId, token: j.token ?? null };
}

/** Arm the deferred work clock (candidate dismisses the orientation overlay).
 *  Idempotent server-side. This is what makes accrued time count as real
 *  "active minutes" against the scorability floor. */
export async function startClock(sessionId: string): Promise<void> {
  await fetch(`${SERVER_URL}/sessions/${sessionId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: "{}",
  }).catch(() => {});
}

export async function fetchBootstrap(sessionId: string): Promise<SessionBootstrap | null> {
  const r = await fetch(`${SERVER_URL}/sessions/${sessionId}`, {
    headers: authHeaders(sessionId),
  });
  if (!r.ok) return null;
  return (await r.json()) as SessionBootstrap;
}

// ─── Candidate actions (map 1:1 to endpoints) ───────────────────────────────

export interface QueryResult {
  status?: string;
  columns?: string[];
  rows?: unknown[][];
  error?: string;
  scenarioComputeRemaining?: number | null;
  http?: number;
}

export async function runSql(sessionId: string, sql: string): Promise<QueryResult> {
  const r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ sql }),
  });
  const http = r.status;
  let j: QueryResult = {};
  try { j = (await r.json()) as QueryResult; } catch { /* non-JSON */ }
  return { ...j, http };
}

export async function viewDoc(sessionId: string, docId: string): Promise<void> {
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/docs/${docId}/view`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: "{}",
  }).catch(() => {});
}

export interface ChatResult { reply: string | null; budgetExhausted: boolean; http: number }

export async function aiAssist(sessionId: string, prompt: string): Promise<ChatResult> {
  try {
    const r = await fetch(`${SERVER_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
      body: JSON.stringify({ sessionId, prompt }),
    });
    const http = r.status;
    if (http === 402) return { reply: null, budgetExhausted: true, http };
    const j = (await r.json().catch(() => ({}))) as { reply?: string };
    return { reply: j.reply ?? null, budgetExhausted: false, http };
  } catch {
    return { reply: null, budgetExhausted: false, http: 0 };
  }
}

export async function readFile(sessionId: string, path: string): Promise<string | null> {
  const url = `${SERVER_URL}/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
  const r = await fetch(url, { headers: authHeaders(sessionId) });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { content?: string };
  return j.content ?? null;
}

export async function listFiles(sessionId: string, path: string): Promise<string | null> {
  const url = `${SERVER_URL}/files?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
  const r = await fetch(url, { headers: authHeaders(sessionId) });
  if (!r.ok) return null;
  return await r.text();
}

export async function writeFile(sessionId: string, path: string, content: string): Promise<boolean> {
  const r = await fetch(`${SERVER_URL}/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ sessionId, path, content }),
  });
  return r.ok;
}

export async function submitDeliverable(
  sessionId: string,
  data: Record<string, string>,
): Promise<boolean> {
  const r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ status: "submitted", data }),
  });
  return r.ok;
}

export async function endSession(sessionId: string): Promise<void> {
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, {
    method: "DELETE",
    headers: authHeaders(sessionId),
  }).catch(() => {});
}

// ─── Messaging WS (persistent MessageBus, from the existing scripts) ─────────

export interface PersonaMsg {
  channel: "client" | "team";
  role: "persona";
  persona_name: string;
  text: string;
  ts: string;
}
interface ErrMsg { type: "error"; code: string; message: string }
type Inbound = PersonaMsg | ErrMsg;

export interface MessageBus {
  ws: WS;
  buffer: PersonaMsg[];
  waiters: Array<{
    predicate: (m: PersonaMsg) => boolean;
    resolve: (m: PersonaMsg) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>;
  closed: boolean;
}

export function openMessagingWs(sessionId: string): Promise<MessageBus> {
  const wsBase = SERVER_URL.replace(/^http/, "ws");
  return new Promise((resolveOpen, rejectOpen) => {
    const token = tokens.get(sessionId);
    const protocols = token ? [`bearer.${token}`] : undefined;
    const ws = new WS(`${wsBase}/messages/${sessionId}`, protocols);
    const bus: MessageBus = { ws, buffer: [], waiters: [], closed: false };
    ws.on("message", (raw: WS.RawData) => {
      let parsed: Inbound;
      try { parsed = JSON.parse(raw.toString()) as Inbound; } catch { return; }
      if ((parsed as ErrMsg).type === "error") {
        const err = new Error(`server error: ${(parsed as ErrMsg).message}`);
        for (const w of bus.waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
        return;
      }
      const msg = parsed as PersonaMsg;
      for (let i = 0; i < bus.waiters.length; i++) {
        const w = bus.waiters[i]!;
        if (w.predicate(msg)) {
          bus.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
      }
      bus.buffer.push(msg);
    });
    ws.once("open", () => resolveOpen(bus));
    ws.once("error", (err) => rejectOpen(err));
    ws.once("close", () => { bus.closed = true; });
  });
}

export function sendClient(bus: MessageBus, text: string): void {
  bus.ws.send(JSON.stringify({ channel: "client", text }));
}
export function sendTeam(bus: MessageBus, text: string): void {
  bus.ws.send(JSON.stringify({ channel: "team", text }));
}
export function drainBuffered(bus: MessageBus): PersonaMsg[] {
  return bus.buffer.splice(0);
}
export function closeBus(bus: MessageBus): void {
  for (const w of bus.waiters.splice(0)) {
    clearTimeout(w.timer);
    w.reject(new Error("bus closed"));
  }
  bus.ws.close();
}

/** Wait up to timeoutMs for a persona message matching predicate; resolves
 *  null on timeout rather than throwing (agent loop tolerates silence). */
export function awaitMsg(
  bus: MessageBus,
  predicate: (msg: PersonaMsg) => boolean,
  timeoutMs: number,
): Promise<PersonaMsg | null> {
  return new Promise((resolveAw) => {
    for (let i = 0; i < bus.buffer.length; i++) {
      const msg = bus.buffer[i]!;
      if (predicate(msg)) { bus.buffer.splice(i, 1); resolveAw(msg); return; }
    }
    const waiter: MessageBus["waiters"][number] = {
      predicate,
      resolve: resolveAw,
      reject: () => resolveAw(null),
      timer: setTimeout(() => {
        const idx = bus.waiters.indexOf(waiter);
        if (idx >= 0) bus.waiters.splice(idx, 1);
        resolveAw(null);
      }, timeoutMs),
    };
    bus.waiters.push(waiter);
  });
}

// ─── Telemetry readback (duration, scorability, evaluation) ──────────────────

export interface SessionRow {
  id: string;
  status: string | null;
  end_reason: string | null;
  duration_ms: number | null;
  spend_usd: number | null;
  scorable: boolean | null;
  exclusion_reason: string | null;
  created_at: string | null;
  ended_at: string | null;
}

export async function fetchSessionRow(sessionId: string): Promise<SessionRow | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from("sessions")
    .select("id, status, end_reason, duration_ms, spend_usd, scorable, exclusion_reason, created_at, ended_at")
    .eq("id", sessionId)
    .maybeSingle();
  return (data as SessionRow | null) ?? null;
}

export interface EvalItem { competency: string; score: number | null; weight: number; rationale: string }
export interface EvalRow {
  id: string;
  overall_score: number | null;
  status: string;
  items: EvalItem[];
}

export async function fetchEval(sessionId: string): Promise<EvalRow | null> {
  if (!supabase) return null;
  const { data: row } = await supabase
    .from("evaluations")
    .select("id, overall_score, status")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row) return null;
  const r = row as { id: string; overall_score: number | string | null; status: string };
  const { data: items } = await supabase
    .from("evaluation_items")
    .select("competency, score, weight, rationale")
    .eq("evaluation_id", r.id);
  return {
    id: r.id,
    overall_score: r.overall_score == null ? null : Number(r.overall_score),
    status: r.status,
    items: (items ?? []).map((it) => {
      const x = it as { competency: string; score: number | string | null; weight: number | string; rationale: string };
      return {
        competency: x.competency,
        score: x.score == null ? null : Number(x.score),
        weight: Number(x.weight),
        rationale: x.rationale,
      };
    }),
  };
}

export async function pollForEval(sessionId: string, timeoutMs: number): Promise<EvalRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const got = await fetchEval(sessionId);
    if (got && got.status === "complete") return got;
  }
  return await fetchEval(sessionId);
}

/** Sum of today's LiteLLM-attributed spend from cost_ledger — used by the
 *  orchestrator's wallet cap to know how much of the budget is already gone. */
export async function fetchTodaySpendUsd(): Promise<number | null> {
  if (!supabase) return null;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from("cost_ledger")
    .select("cost_usd, ts")
    .gte("ts", since);
  if (!data) return null;
  return (data as Array<{ cost_usd: number | string }>).reduce(
    (a, r) => a + Number(r.cost_usd ?? 0), 0,
  );
}
