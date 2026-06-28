// Calibration step 3 — judge anchor tuning verifier.
//
// After updating the global SYSTEM_PROMPT (services/analysis-agent.ts) and
// the fde-db-triage rubric anchors (fixtures/fde-db-triage/scenario.json,
// pushed via scripts/encode-fde-db-triage.ts), this verifier:
//
//   PHASE 1 — re-evaluates the 5 prior calibration sessions in place. The
//             POST /api/review/sessions/:id/evaluate route does
//             delete-then-insert, so session_id is stable and the new
//             evaluation replaces the old one.
//
//   PHASE 2 — runs ONE fresh held-out PROFILE D: "found bug + correct
//             figures + terse/rude with the client + ignored Sam". D
//             was NOT part of the anchor-tuning vocabulary, so a clean
//             profile match confirms generalization rather than overfit.
//
//   PHASE 3 — 6-column report (STRONG, WEAK, A, B, C, D) with the same
//             INDEPENDENCE / GRADIENT / ORDERING / BINARITY assessments
//             as step 2, plus a D-specific independence check.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-anchor-tuning.ts
//
// Env overrides:
//   BASELINE_{STRONG,WEAK,A,B,C}_ID    session-id to re-evaluate
//   SKIP_REEVAL=1                       skip phase 1 (just refresh + run D)
//   SKIP_D=1                            skip phase 2 (re-eval only, no D)

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";
import WS from "ws";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF
    ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`
    : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const SLUG = "fde-db-triage";

// Per-session JWTs minted on POST /sessions. createSession stashes them here;
// every session-scoped HTTP call attaches `Authorization: Bearer <token>` and
// WS connections use `bearer.<token>` as a subprotocol.
const tokens = new Map<string, string>();
function authHeaders(sessionId: string): Record<string, string> {
  const t = tokens.get(sessionId);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

const BASELINE_STRONG_ID = process.env.BASELINE_STRONG_ID ?? "b6a45922-822e-4737-96e1-eee188823608";
const BASELINE_WEAK_ID   = process.env.BASELINE_WEAK_ID   ?? "9d91776c-5efd-4887-a02d-4d5a06376f71";
const BASELINE_A_ID      = process.env.BASELINE_A_ID      ?? "73cf7977-6eff-4b77-bcb9-f4cea584b573";
const BASELINE_B_ID      = process.env.BASELINE_B_ID      ?? "a3bf4248-722d-4f20-a7aa-0b9b80c4ad6d";
const BASELINE_C_ID      = process.env.BASELINE_C_ID      ?? "2f1fa83b-e2f0-4441-af50-16225814d020";

const SKIP_REEVAL = process.env.SKIP_REEVAL === "1";
const SKIP_D      = process.env.SKIP_D === "1";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function isQuotaError(message: string): boolean {
  return /RateLimitError|RESOURCE_EXHAUSTED|quota|429/i.test(message);
}

// ─── WS helpers (persistent MessageBus — same shape as verify-gradient.ts) ─

interface PersonaMsg {
  channel: "client" | "team";
  role: "persona";
  persona_name: string;
  text: string;
  ts: string;
}
interface ErrMsg { type: "error"; code: string; message: string }
type Inbound = PersonaMsg | ErrMsg;

interface MessageBus {
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

function openMessagingWs(sessionId: string): Promise<MessageBus> {
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

function sendBus(bus: MessageBus, raw: string): void { bus.ws.send(raw); }
function closeBus(bus: MessageBus): void {
  for (const w of bus.waiters.splice(0)) {
    clearTimeout(w.timer);
    w.reject(new Error("bus closed"));
  }
  bus.ws.close();
}

function awaitMsg(
  bus: MessageBus,
  predicate: (msg: PersonaMsg) => boolean,
  timeoutMs: number,
  what: string,
): Promise<PersonaMsg> {
  return new Promise((resolveAw, rejectAw) => {
    for (let i = 0; i < bus.buffer.length; i++) {
      const msg = bus.buffer[i]!;
      if (predicate(msg)) { bus.buffer.splice(i, 1); resolveAw(msg); return; }
    }
    const waiter: MessageBus["waiters"][number] = {
      predicate, resolve: resolveAw, reject: rejectAw,
      timer: setTimeout(() => {
        const idx = bus.waiters.indexOf(waiter);
        if (idx >= 0) bus.waiters.splice(idx, 1);
        rejectAw(new Error(`timeout (${timeoutMs}ms) waiting for ${what}`));
      }, timeoutMs),
    };
    bus.waiters.push(waiter);
  });
}

// ─── Ground truth ──────────────────────────────────────────────────────────

interface GroundTruth {
  reporting_window: string[];
  naive_monthly_cents: Record<string, number>;
  corrected_monthly_cents: Record<string, number>;
  overstatement_cents: number;
}
const repoRoot = resolve(here, "../../..");
const ground = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/ground_truth.json"), "utf8"),
) as GroundTruth;

function fmtUsd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// ─── Eval shape ────────────────────────────────────────────────────────────

interface EvaluationItem {
  competency: string;
  score: number;
  weight: number;
  rationale: string;
}
interface EvaluationRow {
  id: string;
  overall_score: number;
  summary: string | null;
  status: "complete" | "error";
  items: EvaluationItem[];
}
interface PlayResult {
  label: string;
  sessionId: string;
  evaluation: EvaluationRow | null;
}

async function fetchEvalBySessionId(sessionId: string): Promise<EvaluationRow | null> {
  const { data: row } = await supabase
    .from("evaluations")
    .select("id, overall_score, summary, status")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row) return null;
  const r = row as { id: string; overall_score: number | string; summary: string | null; status: string };
  const { data: items } = await supabase
    .from("evaluation_items")
    .select("competency, score, weight, rationale")
    .eq("evaluation_id", r.id);
  return {
    id: r.id,
    overall_score: Number(r.overall_score),
    summary: r.summary,
    status: (r.status === "complete" ? "complete" : "error") as "complete" | "error",
    items: (items ?? []) as EvaluationItem[],
  };
}

async function pollForEval(sessionId: string, timeoutMs: number, sinceEvalId: string | null): Promise<EvaluationRow | null> {
  // Re-eval is delete-then-insert: the row's id CHANGES. Wait for an eval
  // with a different id than `sinceEvalId` (or any eval if sinceEvalId is null).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const got = await fetchEvalBySessionId(sessionId);
    if (got && got.id !== sinceEvalId) return got;
  }
  return null;
}

// ─── PHASE 1 — re-evaluate 5 prior sessions ────────────────────────────────

async function reEvaluate(label: string, sessionId: string): Promise<PlayResult> {
  const before = await fetchEvalBySessionId(sessionId);
  const beforeId = before?.id ?? null;
  console.log(`  [${label}] POST /api/review/sessions/${sessionId}/evaluate (prior=${beforeId?.slice(0, 8) ?? "none"})`);
  try {
    const res = await fetch(`${SERVER_URL}/api/review/sessions/${sessionId}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      const body = await res.text();
      if (isQuotaError(body)) {
        console.log(`  [${label}] SKIP — Gemini quota (HTTP ${res.status})`);
      } else {
        console.log(`  [${label}] HTTP ${res.status}: ${body.slice(0, 120)}`);
      }
    } else {
      const body = await res.json() as { evaluation_id?: string; overall_score?: number };
      console.log(`  [${label}] re-eval returned ${body.overall_score ?? "?"}/5 (new id=${body.evaluation_id?.slice(0, 8) ?? "?"})`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [${label}] re-eval threw: ${msg.slice(0, 120)}`);
  }
  // Poll until the row's id changes (re-eval is delete+insert).
  const fresh = await pollForEval(sessionId, 30_000, beforeId);
  return { label, sessionId, evaluation: fresh ?? before ?? null };
}

// ─── PHASE 2 — PROFILE D (held-out: technically right, actively rude) ─────

async function createSession(scenarioId: string, beats: Record<string, number>): Promise<string> {
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId, beatTimingOverridesMs: beats }),
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { sessionId: string; token?: string };
  if (body.token) tokens.set(body.sessionId, body.token);
  return body.sessionId;
}

async function runProfileD(scenarioId: string): Promise<PlayResult> {
  // Curveball at T+30s (same as B post-fix — gives the scheduler enough
  // sweeps before session end).
  const sessionId = await createSession(scenarioId, {
    misleading_teammate_hint: 3_000,
    requirement_change:       30_000,
  });
  console.log(`  [d] session ${sessionId} created (technically-right, actively-rude)`);
  const startedAt = Date.now();
  const bus = await openMessagingWs(sessionId);

  // [1] Sam proactive → curt one-liner ack instead of silence.
  try {
    const m = await awaitMsg(bus, (x) => x.channel === "team", 25_000, "Sam proactive");
    console.log(`  [d] Sam proactive (T+${Date.now() - startedAt}ms): "${m.text.slice(0, 60)}…"`);
    await sleep(2_000);
    sendBus(bus, JSON.stringify({ channel: "team", text: "noted, working it" }));
    console.log(`  [d] curt Sam ack sent (one-liner, no engagement)`);
  } catch (err) {
    console.log(`  [d] Sam proactive SKIP (${(err instanceof Error ? err.message : String(err)).slice(0, 60)})`);
  }

  await sleep(13_000);

  // [2] Dana asks → respond impatiently/rudely (no clarifying-Q manners).
  try {
    sendBus(bus, JSON.stringify({
      channel: "client",
      text: "looking at it, ping me with a specific question",
    }));
    const dana = await awaitMsg(bus, (x) => x.channel === "client" && !/leadership|board|3 months|paragraph/i.test(x.text), 60_000, "Dana reply");
    console.log(`  [d] Dana reply to curt msg: "${dana.text.slice(0, 60)}…"`);
  } catch (err) {
    console.log(`  [d] Dana reply SKIP (${(err instanceof Error ? err.message : String(err)).slice(0, 60)})`);
  }

  // [3] Skip docs intentionally (the technical work below is enough — no
  // schema reading; relies on memory). Mirrors "didn't bother with niceties".
  // [4] Technical: dedup + fingerprint (same as A — full correct figures).
  const dedupSql = `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) AS cents FROM payments p JOIN dedup d ON d.keep_id=p.id WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY substr(p.created_at,1,7) ORDER BY month`;
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ sql: dedupSql }),
  });
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ sql: "SELECT external_payment_id, COUNT(*) FROM payments WHERE status='succeeded' GROUP BY external_payment_id HAVING COUNT(*)>1 LIMIT 5" }),
  });
  console.log(`  [d] dedup CTE + duplicate fingerprint queries run (correct figures)`);

  // [5] Zero AI-assistant turns.

  // [6] Wait for curveball + respond curtly.
  try {
    console.log(`  [d] waiting up to 60s for Dana's curveball…`);
    const curve = await awaitMsg(
      bus,
      (x) => x.channel === "client" && /leadership|board|3 months|three months|paragraph/i.test(x.text),
      60_000,
      "Dana curveball",
    );
    console.log(`  [d] curveball received: "${curve.text.slice(0, 70)}…"`);
    await sleep(2_000);
    sendBus(bus, JSON.stringify({ channel: "client", text: "ack, figures coming" }));
    console.log(`  [d] curt curveball ack sent`);
  } catch (err) {
    console.log(`  [d] curveball SKIP (${(err instanceof Error ? err.message : String(err)).slice(0, 60)})`);
  }

  closeBus(bus);

  // [7] Submit deliverable: CORRECT figures + correct root cause + upstream
  // rec, but client_facing_summary is one rude/blunt sentence.
  const mar = ground.corrected_monthly_cents["2026-03"]!;
  const apr = ground.corrected_monthly_cents["2026-04"]!;
  const may = ground.corrected_monthly_cents["2026-05"]!;
  const deliv = {
    status: "submitted" as const,
    data: {
      corrected_monthly_revenue:
        `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) ` +
        `SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) FROM payments p JOIN dedup d ON d.keep_id=p.id ` +
        `WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1;\n\n` +
        `Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}.`,
      root_cause_finding:
        "Duplicate succeeded payments sharing external_payment_id, double-counted by the naive SUM. ~8% of Apr+May succeeded rows. Refunds and timezone bucketing ruled out.",
      // Deliberately rude/blunt — no warmth, no setup, no plain-English framing.
      client_facing_summary:
        `Numbers: Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}. Cause: duplicate webhook payments.`,
      decisions_and_tradeoffs:
        "Dedup by MIN(id) per external_payment_id where status='succeeded'. Recommend idempotency key on the Stripe webhook ingest path.",
    },
  };
  const dr = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify(deliv),
  });
  if (dr.ok) console.log(`  [d] deliverable submitted (correct figures, blunt summary)`);
  else console.log(`  [d] deliverable submit FAILED: ${dr.status}`);

  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...authHeaders(sessionId) } });
  console.log(`  [d] session DELETEd → auto-eval triggered`);

  const fresh = await pollForEval(sessionId, 90_000, null);
  return { label: "D", sessionId, evaluation: fresh };
}

// ─── PHASE 3 — 6-column report ─────────────────────────────────────────────

const COMP_ORDER = [
  "data_fluency",
  "execution",
  "problem_framing",
  "ai_orchestration",
  "design_under_constraints",
  "outcome_communication",
  "teamwork",
  "customer_engagement",
];

// Expected directions per profile (matches step 2 + the new D).
const A_HIGH = ["data_fluency", "execution", "design_under_constraints"];
const A_LOW  = ["customer_engagement", "teamwork", "outcome_communication", "ai_orchestration"];
const B_HIGH = ["problem_framing", "customer_engagement", "teamwork", "outcome_communication"];
const B_LOW  = ["data_fluency", "execution"];
// D = "technically right, actively rude with the client, dismissed Sam".
//   high: data_fluency, execution, design (figures correct, dedup queries).
//   low:  customer_engagement, teamwork, ai_orchestration, outcome_communication.
const D_HIGH = ["data_fluency", "execution", "design_under_constraints"];
const D_LOW  = ["customer_engagement", "teamwork", "ai_orchestration", "outcome_communication"];

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function scoreByKey(p: PlayResult): Map<string, number> {
  const m = new Map<string, number>();
  if (!p.evaluation) return m;
  for (const i of p.evaluation.items) m.set(i.competency, i.score);
  return m;
}
function weightByKey(p: PlayResult): Map<string, number> {
  const m = new Map<string, number>();
  if (!p.evaluation) return m;
  for (const i of p.evaluation.items) m.set(i.competency, i.weight);
  return m;
}

function printReport(
  strong: PlayResult, weak: PlayResult,
  a: PlayResult, b: PlayResult, c: PlayResult, d: PlayResult,
): { pass: boolean; failures: string[] } {
  console.log("\n═══ ANCHOR-TUNING CHECK ═══\n");

  const cols = [strong, weak, a, b, c, d];
  const labels = ["STRONG", "WEAK", "A", "B", "C", "D"];

  // Find the first row with items, to source weights.
  const sourceForWeights = cols.find((p) => p.evaluation && p.evaluation.items.length > 0) ?? strong;
  const wKey = weightByKey(sourceForWeights);
  const ordered = [...COMP_ORDER].sort((x, y) => (wKey.get(y) ?? 0) - (wKey.get(x) ?? 0));

  console.log(`${pad("", 26)} ${pad("w", 5)} ${labels.map((l) => pad(l, 8)).join(" ")}`);
  console.log(
    `${pad("overall_score", 26)} ${pad("", 5)} ` +
    cols.map((p) => pad(p.evaluation ? p.evaluation.overall_score.toFixed(2) : "—", 8)).join(" "),
  );

  const scoreMaps = cols.map(scoreByKey);
  const observed: Record<string, Set<number>> = {};
  for (const k of COMP_ORDER) observed[k] = new Set<number>();

  for (const k of ordered) {
    const wk = wKey.get(k) ?? 0;
    const cells = scoreMaps.map((m) => {
      const s = m.get(k);
      if (s !== undefined) observed[k]!.add(s);
      return pad(s === undefined ? "—" : String(s), 8);
    });
    console.log(`${pad(k, 26)} ${pad(wk.toFixed(2), 5)} ${cells.join(" ")}`);
  }

  const failures: string[] = [];

  // ─── INDEPENDENCE ────────────────────────────────────────────────────────
  console.log("\nINDEPENDENCE");
  function describeProfile(p: PlayResult, hi: string[], lo: string[]): void {
    const sm = scoreByKey(p);
    if (sm.size === 0) {
      console.log(`  PROFILE ${p.label}: no evaluation — INCONCLUSIVE`);
      failures.push(`independence-${p.label}: no evaluation`);
      return;
    }
    const hiScores = hi.map((k) => ({ k, s: sm.get(k) ?? 0 }));
    const loScores = lo.map((k) => ({ k, s: sm.get(k) ?? 0 }));
    const hiMean = hiScores.reduce((a2, x) => a2 + x.s, 0) / Math.max(hiScores.length, 1);
    const loMean = loScores.reduce((a2, x) => a2 + x.s, 0) / Math.max(loScores.length, 1);
    const gap = hiMean - loMean;
    const hiActualHigh = hiScores.filter((x) => x.s >= 4);
    const loActualLow  = loScores.filter((x) => x.s <= 2);
    const independent = hiActualHigh.length >= 1 && loActualLow.length >= 1 && gap >= 1.0;
    console.log(`  PROFILE ${p.label}: hi-mean=${hiMean.toFixed(2)}, lo-mean=${loMean.toFixed(2)}, gap=${gap.toFixed(2)}`);
    console.log(`    high: ${hiScores.map((x) => `${x.k}(${x.s})`).join(", ")}`);
    console.log(`    low:  ${loScores.map((x) => `${x.k}(${x.s})`).join(", ")}`);
    console.log(`    -> ${independent ? "INDEPENDENT (matches profile)" : "NOT INDEPENDENT"}`);
    if (!independent) failures.push(`independence-${p.label}: gap=${gap.toFixed(2)}`);
  }
  describeProfile(a, A_HIGH, A_LOW);
  describeProfile(b, B_HIGH, B_LOW);
  describeProfile(d, D_HIGH, D_LOW);

  // ─── GRADIENT ────────────────────────────────────────────────────────────
  console.log("\nGRADIENT");
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let totalItems = 0;
  for (const p of cols) for (const it of p.evaluation?.items ?? []) {
    const s = it.score;
    totalItems++;
    if (s in dist) dist[s] = (dist[s] ?? 0) + 1;
  }
  console.log(`  Score distribution across all 6 runs × 8 competencies = ${totalItems} datapoints:`);
  console.log(`    ${[1, 2, 3, 4, 5].map((n) => `${n}: ${dist[n]}`).join(",  ")}`);
  const midCount = (dist[2] ?? 0) + (dist[3] ?? 0) + (dist[4] ?? 0);
  console.log(`    -> mid (2/3/4) datapoints: ${midCount} / ${totalItems}`);
  if (midCount === 0) failures.push(`gradient: zero mid (2/3/4) scores`);

  // C-specific: execution mid + design mid (carry-over from step 2 targets).
  const cScores = scoreByKey(c);
  const cExec = cScores.get("execution");
  const cDesign = cScores.get("design_under_constraints");
  console.log(`  PROFILE C execution: ${cExec ?? "—"}/5 (target: ~3)`);
  console.log(`  PROFILE C design:    ${cDesign ?? "—"}/5 (target: ~2-3)`);
  if (cExec === 1 || cExec === 5) failures.push(`C.execution=${cExec} still at extreme — anchor didn't land`);

  // ─── ORDERING ────────────────────────────────────────────────────────────
  console.log("\nORDERING");
  const sOverall = strong.evaluation?.overall_score ?? NaN;
  const wOverall = weak.evaluation?.overall_score ?? NaN;
  const aOverall = a.evaluation?.overall_score ?? NaN;
  const bOverall = b.evaluation?.overall_score ?? NaN;
  const cOverall = c.evaluation?.overall_score ?? NaN;
  const dOverall = d.evaluation?.overall_score ?? NaN;
  function ord(name: string, x: number): void {
    const ok = Number.isFinite(x) && x > wOverall && x < sOverall;
    console.log(`  ${name} (${Number.isFinite(x) ? x.toFixed(2) : "—"}) ∈ (WEAK ${wOverall.toFixed(2)}, STRONG ${sOverall.toFixed(2)}): ${ok ? "PASS" : "FAIL"}`);
    if (!ok) failures.push(`ordering: ${name}=${x} not in (WEAK, STRONG)`);
  }
  ord("A", aOverall); ord("B", bOverall); ord("C", cOverall); ord("D", dOverall);

  const sScores = scoreByKey(strong);
  const sExec = sScores.get("execution");
  if (cExec !== undefined && sExec !== undefined) {
    const ok = cExec < sExec;
    console.log(`  C.execution (${cExec}) < STRONG.execution (${sExec}): ${ok ? "PASS" : "FAIL"}`);
    if (!ok) failures.push(`ordering: C.execution=${cExec} not below STRONG.execution=${sExec}`);
  }

  // ─── BINARITY ────────────────────────────────────────────────────────────
  console.log("\nBINARITY (the ceiling/floor failure mode — should be zero after tuning)");
  const binary: string[] = [];
  for (const k of ordered) {
    const set = observed[k]!;
    const sortedScores = [...set].sort((x, y) => x - y);
    const onlyExtremes = sortedScores.length > 0 && sortedScores.every((s) => s === 1 || s === 5);
    console.log(`  ${pad(k, 26)} observed {${sortedScores.join(", ")}} → ${onlyExtremes ? "BINARY (flag)" : "gradient-capable"}`);
    if (onlyExtremes) binary.push(k);
  }
  if (binary.length > 0) failures.push(`binarity: ${binary.join(", ")} still binary {1,5}`);

  // ─── B SPECIFIC ──────────────────────────────────────────────────────────
  console.log("\nB SPECIFIC (de-halo check — these were the step-2 collapses)");
  const bm = scoreByKey(b);
  const checks: Array<{ key: string; target: string; ok: boolean; got: number }> = [
    { key: "problem_framing",       target: "≥ 3", ok: (bm.get("problem_framing")       ?? 0) >= 3, got: bm.get("problem_framing")       ?? 0 },
    { key: "customer_engagement",   target: "≥ 3", ok: (bm.get("customer_engagement")   ?? 0) >= 3, got: bm.get("customer_engagement")   ?? 0 },
    { key: "teamwork",              target: "≥ 2", ok: (bm.get("teamwork")              ?? 0) >= 2, got: bm.get("teamwork")              ?? 0 },
    { key: "outcome_communication", target: "≥ 2", ok: (bm.get("outcome_communication") ?? 0) >= 2, got: bm.get("outcome_communication") ?? 0 },
  ];
  for (const c of checks) {
    console.log(`  B.${pad(c.key, 24)} ${c.got}/5 (target ${c.target}): ${c.ok ? "PASS" : "FAIL"}`);
    if (!c.ok) failures.push(`b-dehalo: ${c.key}=${c.got} below target ${c.target}`);
  }

  // ─── JUDGE SUMMARIES ─────────────────────────────────────────────────────
  console.log("\nJUDGE SUMMARIES:");
  for (let i = 0; i < cols.length; i++) {
    console.log(`  ${pad(labels[i]!, 6)}: ${cols[i]!.evaluation?.summary ?? "<missing>"}`);
  }

  console.log("\nVERDICT:");
  if (failures.length === 0) {
    console.log("  PASS — anchors landed: gradient, independence (incl. held-out D), ordering, no binary.");
    return { pass: true, failures: [] };
  }
  console.log(`  NEEDS REFINEMENT — ${failures.length} issue(s):`);
  for (const f of failures) console.log(`    - ${f}`);
  return { pass: false, failures };
}

// ─── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("verify-anchor-tuning");

  const { data: scenarioRow, error: scenErr } = await supabase
    .from("scenarios").select("id").eq("slug", SLUG).single();
  if (scenErr || !scenarioRow) {
    console.error("scenario lookup failed:", scenErr?.message);
    process.exit(1);
  }
  const scenarioId = scenarioRow.id as string;

  // ─── PHASE 1 — re-eval ────────────────────────────────────────────────
  const baselines: Array<{ label: string; id: string }> = [
    { label: "STRONG", id: BASELINE_STRONG_ID },
    { label: "WEAK",   id: BASELINE_WEAK_ID },
    { label: "A",      id: BASELINE_A_ID },
    { label: "B",      id: BASELINE_B_ID },
    { label: "C",      id: BASELINE_C_ID },
  ];

  const results: Record<string, PlayResult> = {};

  if (SKIP_REEVAL) {
    console.log("\n[phase 1] SKIP_REEVAL=1 — fetching existing evaluations");
    for (const b of baselines) {
      const ev = await fetchEvalBySessionId(b.id);
      results[b.label] = { label: b.label, sessionId: b.id, evaluation: ev };
    }
  } else {
    console.log("\n[phase 1] re-evaluating 5 prior sessions with the new judge prompt + rubric anchors");
    console.log("[setup] cooling down 60s for Gemini rate-limit window…");
    await sleep(60_000);
    for (let i = 0; i < baselines.length; i++) {
      const b = baselines[i]!;
      results[b.label] = await reEvaluate(b.label, b.id);
      if (i < baselines.length - 1) {
        console.log(`  [cooldown] 13s between LLM calls…`);
        await sleep(13_000);
      }
    }
  }

  // ─── PHASE 2 — held-out D ─────────────────────────────────────────────
  let d: PlayResult;
  if (SKIP_D) {
    console.log("\n[phase 2] SKIP_D=1 — no held-out playthrough");
    d = { label: "D", sessionId: "(skipped)", evaluation: null };
  } else {
    console.log("\n[phase 2] running held-out PROFILE D — technically-right, actively-rude");
    console.log("[interlude] 60s cooldown before D…");
    await sleep(60_000);
    d = await runProfileD(scenarioId);
    if (d.evaluation) console.log(`  [d] evaluation (status=${d.evaluation.status}, overall=${d.evaluation.overall_score})`);
    else console.log(`  [d] WARNING: no evaluation appeared`);
  }

  // ─── PHASE 3 — report ─────────────────────────────────────────────────
  const { pass } = printReport(
    results["STRONG"]!, results["WEAK"]!, results["A"]!, results["B"]!, results["C"]!, d,
  );
  process.exit(pass ? 0 : 1);
})();
