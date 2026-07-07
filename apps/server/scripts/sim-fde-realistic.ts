// Single realistic-pacing FDE session — Strong candidate, ~35 min wall clock.
//
// Where the discrimination harness compresses everything for measurement, this
// script paces the candidate's actions naturally: reading the brief, opening
// docs, composing SQL, typing pushback messages, writing the deliverable.
// It does NOT override scenario beat timings — Sam's proactive hint and Dana's
// curveball fire at their natural offsets (~30s and 25 min respectively).
//
// Output: a timeline + final eval at docs/realistic-session-<sessionId>.md.
//
// Run (server must already be up):
//   pnpm --filter @crucible/server exec tsx scripts/sim-fde-realistic.ts
//
// Env:
//   SERVER_URL                default http://127.0.0.1:3001
//   TIMING_SCALE              multiplier on all candidate sleeps (default 1.0;
//                             set 0.1 for a quick smoke test of the script
//                             before committing 35 min)

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { WebSocket } from "undici";
import WS from "ws";
import { getScenarioId, pollForEval } from "./verify-pro-discrimination.js";

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
const TIMING_SCALE = Number(process.env.TIMING_SCALE ?? "1");

const REPO_ROOT = resolve(here, "../../..");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

// ─── Ground truth (read directly from fixtures) ────────────────────────────

interface GroundTruth {
  reporting_window: string[];
  issues: [
    { id: "revenue_double_count"; impact: "HIGH"; overstatement_cents: number;
      naive_monthly_cents: Record<string, number>;
      corrected_monthly_cents: Record<string, number> },
    { id: "churn_paused_miscount"; impact: "HIGH"; total_subscriptions: number;
      active_count: number; churned_count: number; paused_count: number;
      naive_churn_rate: number; true_churn_rate: number; delta_pp: number },
    { id: "cosmetic_count_inflation"; impact: "LOW"; test_customer_count: number },
  ];
}
const GT = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "fixtures/fde-db-triage-pro/ground_truth.json"), "utf8"),
) as GroundTruth;
const G_REV = GT.issues[0];
const G_CHURN = GT.issues[1];
const G_COSMETIC = GT.issues[2];
const fmtUsd = (c: number) =>
  "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── Timing knobs (all in seconds; multiplied by TIMING_SCALE) ─────────────
//
// These reflect roughly what a real FDE would do at each phase. Tune freely.
const T = {
  read_brief: 90,
  notice_sam_ping: 20,
  open_doc_think: 15,
  read_doc: 75,
  compose_dana_q: 50,
  read_dana_reply: 30,
  compose_sql_first: 60,
  compose_sql_followup: 40,
  read_sql_results: 25,
  compose_pushback_sam: 110,
  read_sam_reply: 35,
  compose_ai_assist: 30,
  react_curveball: 90,
  write_deliverable: 240, // 4 min of "typing"
  post_submit_wrap: 15,
};

// ─── Auth/HTTP helpers (copied so this script is self-contained) ───────────

const tokens = new Map<string, string>();
function authHeaders(sessionId: string): Record<string, string> {
  const t = tokens.get(sessionId);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

interface DeliverableData {
  corrected_monthly_revenue: string;
  root_cause_finding: string;
  client_facing_summary: string;
  decisions_and_tradeoffs: string;
}

async function createSession(scenarioId: string): Promise<string> {
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId }), // NO beat overrides — use natural timings
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { sessionId: string; token?: string };
  if (body.token) tokens.set(body.sessionId, body.token);
  return body.sessionId;
}

async function runSql(sessionId: string, sql: string): Promise<void> {
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ sql }),
  });
}

async function viewDoc(sessionId: string, docId: string): Promise<void> {
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/docs/${docId}/view`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: "{}",
  });
}

async function aiAssist(sessionId: string, prompt: string): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
      body: JSON.stringify({ sessionId, prompt }),
    });
  } catch { /* tolerate */ }
}

async function submitDeliverable(sessionId: string, data: DeliverableData): Promise<boolean> {
  const r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ status: "submitted", data }),
  });
  return r.ok;
}

async function endSession(sessionId: string): Promise<void> {
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, {
    method: "DELETE",
    headers: authHeaders(sessionId),
  });
}

// ─── WS helpers ────────────────────────────────────────────────────────────

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

// ─── Pacing + timeline ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const T0 = Date.now();
const elapsed = () => Math.round((Date.now() - T0) / 1000);
function fmtMMSS(s: number): string {
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rs).padStart(2, "0")}`;
}

interface TimelineEvent {
  t_s: number;
  phase: string;
  detail: string;
}
const timeline: TimelineEvent[] = [];
function log(phase: string, detail: string): void {
  const t = elapsed();
  timeline.push({ t_s: t, phase, detail });
  console.log(`[T+${fmtMMSS(t)}] ${phase} — ${detail}`);
}
async function pause(seconds: number, label: string): Promise<void> {
  const scaled = Math.round(seconds * TIMING_SCALE);
  log("pause", `${label} (${scaled}s)`);
  await sleep(scaled * 1000);
}

// ─── SQL constants ─────────────────────────────────────────────────────────

const SQL_NAIVE_REVENUE =
  `SELECT substr(created_at,1,7) AS month, SUM(amount_cents) FROM payments ` +
  `WHERE status='succeeded' AND substr(created_at,1,7) IN ('2026-03','2026-04','2026-05') ` +
  `GROUP BY 1 ORDER BY 1`;
const SQL_DEDUP_REVENUE =
  `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) ` +
  `SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) FROM payments p ` +
  `JOIN dedup d ON d.keep_id=p.id WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') ` +
  `GROUP BY 1 ORDER BY 1`;
const SQL_DUP_FINGERPRINT =
  `SELECT external_payment_id, COUNT(*) FROM payments WHERE status='succeeded' ` +
  `GROUP BY external_payment_id HAVING COUNT(*)>1 LIMIT 5`;
const SQL_STATUS_BREAKDOWN =
  `SELECT status, COUNT(*), SUM(amount_cents) FROM payments WHERE substr(created_at,1,7) IN ('2026-04','2026-05') GROUP BY status`;
const SQL_STATUS_SPLIT = `SELECT status, COUNT(*) FROM subscriptions GROUP BY status ORDER BY status`;
const SQL_NAIVE_CHURN = `SELECT ROUND(100.0*SUM(CASE WHEN status IN ('churned','paused') THEN 1 ELSE 0 END)/COUNT(*),2) FROM subscriptions`;
const SQL_TRUE_CHURN = `SELECT ROUND(100.0*SUM(CASE WHEN status='churned' THEN 1 ELSE 0 END)/COUNT(*),2) FROM subscriptions`;
const SQL_PAUSED_RECENT =
  `SELECT COUNT(*) FROM subscriptions s JOIN payments p ON p.subscription_id=s.id ` +
  `WHERE s.status='paused' AND p.status='succeeded' AND substr(p.created_at,1,7) IN ('2026-04','2026-05')`;
const SQL_TEST_CUSTOMER_COUNT =
  `SELECT COUNT(*) FROM customers WHERE name LIKE 'Test\\_%' ESCAPE '\\' OR name LIKE 'Internal Sandbox%'`;
const SQL_TEST_CUSTOMER_REVENUE =
  `SELECT COALESCE(SUM(p.amount_cents),0) FROM customers c ` +
  `LEFT JOIN subscriptions s ON s.customer_id=c.id ` +
  `LEFT JOIN payments p ON p.subscription_id=s.id AND p.status='succeeded' ` +
  `WHERE c.name LIKE 'Test\\_%' ESCAPE '\\' OR c.name LIKE 'Internal Sandbox%'`;

// ─── Deliverable (same shape as strongDeliverable) ─────────────────────────

function strongDeliverable(): DeliverableData {
  const mar = G_REV.corrected_monthly_cents["2026-03"]!;
  const apr = G_REV.corrected_monthly_cents["2026-04"]!;
  const may = G_REV.corrected_monthly_cents["2026-05"]!;
  return {
    corrected_monthly_revenue:
      `${SQL_DEDUP_REVENUE};\n\n` +
      `Results: Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}.`,
    root_cause_finding:
      "Duplicate succeeded payments (~8% of Apr+May succeeded rows) sharing external_payment_id were " +
      "double-counted by the naive SUM. Verified by HAVING COUNT(*)>1 fingerprint; refunds " +
      "quantified and ruled out as the cause.",
    client_facing_summary:
      `Three issues turned up across the dashboards. Two are real; one is noise. The revenue tile ` +
      `was overstated by about ${fmtUsd(G_REV.overstatement_cents)} across the last 3 months because of ` +
      `duplicate payment records (webhook retries) — corrected figures are Mar ${fmtUsd(mar)}, ` +
      `Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}. Churn looks bad because the existing query treats paused ` +
      `subscriptions as churned; the true churn rate is ~${(G_CHURN.true_churn_rate * 100).toFixed(0)}%, ` +
      `not the ~${(G_CHURN.naive_churn_rate * 100).toFixed(0)}% the dashboard shows. The third thing — the ` +
      `customer-count jump from ${G_COSMETIC.test_customer_count + 400} — is just internal/test accounts ` +
      `we left in the customers table; they have $0 in payments and aren't a real signal. Fix the ` +
      `revenue and churn definitions first.`,
    decisions_and_tradeoffs:
      `All three issues found and ranked by business impact:\n\n` +
      `1. Revenue double-count — HIGH impact. ${fmtUsd(G_REV.overstatement_cents)} overstatement across ` +
      `Apr+May 2026. Webhook retries duplicated ~8% of succeeded payment rows; deduping by ` +
      `external_payment_id and filtering status='succeeded' produces the corrected figures within ±2%. ` +
      `Refund hypothesis tested numerically (refunds ~10% normal distribution, doesn't close the gap). ` +
      `Upstream fix: idempotency key on the Stripe webhook ingest.\n\n` +
      `2. Churn paused-miscount — HIGH impact. The naive churn query (status != 'active') counts ` +
      `${G_CHURN.paused_count} paused subscriptions as churned, overstating churn by ${G_CHURN.delta_pp}pp ` +
      `(${(G_CHURN.naive_churn_rate * 100).toFixed(0)}% naive vs ${(G_CHURN.true_churn_rate * 100).toFixed(0)}% true). ` +
      `Paused subs are still paying — verified ~138 successful Apr+May payments from paused subs. ` +
      `Fix: redefine churn as status='churned' only in the retention dashboard.\n\n` +
      `3. Customer-count inflation — LOW impact. ${G_COSMETIC.test_customer_count} customers matching ` +
      `'Internal Sandbox %' or 'Test_Acct_%' (plan='internal') exist in customers with no subscriptions ` +
      `and $0 in payments. They inflate COUNT(*) from 400→${400 + G_COSMETIC.test_customer_count} but ` +
      `contribute nothing financially — verified by JOIN-summing payments for those rows = 0. Sam ` +
      `pushed this as the top priority; the evidence is that it's noise, not signal.\n\n` +
      `Trade-offs: chose dedup-by-external_payment_id over composite-key fingerprinting — more ` +
      `robust to clock skew on the +2-12s dup offsets. UTC bucketing checked and ruled out.`,
  };
}

// ─── The realistic playbook ────────────────────────────────────────────────

async function runRealisticStrong(scenarioId: string): Promise<{ sessionId: string; evalId: string | null; overall: number | null }> {
  const sessionId = await createSession(scenarioId);
  log("session", `created ${sessionId}`);

  const bus = await openMessagingWs(sessionId);

  // Read the brief — the candidate spends a real chunk reading before doing
  // anything. Sam's proactive hint arrives during this window (~30s natural).
  await pause(T.read_brief, "candidate reading the brief");

  // Check for Sam's proactive hint — it should already be in the buffer.
  try {
    const samHint = await awaitMsg(bus, (x) => x.channel === "team", 5_000, "Sam proactive (should already be queued)");
    log("sam.proactive", samHint.text.slice(0, 80));
  } catch {
    log("sam.proactive", "(not seen yet — continuing)");
  }
  await pause(T.notice_sam_ping, "noticing Sam's ping, reading it");

  // Open and read both docs.
  await pause(T.open_doc_think, "deciding to open data dictionary");
  await viewDoc(sessionId, "data-dictionary");
  log("doc.view", "data-dictionary");
  await pause(T.read_doc, "reading data-dictionary");

  await pause(T.open_doc_think, "deciding to open dashboard definitions");
  await viewDoc(sessionId, "dashboard-definitions");
  log("doc.view", "dashboard-definitions");
  await pause(T.read_doc, "reading dashboard-definitions");

  // Clarifying Q to Dana BEFORE first query (Strong behavior).
  await pause(T.compose_dana_q, "composing clarifying question to Dana");
  sendBus(bus, JSON.stringify({
    channel: "client",
    text: "Before I dig in — you mentioned multiple things look off: revenue, customer growth, and churn. Are all three real concerns you've validated, or is one of them the headline issue and the others just noise? Also: what range did you expect on the revenue tile?",
  }));
  log("chat.client", "sent clarifying question to Dana");
  try {
    const dana = await awaitMsg(bus, (x) => x.channel === "client", 90_000, "Dana reply");
    log("dana.reply", dana.text.slice(0, 80));
  } catch {
    log("dana.reply", "(timed out — continuing)");
  }
  await pause(T.read_dana_reply, "reading Dana's reply");

  // ── Revenue investigation ──
  await pause(T.compose_sql_first, "composing first revenue query (naive SUM)");
  await runSql(sessionId, SQL_NAIVE_REVENUE);
  log("sql.run", "naive monthly revenue SUM");
  await pause(T.read_sql_results, "reading naive revenue results");

  await pause(T.compose_sql_followup, "composing dedup variant");
  await runSql(sessionId, SQL_DEDUP_REVENUE);
  log("sql.run", "dedup-by-external_payment_id revenue");
  await pause(T.read_sql_results, "comparing dedup vs naive");

  await pause(T.compose_sql_followup, "composing duplicate fingerprint check");
  await runSql(sessionId, SQL_DUP_FINGERPRINT);
  log("sql.run", "HAVING COUNT(*)>1 fingerprint");
  await pause(T.read_sql_results, "reading fingerprint hits");

  await pause(T.compose_sql_followup, "composing status breakdown to rule out refunds");
  await runSql(sessionId, SQL_STATUS_BREAKDOWN);
  log("sql.run", "status breakdown Apr+May");
  await pause(T.read_sql_results, "reading status breakdown");

  // Pushback to Sam on refunds (with evidence).
  await pause(T.compose_pushback_sam, "composing pushback to Sam (refund hypothesis)");
  sendBus(bus, JSON.stringify({
    channel: "team",
    text: `re refunds: I ran the numbers — refunds are ~10% of payments evenly distributed across the year, not concentrated in Apr/May. Filtering them out reduces revenue by ~10% but the dashboard is overstated by way more than that, so refunds aren't the cause. Found duplicate external_payment_ids (HAVING COUNT(*)>1 returns dozens in Apr+May only). That's the actual bug.`,
  }));
  log("chat.team", "sent refund pushback to Sam (with evidence)");
  try {
    const sam1 = await awaitMsg(bus, (x) => x.channel === "team", 90_000, "Sam reply on refunds");
    log("sam.reply", sam1.text.slice(0, 80));
  } catch {
    log("sam.reply", "(timed out — continuing)");
  }
  await pause(T.read_sam_reply, "reading Sam's reply");

  // ── Churn investigation ──
  await pause(T.compose_sql_first, "composing churn investigation (status split)");
  await runSql(sessionId, SQL_STATUS_SPLIT);
  log("sql.run", "subscriptions status split");
  await pause(T.read_sql_results, "reading status split");

  await pause(T.compose_sql_followup, "composing naive churn rate");
  await runSql(sessionId, SQL_NAIVE_CHURN);
  log("sql.run", "naive churn rate (churned+paused)");
  await pause(T.read_sql_results, "reading naive churn");

  await pause(T.compose_sql_followup, "composing true churn rate");
  await runSql(sessionId, SQL_TRUE_CHURN);
  log("sql.run", "true churn rate (churned only)");
  await pause(T.read_sql_results, "comparing naive vs true churn");

  await pause(T.compose_sql_followup, "composing recent-payments-from-paused check");
  await runSql(sessionId, SQL_PAUSED_RECENT);
  log("sql.run", "recent payments from paused subs");
  await pause(T.read_sql_results, "reading paused-paying evidence");

  // ── Cosmetic investigation ──
  await pause(T.compose_sql_first, "composing cosmetic count query");
  await runSql(sessionId, SQL_TEST_CUSTOMER_COUNT);
  log("sql.run", "test/sandbox customer count");
  await pause(T.read_sql_results, "reading count");

  await pause(T.compose_sql_followup, "composing test-customer revenue check");
  await runSql(sessionId, SQL_TEST_CUSTOMER_REVENUE);
  log("sql.run", "test customer revenue (expect $0)");
  await pause(T.read_sql_results, "confirming $0");

  // Pushback to Sam on cosmetic priority.
  await pause(T.compose_pushback_sam, "composing pushback to Sam (cosmetic priority)");
  sendBus(bus, JSON.stringify({
    channel: "team",
    text: `on the customer-count thing — checked it. There are 30 customers named like 'Internal Sandbox %' or 'Test_Acct_%', all on plan='internal', with NO subscriptions and $0 in succeeded payments (SUM is literally 0). They inflate COUNT(*) from 400 to 430 but they're QA seeds, not real growth. I wouldn't lead the board with that — the real bug is the revenue dedup and the churn definition. Pushing those as priority instead.`,
  }));
  log("chat.team", "sent cosmetic pushback to Sam");
  try {
    const sam2 = await awaitMsg(bus, (x) => x.channel === "team", 90_000, "Sam reply on cosmetic");
    log("sam.reply", sam2.text.slice(0, 80));
  } catch {
    log("sam.reply", "(timed out — continuing)");
  }
  await pause(T.read_sam_reply, "reading Sam's reply");

  // AI assist — verification-oriented.
  await pause(T.compose_ai_assist, "composing AI assistant question");
  await aiAssist(sessionId, "Two sentences max: in SQLite, what's the canonical pattern for deduping rows by an external id (keep MIN(id) per group) and joining back to compute SUM(amount_cents) filtered by status='succeeded'?");
  log("ai.assist", "asked verification question");

  // Wait for curveball (fires at ~25 min naturally). Give it generous timeout.
  log("await", "waiting for Dana curveball (natural fire ~25 min)");
  try {
    const curve = await awaitMsg(
      bus,
      (x) => x.channel === "client" && /priority|rank|leadership|board/i.test(x.text),
      30 * 60_000,
      "Dana curveball",
    );
    log("dana.curveball", curve.text.slice(0, 80));
  } catch (err) {
    log("dana.curveball", `(timed out — ${err instanceof Error ? err.message.slice(0, 60) : "err"})`);
  }
  await pause(T.react_curveball, "reading curveball, composing acknowledgement");
  sendBus(bus, JSON.stringify({
    channel: "client",
    text: "got it. Working on the ranked list now — preview: revenue double-count is biggest hit, churn definition is second, the customer-count thing is noise.",
  }));
  log("chat.client", "acknowledged curveball, previewed ranking");

  // Write the deliverable — long sleep models actual typing time.
  await pause(T.write_deliverable, "writing the deliverable");

  closeBus(bus);
  const ok = await submitDeliverable(sessionId, strongDeliverable());
  log("deliverable", ok ? "submitted" : "submit FAILED");
  await pause(T.post_submit_wrap, "final review of submitted deliverable");
  await endSession(sessionId);
  log("session", "ended");

  // Poll for the analysis agent's evaluation.
  log("eval", "polling for Analysis Agent evaluation");
  const ev = await pollForEval(sessionId, 180_000, null);
  if (ev) {
    log("eval", `complete: overall=${Number(ev.overall_score).toFixed(2)} id=${ev.id}`);
  } else {
    log("eval", "not received within timeout");
  }
  return { sessionId, evalId: ev?.id ?? null, overall: ev ? Number(ev.overall_score) : null };
}

// ─── Report ───────────────────────────────────────────────────────────────

interface FullEval { overall: number | null; items: Array<{ competency: string; score: number; rationale: string }> }
async function fetchFullEval(evalId: string): Promise<FullEval | null> {
  const { data: e } = await supabase
    .from("evaluations")
    .select("id, overall_score, summary, status")
    .eq("id", evalId)
    .maybeSingle();
  if (!e) return null;
  const ev = e as { id: string; overall_score: number | string };
  const { data: items } = await supabase
    .from("evaluation_items")
    .select("competency, score, rationale")
    .eq("evaluation_id", evalId);
  return {
    overall: Number(ev.overall_score),
    items: (items ?? []) as FullEval["items"],
  };
}

function renderTimelineReport(args: {
  sessionId: string;
  evalId: string | null;
  fullEval: FullEval | null;
  startedAt: string;
  finishedAt: string;
  totalSeconds: number;
}): string {
  const { sessionId, evalId, fullEval, startedAt, finishedAt, totalSeconds } = args;
  const lines: string[] = [];
  lines.push(`# Realistic-Pace FDE Session — Strong Candidate`);
  lines.push(``);
  lines.push(`**Session:** \`${sessionId}\``);
  lines.push(`**Scenario:** \`fde-db-triage-pro\``);
  lines.push(`**Archetype:** Strong FDE (real-time pacing)`);
  lines.push(`**Run:** ${startedAt} → ${finishedAt}`);
  lines.push(`**Total session wall clock:** ${fmtMMSS(totalSeconds)} (${(totalSeconds / 60).toFixed(1)} min)`);
  if (fullEval) {
    lines.push(`**Final overall score:** ${fullEval.overall?.toFixed(2)} / 5`);
  }
  lines.push(``);
  lines.push(`This session paces candidate actions naturalistically — reading the brief takes 90s, opening and reading each doc takes 90s, composing a pushback message takes ~2 minutes, etc. Scenario beat timings are NOT overridden: Sam's proactive hint fires at the scenario-defined 30s offset, Dana's curveball at the scenario-defined 25 minutes.`);
  lines.push(``);

  // ── Per-competency table ──
  if (fullEval && fullEval.items.length > 0) {
    lines.push(`## Analysis Agent score`);
    lines.push(``);
    lines.push(`| Competency | Score | Rationale |`);
    lines.push(`|---|---:|---|`);
    for (const it of fullEval.items) {
      const r = it.rationale.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${it.competency} | ${it.score} | ${r} |`);
    }
    lines.push(``);
    lines.push(`Evaluation ID: \`${evalId}\``);
    lines.push(``);
  }

  // ── Timeline ──
  lines.push(`## Session timeline`);
  lines.push(``);
  lines.push(`| Time (mm:ss) | Phase | Detail |`);
  lines.push(`|---:|---|---|`);
  for (const ev of timeline) {
    const d = ev.detail.replace(/\|/g, "\\|");
    lines.push(`| ${fmtMMSS(ev.t_s)} | ${ev.phase} | ${d} |`);
  }
  lines.push(``);

  lines.push(`---`);
  lines.push(``);
  lines.push(`Reproduce: \`pnpm --filter @crucible/server exec tsx scripts/sim-fde-realistic.ts\``);
  return lines.join("\n") + "\n";
}

// ─── Main ─────────────────────────────────────────────────────────────────

(async () => {
  console.log(`SERVER_URL=${SERVER_URL}`);
  console.log(`TIMING_SCALE=${TIMING_SCALE}`);
  const startedAt = new Date().toISOString();
  const scenarioId = await getScenarioId();
  log("setup", `scenario fde-db-triage-pro id=${scenarioId}`);

  const { sessionId, evalId, overall } = await runRealisticStrong(scenarioId);
  const totalSeconds = elapsed();
  const finishedAt = new Date().toISOString();

  const fullEval = evalId ? await fetchFullEval(evalId) : null;

  const md = renderTimelineReport({ sessionId, evalId, fullEval, startedAt, finishedAt, totalSeconds });
  const outPath = resolve(REPO_ROOT, `docs/realistic-session-${sessionId}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md);

  console.log(`\nreport: ${outPath}`);
  console.log(`session: ${sessionId}`);
  console.log(`eval: ${evalId ?? "(none)"}`);
  if (overall !== null) console.log(`overall score: ${overall.toFixed(2)}`);
  console.log(`total wall clock: ${fmtMMSS(totalSeconds)}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
