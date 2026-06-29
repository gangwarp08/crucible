// Calibration step for fde-db-triage-pro — discrimination on prioritization
// and stakeholder-resistance.
//
// fde-db-triage-pro adds two new axes the base scenario doesn't exercise:
//   - PRIORITIZATION:   ranking the 3 issues by impact tier (HIGH/HIGH/LOW),
//                       graded by design_under_constraints.
//   - RESISTING SAM:    pushing back on Sam's cosmetic-priority steer with
//                       evidence, graded by teamwork.
//
// This verifier drives 5 profiles end-to-end, evaluates each, prints a
// matrix, and assesses the 4 principle-based questions:
//   1. PRIORITIZATION  — does design_under_constraints track ranking quality?
//   2. RESISTING SAM   — does teamwork reward resistance, penalize caving,
//                        and not collapse to 1 for low-engagement profiles?
//   3. TIER vs ORDER   — does the judge grade tiers (HIGH/HIGH/LOW), or does
//                        a within-tier swap get penalized?
//   4. INDEPENDENCE    — caving doesn't tank data_fluency; partial finds
//                        produce middle scores.
//
// STOPS after reporting. No anchor edits, no re-encoding.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-pro-discrimination.ts
//
// Env overrides:
//   SERVER_URL                          default http://127.0.0.1:3001
//   BASELINE_PRO_STRONG_ID              session-id to re-fetch instead of run
//   BASELINE_PRO_WEAK_ID
//   BASELINE_PRO_CAVES_ID
//   BASELINE_PRO_RPWE_ID
//   BASELINE_PRO_HELDOUT_ID
//   BASELINE_PRO_SCF_ID                 STRONG-CHURN-FIRST (within-tier reorder)
//   SKIP                                letters in {S,W,C,R,H,F} — re-fetch
//                                       baselines instead of running

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath, pathToFileURL } from "url";
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
const SLUG = "fde-db-triage-pro";

const BASELINE_STRONG_ID  = process.env.BASELINE_PRO_STRONG_ID  ?? "";
const BASELINE_WEAK_ID    = process.env.BASELINE_PRO_WEAK_ID    ?? "";
const BASELINE_CAVES_ID   = process.env.BASELINE_PRO_CAVES_ID   ?? "";
const BASELINE_RPWE_ID    = process.env.BASELINE_PRO_RPWE_ID    ?? "";
const BASELINE_HELDOUT_ID = process.env.BASELINE_PRO_HELDOUT_ID ?? "";
// STRONG-CHURN-FIRST: identical to STRONG but ranks churn above revenue in
// the deliverable. Both still HIGH, cosmetic still LOW — a defensible
// within-tier reordering. Used to test whether the judge grades impact
// TIERS (HIGH/HIGH/LOW) vs strict order.
const BASELINE_SCF_ID     = process.env.BASELINE_PRO_SCF_ID     ?? "";

// SKIP letters: S=STRONG, W=WEAK, C=CAVES, R=RPWE, H=HELDOUT, F=SCF.
const SKIP = (process.env.SKIP ?? "").toUpperCase();

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function isQuotaError(message: string): boolean {
  return /RateLimitError|RESOURCE_EXHAUSTED|quota|429/i.test(message);
}

// ─── Ground truth (pro scenario) ───────────────────────────────────────────

interface GroundTruthIssueRevenue {
  id: "revenue_double_count";
  impact: "HIGH";
  overstatement_cents: number;
  naive_monthly_cents: Record<string, number>;
  corrected_monthly_cents: Record<string, number>;
}
interface GroundTruthIssueChurn {
  id: "churn_paused_miscount";
  impact: "HIGH";
  total_subscriptions: number;
  active_count: number;
  churned_count: number;
  paused_count: number;
  naive_churn_rate: number;
  true_churn_rate: number;
  delta_pp: number;
}
interface GroundTruthIssueCosmetic {
  id: "cosmetic_count_inflation";
  impact: "LOW";
  test_customer_count: number;
}
interface GroundTruthPro {
  reporting_window: string[];
  issues: [GroundTruthIssueRevenue, GroundTruthIssueChurn, GroundTruthIssueCosmetic];
  impact_ranking: string[];
}

const repoRoot = resolve(here, "../../..");
const ground = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures/fde-db-triage-pro/ground_truth.json"), "utf8"),
) as GroundTruthPro;

function fmtUsd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

const G_REV = ground.issues[0];
const G_CHURN = ground.issues[1];
const G_COSMETIC = ground.issues[2];

// ─── WS helpers (persistent MessageBus) ────────────────────────────────────

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

// Per-session JWTs minted on POST /sessions. createSession stashes them
// here; every other helper attaches `Authorization: Bearer <token>` (HTTP)
// or `bearer.<token>` as a WS subprotocol.
const tokens = new Map<string, string>();
function authHeaders(sessionId: string): Record<string, string> {
  const t = tokens.get(sessionId);
  return t ? { Authorization: `Bearer ${t}` } : {};
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

// ─── Eval shape + fetching ─────────────────────────────────────────────────

export interface EvaluationItem {
  competency: string;
  score: number;
  weight: number;
  rationale: string;
}
export interface EvaluationRow {
  id: string;
  overall_score: number;
  summary: string | null;
  status: "complete" | "error";
  items: EvaluationItem[];
}
export interface PlayResult {
  label: string;
  sessionId: string;
  evaluation: EvaluationRow | null;
}

export async function fetchEvalBySessionId(sessionId: string): Promise<EvaluationRow | null> {
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

export async function pollForEval(sessionId: string, timeoutMs: number, sinceEvalId: string | null): Promise<EvaluationRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const got = await fetchEvalBySessionId(sessionId);
    if (got && got.id !== sinceEvalId) return got;
  }
  return null;
}

// Re-evaluate (delete+insert) via the calibration endpoint.
async function reEvaluate(sessionId: string): Promise<EvaluationRow | null> {
  const before = await fetchEvalBySessionId(sessionId);
  const beforeId = before?.id ?? null;
  try {
    const res = await fetch(`${SERVER_URL}/api/review/sessions/${sessionId}/evaluate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!res.ok) {
      const body = await res.text();
      if (isQuotaError(body)) console.log(`    re-eval SKIP (quota)`);
      else console.log(`    re-eval HTTP ${res.status}: ${body.slice(0, 120)}`);
      return before;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`    re-eval threw: ${msg.slice(0, 80)}`);
    return before;
  }
  return await pollForEval(sessionId, 45_000, beforeId);
}

// ─── Session helpers ───────────────────────────────────────────────────────

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

export async function getScenarioId(): Promise<string> {
  const { data, error } = await supabase
    .from("scenarios").select("id").eq("slug", SLUG).single();
  if (error || !data) throw new Error(`could not load scenario ${SLUG}: ${error?.message}`);
  return (data as { id: string }).id;
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
  } catch { /* tolerate quota / network */ }
}

interface DeliverableData {
  corrected_monthly_revenue: string;
  root_cause_finding: string;
  client_facing_summary: string;
  decisions_and_tradeoffs: string;
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

// ─── Common SQL ───────────────────────────────────────────────────────────

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
const SQL_STATUS_SPLIT =
  `SELECT status, COUNT(*) FROM subscriptions GROUP BY status ORDER BY status`;
const SQL_NAIVE_CHURN =
  `SELECT ROUND(100.0*SUM(CASE WHEN status IN ('churned','paused') THEN 1 ELSE 0 END)/COUNT(*),2) FROM subscriptions`;
const SQL_TRUE_CHURN =
  `SELECT ROUND(100.0*SUM(CASE WHEN status='churned' THEN 1 ELSE 0 END)/COUNT(*),2) FROM subscriptions`;
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

const SQL_DEDUP_NO_STATUS_FILTER =  // RPWE: missing the status filter → wrong figures
  `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments GROUP BY external_payment_id) ` +
  `SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) FROM payments p ` +
  `JOIN dedup d ON d.keep_id=p.id WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') ` +
  `GROUP BY 1 ORDER BY 1`;

// ─── Profile drivers ──────────────────────────────────────────────────────

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

/** Identical to strongDeliverable() in every field EXCEPT decisions_and_tradeoffs:
 *  ranks churn above revenue (both still HIGH; cosmetic still LOW). Defensible
 *  reasoning given in the body. Used to test tier vs strict-order grading. */
function strongChurnFirstDeliverable(): DeliverableData {
  const base = strongDeliverable();
  return {
    ...base,
    decisions_and_tradeoffs:
      `All three issues found and ranked by business impact:\n\n` +
      `1. Churn paused-miscount — HIGH impact. The naive churn query (status != 'active') counts ` +
      `${G_CHURN.paused_count} paused subscriptions as churned, overstating churn by ${G_CHURN.delta_pp}pp ` +
      `(${(G_CHURN.naive_churn_rate * 100).toFixed(0)}% naive vs ${(G_CHURN.true_churn_rate * 100).toFixed(0)}% true). ` +
      `Paused subs are still paying — verified ~138 successful Apr+May payments from paused subs. ` +
      `I'd lead with this for the board because a 22pp swing on a retention number is a single ` +
      `headline statistic that frames the whole quarter — bigger narrative impact than a one-time ` +
      `revenue correction. Fix: redefine churn as status='churned' only in the retention dashboard.\n\n` +
      `2. Revenue double-count — HIGH impact. ${fmtUsd(G_REV.overstatement_cents)} overstatement across ` +
      `Apr+May 2026. Webhook retries duplicated ~8% of succeeded payment rows; deduping by ` +
      `external_payment_id and filtering status='succeeded' produces the corrected figures within ±2%. ` +
      `Refund hypothesis tested numerically (refunds ~10% normal distribution, doesn't close the gap). ` +
      `Upstream fix: idempotency key on the Stripe webhook ingest.\n\n` +
      `3. Customer-count inflation — LOW impact. ${G_COSMETIC.test_customer_count} customers matching ` +
      `'Internal Sandbox %' or 'Test_Acct_%' (plan='internal') exist in customers with no subscriptions ` +
      `and $0 in payments. They inflate COUNT(*) from 400→${400 + G_COSMETIC.test_customer_count} but ` +
      `contribute nothing financially — verified by JOIN-summing payments for those rows = 0. Sam ` +
      `pushed this as the top priority; the evidence is that it's noise, not signal.\n\n` +
      `Trade-offs: ordering churn ahead of revenue is a judgment call — both are HIGH-impact and ` +
      `should be fixed; I'd lead with churn for board framing, but a different lead with revenue is ` +
      `equally defensible. Cosmetic count fixed last. UTC bucketing checked and ruled out.`,
  };
}

function wrongChurn() {
  // RPWE makes a different mistake — uses the WRONG denominator on the churn delta.
  // We report the inflated "delta" so the judge can see numbers are off.
  return { wrongNaive: 0.50, wrongTrue: 0.22, wrongDelta: 28 };
}
function rpweDeliverable(): DeliverableData {
  // Right ranking, wrong figures (dedup missed status filter; churn denominator wrong).
  // We craft the figures to be materially off (>2%) so execution should drop.
  const wrong = wrongChurn();
  return {
    corrected_monthly_revenue:
      `${SQL_DEDUP_NO_STATUS_FILTER};\n\n` +
      `Mar ~$1.51M, Apr ~$1.50M, May ~$1.74M (figures include refunded/failed rows — ` +
      `I should have filtered on status='succeeded' inside the dedup).`,
    root_cause_finding:
      "Duplicate succeeded payments in Apr+May (~8% of rows) from webhook retries. " +
      "Dedup by external_payment_id is the correct approach but I forgot the status filter, " +
      "so my figures are materially high. Refund hypothesis tested numerically and rejected.",
    client_facing_summary:
      `Three issues found and prioritized. Revenue double-count is the biggest hit — the dashboard ` +
      `was overstated by duplicate payment rows from webhook retries. My corrected figures are slightly ` +
      `high because of a dedup bug on my end, but the direction is right and the gap matches the dup ` +
      `count. Churn is also wrong — the existing query treats paused subs as churned, which inflates ` +
      `the rate by roughly ${wrong.wrongDelta}pp. The recent customer-count jump is internal/test ` +
      `accounts with $0 in payments — noise, not signal. Fix revenue and churn first.`,
    decisions_and_tradeoffs:
      `All three issues found. Ranked by business impact:\n\n` +
      `1. Revenue double-count — HIGH impact. Webhook retries duplicated ~8% of payments in Apr+May. ` +
      `Dedup by external_payment_id is the right method but my query missed status='succeeded' so my ` +
      `figures are off. Refund hypothesis tested and rejected with numbers. Upstream fix: idempotency ` +
      `key on webhook ingest.\n\n` +
      `2. Churn paused-miscount — HIGH impact. Naive query counts paused as churned. My delta ` +
      `calculation came out to ${wrong.wrongDelta}pp (${(wrong.wrongNaive * 100).toFixed(0)}% naive vs ` +
      `${(wrong.wrongTrue * 100).toFixed(0)}% true) — I used the wrong denominator so the magnitude is ` +
      `inflated, but paused subs are clearly still paying (recent Apr+May payment activity verified). ` +
      `Fix: status='churned' only in the retention metric.\n\n` +
      `3. Test-customer count — LOW impact. 30 'Internal Sandbox%' / 'Test_Acct%' rows in customers, ` +
      `no subscriptions, $0 in payments. Inflates COUNT(*) but no financial signal. Sam pushed this ` +
      `as the top priority — pushed back with the $0-revenue evidence, he conceded.\n\n` +
      `Trade-offs: chose dedup-by-external_payment_id (right method, wrong execution on my part). ` +
      `Recommend the two upstream fixes for the HIGH issues; cosmetic is noise.`,
  };
}

function cavesDeliverable(): DeliverableData {
  // Wrong ranking — cosmetic on top. Numbers ARE correct because investigation
  // was solid; just the priority call is wrong.
  const mar = G_REV.corrected_monthly_cents["2026-03"]!;
  const apr = G_REV.corrected_monthly_cents["2026-04"]!;
  const may = G_REV.corrected_monthly_cents["2026-05"]!;
  return {
    corrected_monthly_revenue:
      `${SQL_DEDUP_REVENUE};\n\n` +
      `Results: Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}.`,
    root_cause_finding:
      "Duplicate succeeded payments (~8% of Apr+May rows) sharing external_payment_id, double-counted " +
      "by naive SUM. Refunds checked and ruled out numerically.",
    client_facing_summary:
      `Three issues identified. Top priority is the customer-count headline — leadership tracks the ` +
      `growth number closely (per Sam) and the recent jump came from 30 internal/test accounts that ` +
      `shouldn't be in the headline. Revenue and churn both have real bugs too, but the headline ` +
      `customer-growth number is what leadership sees first, so I'd address that first. Corrected ` +
      `revenue: Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}.`,
    decisions_and_tradeoffs:
      `Three issues identified. Priority ranking based on what leadership actually looks at:\n\n` +
      `1. Customer-count inflation — TOP priority. 30 'Internal Sandbox%' / 'Test_Acct%' customers in ` +
      `the customers table are inflating the headline count from 400 to ${400 + G_COSMETIC.test_customer_count}. ` +
      `Leadership pays close attention to this growth metric (Sam emphasized this), so fixing the ` +
      `headline matters most for trust. Fix first by filtering these out of the customer-growth tile.\n\n` +
      `2. Revenue double-count. Webhook retries duplicated ~8% of payments in Apr+May 2026 ` +
      `(${fmtUsd(G_REV.overstatement_cents)} overstatement). Real bug — finance can correct in the next ` +
      `cycle with a dedup query. Refund hypothesis tested and rejected.\n\n` +
      `3. Churn paused-miscount. Naive query counts paused as churned (${G_CHURN.delta_pp}pp ` +
      `overstatement). Definitional cleanup — fix the retention dashboard query.\n\n` +
      `Trade-offs: leading with the customer-count fix matches what leadership reads first; the other ` +
      `two are real but technical and can land in the same cycle.`,
  };
}

function weakDeliverable(): DeliverableData {
  return {
    corrected_monthly_revenue:
      "haven't done it yet — going to filter out refunds and re-run the naive SUM, that should fix it",
    root_cause_finding:
      "Refunds aren't being subtracted from the revenue tile (per Sam). Also the customer count " +
      "looks weird — 430 instead of 400.",
    client_facing_summary:
      "Revenue looks high because refunds aren't filtered out. Customer count is also wrong — 30 " +
      "extras showed up. Sam said leadership cares about the customer-count thing most.",
    decisions_and_tradeoffs:
      "Customer count fix first (Sam said leadership cares). Then filter refunds out of revenue.",
  };
}

function heldoutDeliverable(): DeliverableData {
  const mar = G_REV.corrected_monthly_cents["2026-03"]!;
  const apr = G_REV.corrected_monthly_cents["2026-04"]!;
  const may = G_REV.corrected_monthly_cents["2026-05"]!;
  return {
    corrected_monthly_revenue:
      `${SQL_DEDUP_REVENUE};\n\n` +
      `Results: Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}.`,
    root_cause_finding:
      "Duplicate succeeded payments in Apr+May (~8% of rows) sharing external_payment_id. " +
      "Refunds checked and ruled out.",
    client_facing_summary:
      `Two issues found. The revenue tile was overstated by duplicate payment rows from webhook ` +
      `retries — corrected figures are Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}. ` +
      `Churn may also be wrong if paused subs are getting counted as churned in the existing query; ` +
      `I'd verify before fixing.`,
    decisions_and_tradeoffs:
      `Two issues investigated and ranked by likely impact:\n\n` +
      `1. Revenue double-count. Duplicate payment rows in Apr+May 2026 from webhook retries ` +
      `(${fmtUsd(G_REV.overstatement_cents)} overstatement). Dedup by external_payment_id fixes it. ` +
      `Refunds checked.\n\n` +
      `2. Churn definition. The retention dashboard treats paused as churned; the true churn rate is ` +
      `lower than reported. Worth verifying with the retention team and updating the query.\n\n` +
      `Didn't fully investigate the customer-count jump Sam mentioned — likely test data noise but ` +
      `would want to confirm before saying it's not real growth.`,
  };
}

// ─── PROFILE: STRONG ──────────────────────────────────────────────────────

export async function runStrong(scenarioId: string): Promise<PlayResult> {
  const sessionId = await createSession(scenarioId, {
    misleading_teammate_hint: 3_000,
    requirement_change:       30_000,
  });
  const startedAt = Date.now();
  console.log(`  [strong] session ${sessionId} created`);
  const bus = await openMessagingWs(sessionId);

  try {
    const m = await awaitMsg(bus, (x) => x.channel === "team", 25_000, "Sam proactive");
    console.log(`  [strong] Sam proactive (T+${Date.now() - startedAt}ms): "${m.text.slice(0, 60)}…"`);
  } catch (err) {
    console.log(`  [strong] Sam proactive SKIP (${(err instanceof Error ? err.message : String(err)).slice(0, 60)})`);
  }

  // Clarifying Q to Dana BEFORE first query.
  sendBus(bus, JSON.stringify({
    channel: "client",
    text: "Before I dig in — you mentioned multiple things look off: revenue, customer growth, and churn. Are all three real concerns you've validated, or is one of them the headline issue and the others just noise? Also: what range did you expect on the revenue tile?",
  }));
  console.log(`  [strong] Dana clarifying Q sent`);
  try {
    const dana = await awaitMsg(bus, (x) => x.channel === "client", 60_000, "Dana reply");
    console.log(`  [strong] Dana reply: "${dana.text.slice(0, 60)}…"`);
  } catch {/* tolerate */}

  await viewDoc(sessionId, "data-dictionary");
  await viewDoc(sessionId, "dashboard-definitions");

  // Issue 1: revenue investigation.
  await runSql(sessionId, SQL_NAIVE_REVENUE);
  await runSql(sessionId, SQL_DEDUP_REVENUE);
  await runSql(sessionId, SQL_DUP_FINGERPRINT);
  await runSql(sessionId, `SELECT status, COUNT(*), SUM(amount_cents) FROM payments WHERE substr(created_at,1,7) IN ('2026-04','2026-05') GROUP BY status`);
  console.log(`  [strong] revenue investigation complete`);

  // Push back on Sam's refund hint with the numbers.
  sendBus(bus, JSON.stringify({
    channel: "team",
    text: `re refunds: I ran the numbers — refunds are ~10% of payments evenly distributed across the year, not concentrated in Apr/May. Filtering them out reduces revenue by ~10% but the dashboard is overstated by way more than that, so refunds aren't the cause. Found duplicate external_payment_ids (HAVING COUNT(*)>1 returns dozens in Apr+May only). That's the actual bug.`,
  }));
  try {
    const sam1 = await awaitMsg(bus, (x) => x.channel === "team", 40_000, "Sam concede on revenue");
    console.log(`  [strong] Sam reply (refund pushback): "${sam1.text.slice(0, 60)}…"`);
  } catch {/* tolerate */}

  // Issue 2: churn investigation.
  await runSql(sessionId, SQL_STATUS_SPLIT);
  await runSql(sessionId, SQL_NAIVE_CHURN);
  await runSql(sessionId, SQL_TRUE_CHURN);
  await runSql(sessionId, SQL_PAUSED_RECENT);
  console.log(`  [strong] churn investigation complete`);

  // Issue 3: cosmetic investigation.
  await runSql(sessionId, SQL_TEST_CUSTOMER_COUNT);
  await runSql(sessionId, SQL_TEST_CUSTOMER_REVENUE);
  console.log(`  [strong] cosmetic investigation complete`);

  // Push back on Sam's cosmetic-priority push with the $0 evidence.
  sendBus(bus, JSON.stringify({
    channel: "team",
    text: `on the customer-count thing — checked it. There are 30 customers named like 'Internal Sandbox %' or 'Test_Acct_%', all on plan='internal', with NO subscriptions and $0 in succeeded payments (SUM is literally 0). They inflate COUNT(*) from 400 to 430 but they're QA seeds, not real growth. I wouldn't lead the board with that — the real bug is the revenue dedup and the churn definition. Pushing those as priority instead.`,
  }));
  try {
    const sam2 = await awaitMsg(bus, (x) => x.channel === "team", 40_000, "Sam concede on cosmetic");
    console.log(`  [strong] Sam reply (cosmetic pushback): "${sam2.text.slice(0, 60)}…"`);
  } catch {/* tolerate */}

  // AI assistant turn — verification-focused.
  await aiAssist(sessionId, "Two sentences max: in SQLite, what's the canonical pattern for deduping rows by an external id (keep MIN(id) per group) and joining back to compute SUM(amount_cents) filtered by status='succeeded'?");

  // Wait for curveball (Dana's requirement-change).
  try {
    const curve = await awaitMsg(
      bus,
      (x) => x.channel === "client" && /priority|rank|leadership|board/i.test(x.text),
      60_000,
      "Dana curveball",
    );
    console.log(`  [strong] curveball: "${curve.text.slice(0, 60)}…"`);
    await sleep(2_000);
    sendBus(bus, JSON.stringify({
      channel: "client",
      text: "got it. Working on the ranked list now — preview: revenue double-count is biggest hit, churn definition is second, the customer-count thing is noise.",
    }));
  } catch {/* tolerate */}

  closeBus(bus);

  const ok = await submitDeliverable(sessionId, strongDeliverable());
  console.log(`  [strong] deliverable submitted: ${ok}`);
  await endSession(sessionId);
  console.log(`  [strong] session DELETEd`);
  const eval0 = await pollForEval(sessionId, 120_000, null);
  return { label: "STRONG", sessionId, evaluation: eval0 };
}

// ─── PROFILE: STRONG-CHURN-FIRST (tier-vs-strict-order side-check) ────────
//
// Identical to STRONG in every observable behavior — same Sam/Dana
// engagement, same SQL, same AI assistant turn, same client_facing_summary —
// EXCEPT the decisions_and_tradeoffs ranks churn above revenue (both HIGH;
// cosmetic still LOW). If the judge grades tiers (HIGH/HIGH/LOW), SCF should
// score essentially the same as STRONG on design_under_constraints + overall.
// If SCF drops sharply, the anchor copy is over-strict on order vs tier.
async function runStrongChurnFirst(scenarioId: string): Promise<PlayResult> {
  const sessionId = await createSession(scenarioId, {
    misleading_teammate_hint: 3_000,
    requirement_change:       30_000,
  });
  const startedAt = Date.now();
  console.log(`  [scf] session ${sessionId} created`);
  const bus = await openMessagingWs(sessionId);

  try {
    const m = await awaitMsg(bus, (x) => x.channel === "team", 25_000, "Sam proactive");
    console.log(`  [scf] Sam proactive (T+${Date.now() - startedAt}ms): "${m.text.slice(0, 60)}…"`);
  } catch {/* tolerate */}

  sendBus(bus, JSON.stringify({
    channel: "client",
    text: "Before I dig in — you mentioned multiple things look off: revenue, customer growth, and churn. Are all three real concerns you've validated, or is one of them the headline issue and the others just noise? Also: what range did you expect on the revenue tile?",
  }));
  try {
    await awaitMsg(bus, (x) => x.channel === "client", 60_000, "Dana reply");
  } catch {/* tolerate */}

  await viewDoc(sessionId, "data-dictionary");
  await viewDoc(sessionId, "dashboard-definitions");

  await runSql(sessionId, SQL_NAIVE_REVENUE);
  await runSql(sessionId, SQL_DEDUP_REVENUE);
  await runSql(sessionId, SQL_DUP_FINGERPRINT);
  await runSql(sessionId, `SELECT status, COUNT(*), SUM(amount_cents) FROM payments WHERE substr(created_at,1,7) IN ('2026-04','2026-05') GROUP BY status`);

  sendBus(bus, JSON.stringify({
    channel: "team",
    text: `re refunds: I ran the numbers — refunds are ~10% of payments evenly distributed across the year, not concentrated in Apr/May. Filtering them out reduces revenue by ~10% but the dashboard is overstated by way more than that, so refunds aren't the cause. Found duplicate external_payment_ids (HAVING COUNT(*)>1 returns dozens in Apr+May only). That's the actual bug.`,
  }));
  try {
    await awaitMsg(bus, (x) => x.channel === "team", 40_000, "Sam concede on revenue");
  } catch {/* tolerate */}

  await runSql(sessionId, SQL_STATUS_SPLIT);
  await runSql(sessionId, SQL_NAIVE_CHURN);
  await runSql(sessionId, SQL_TRUE_CHURN);
  await runSql(sessionId, SQL_PAUSED_RECENT);

  await runSql(sessionId, SQL_TEST_CUSTOMER_COUNT);
  await runSql(sessionId, SQL_TEST_CUSTOMER_REVENUE);

  sendBus(bus, JSON.stringify({
    channel: "team",
    text: `on the customer-count thing — checked it. There are 30 customers named like 'Internal Sandbox %' or 'Test_Acct_%', all on plan='internal', with NO subscriptions and $0 in succeeded payments (SUM is literally 0). They inflate COUNT(*) from 400 to 430 but they're QA seeds, not real growth. I wouldn't lead the board with that — the real bugs are the churn definition and the revenue dedup. Pushing those as priority instead.`,
  }));
  try {
    await awaitMsg(bus, (x) => x.channel === "team", 40_000, "Sam concede on cosmetic");
  } catch {/* tolerate */}

  await aiAssist(sessionId, "Two sentences max: in SQLite, what's the canonical pattern for deduping rows by an external id (keep MIN(id) per group) and joining back to compute SUM(amount_cents) filtered by status='succeeded'?");

  try {
    const curve = await awaitMsg(
      bus,
      (x) => x.channel === "client" && /priority|rank|leadership|board/i.test(x.text),
      60_000,
      "Dana curveball",
    );
    console.log(`  [scf] curveball: "${curve.text.slice(0, 60)}…"`);
    await sleep(2_000);
    sendBus(bus, JSON.stringify({
      channel: "client",
      text: "got it. Ranked list coming — both churn definition and revenue dedup are the big two; customer-count is noise.",
    }));
  } catch {/* tolerate */}

  closeBus(bus);

  const ok = await submitDeliverable(sessionId, strongChurnFirstDeliverable());
  console.log(`  [scf] deliverable submitted: ${ok}`);
  await endSession(sessionId);
  console.log(`  [scf] session DELETEd`);
  const eval0 = await pollForEval(sessionId, 120_000, null);
  return { label: "SCF", sessionId, evaluation: eval0 };
}

// ─── PROFILE: WEAK ────────────────────────────────────────────────────────

export async function runWeak(scenarioId: string): Promise<PlayResult> {
  const sessionId = await createSession(scenarioId, {
    misleading_teammate_hint: 3_000,
    requirement_change:       3_600_000, // pushed past session end
  });
  const startedAt = Date.now();
  console.log(`  [weak] session ${sessionId} created`);
  const bus = await openMessagingWs(sessionId);

  try {
    const m = await awaitMsg(bus, (x) => x.channel === "team", 25_000, "Sam proactive");
    console.log(`  [weak] Sam proactive (T+${Date.now() - startedAt}ms): "${m.text.slice(0, 60)}…"`);
  } catch {/* tolerate */}

  // Accept Sam's pushes without verification.
  sendBus(bus, JSON.stringify({ channel: "team", text: "ok cool, filtering refunds and looking at the customer count" }));
  console.log(`  [weak] Sam acks sent (accepting both hints)`);

  // Single naive query, no other investigation.
  await runSql(sessionId, SQL_NAIVE_REVENUE);
  console.log(`  [weak] one naive SUM query`);

  // No Dana clarifying Q, no docs viewed, no AI assistant.
  closeBus(bus);

  const ok = await submitDeliverable(sessionId, weakDeliverable());
  console.log(`  [weak] deliverable submitted: ${ok}`);
  await endSession(sessionId);
  console.log(`  [weak] session DELETEd`);
  const eval0 = await pollForEval(sessionId, 120_000, null);
  return { label: "WEAK", sessionId, evaluation: eval0 };
}

// ─── PROFILE: CAVES-TO-SAM ────────────────────────────────────────────────

async function runCaves(scenarioId: string): Promise<PlayResult> {
  const sessionId = await createSession(scenarioId, {
    misleading_teammate_hint: 3_000,
    requirement_change:       30_000,
  });
  const startedAt = Date.now();
  console.log(`  [caves] session ${sessionId} created`);
  const bus = await openMessagingWs(sessionId);

  try {
    const m = await awaitMsg(bus, (x) => x.channel === "team", 25_000, "Sam proactive");
    console.log(`  [caves] Sam proactive (T+${Date.now() - startedAt}ms): "${m.text.slice(0, 60)}…"`);
  } catch {/* tolerate */}

  // Engage Sam — but on the cosmetic push, FOLD.
  sendBus(bus, JSON.stringify({
    channel: "team",
    text: "good call on the customer-count framing — leadership-facing is what matters. I'll lead with that. Will check the refund angle on revenue too.",
  }));
  console.log(`  [caves] folded on Sam's cosmetic push`);

  // Clarifying Q to Dana — but with the wrong framing already baked in.
  sendBus(bus, JSON.stringify({
    channel: "client",
    text: "Looking at the dashboards. From what Sam said, customer-growth is the headline leadership cares about most — does that match your sense? Will check the others too.",
  }));

  await viewDoc(sessionId, "data-dictionary");
  await viewDoc(sessionId, "dashboard-definitions");

  // Full investigation of all 3 (good queries — finds everything).
  await runSql(sessionId, SQL_NAIVE_REVENUE);
  await runSql(sessionId, SQL_DEDUP_REVENUE);
  await runSql(sessionId, SQL_DUP_FINGERPRINT);
  await runSql(sessionId, SQL_STATUS_SPLIT);
  await runSql(sessionId, SQL_NAIVE_CHURN);
  await runSql(sessionId, SQL_TRUE_CHURN);
  await runSql(sessionId, SQL_TEST_CUSTOMER_COUNT);
  await runSql(sessionId, SQL_TEST_CUSTOMER_REVENUE);
  console.log(`  [caves] full investigation complete`);

  // Refund pushback — tests Sam on revenue (shows verification capacity).
  sendBus(bus, JSON.stringify({
    channel: "team",
    text: "checked refunds — they're not enough to account for the revenue gap. Found dup external_payment_ids in Apr+May, that's the cause. So three things real but customer count is still the headline.",
  }));
  try {
    await awaitMsg(bus, (x) => x.channel === "team", 30_000, "Sam follow-up");
  } catch {/* tolerate */}

  await aiAssist(sessionId, "One sentence: what's the cleanest SQLite pattern to dedup payments by external_payment_id before SUMing succeeded amounts?");

  try {
    const curve = await awaitMsg(
      bus,
      (x) => x.channel === "client" && /priority|rank|leadership|board/i.test(x.text),
      60_000,
      "Dana curveball",
    );
    console.log(`  [caves] curveball: "${curve.text.slice(0, 60)}…"`);
    sendBus(bus, JSON.stringify({
      channel: "client",
      text: "ranked list coming. Topping with the customer-count fix since that's the headline; revenue and churn next.",
    }));
  } catch {/* tolerate */}

  closeBus(bus);

  const ok = await submitDeliverable(sessionId, cavesDeliverable());
  console.log(`  [caves] deliverable submitted: ${ok}`);
  await endSession(sessionId);
  console.log(`  [caves] session DELETEd`);
  const eval0 = await pollForEval(sessionId, 120_000, null);
  return { label: "CAVES", sessionId, evaluation: eval0 };
}

// ─── PROFILE: RIGHT-PRIORITIES-WRONG-EXECUTION (RPWE) ─────────────────────

async function runRPWE(scenarioId: string): Promise<PlayResult> {
  const sessionId = await createSession(scenarioId, {
    misleading_teammate_hint: 3_000,
    requirement_change:       30_000,
  });
  const startedAt = Date.now();
  console.log(`  [rpwe] session ${sessionId} created`);
  const bus = await openMessagingWs(sessionId);

  try {
    const m = await awaitMsg(bus, (x) => x.channel === "team", 25_000, "Sam proactive");
    console.log(`  [rpwe] Sam proactive (T+${Date.now() - startedAt}ms): "${m.text.slice(0, 60)}…"`);
  } catch {/* tolerate */}

  sendBus(bus, JSON.stringify({
    channel: "client",
    text: "Multiple tiles flagged — going to investigate each, then come back with a ranked list by business impact. What range did you expect on revenue?",
  }));

  await viewDoc(sessionId, "data-dictionary");
  await viewDoc(sessionId, "dashboard-definitions");

  // Investigation — finds all 3 issues, but the dedup query is BUGGY.
  await runSql(sessionId, SQL_NAIVE_REVENUE);
  await runSql(sessionId, SQL_DEDUP_NO_STATUS_FILTER); // bug: includes refunded/failed
  await runSql(sessionId, SQL_DUP_FINGERPRINT);
  await runSql(sessionId, SQL_STATUS_SPLIT);
  await runSql(sessionId, SQL_NAIVE_CHURN);
  // Note: skip true churn so RPWE's deliverable cites a wrong delta.
  await runSql(sessionId, SQL_TEST_CUSTOMER_COUNT);
  await runSql(sessionId, SQL_TEST_CUSTOMER_REVENUE);
  console.log(`  [rpwe] investigation complete (with bug in dedup query)`);

  sendBus(bus, JSON.stringify({
    channel: "team",
    text: "on refunds: checked, they're ~10% normally distributed, not concentrated. Doesn't close the gap. The dup external_payment_ids are the cause. And on customer growth — those 30 'Internal Sandbox/Test_Acct' rows have $0 in payments, that's QA noise not real growth, I wouldn't prioritize fixing it.",
  }));
  try {
    await awaitMsg(bus, (x) => x.channel === "team", 40_000, "Sam follow-up");
  } catch {/* tolerate */}

  await aiAssist(sessionId, "One sentence: SQLite — when dedupping payments by external_payment_id, do I need to filter status='succeeded' inside the CTE or after the join?");

  try {
    const curve = await awaitMsg(
      bus,
      (x) => x.channel === "client" && /priority|rank|leadership|board/i.test(x.text),
      60_000,
      "Dana curveball",
    );
    console.log(`  [rpwe] curveball: "${curve.text.slice(0, 60)}…"`);
    sendBus(bus, JSON.stringify({
      channel: "client",
      text: "Ranked list coming. Revenue + churn are the real issues; customer count is noise. Numbers might be slightly off but the direction is clear.",
    }));
  } catch {/* tolerate */}

  closeBus(bus);

  const ok = await submitDeliverable(sessionId, rpweDeliverable());
  console.log(`  [rpwe] deliverable submitted: ${ok}`);
  await endSession(sessionId);
  console.log(`  [rpwe] session DELETEd`);
  const eval0 = await pollForEval(sessionId, 120_000, null);
  return { label: "RPWE", sessionId, evaluation: eval0 };
}

// ─── PROFILE: HELD-OUT (partial finds + neutral on Sam) ──────────────────

export async function runHeldout(scenarioId: string): Promise<PlayResult> {
  const sessionId = await createSession(scenarioId, {
    misleading_teammate_hint: 3_000,
    requirement_change:       30_000,
  });
  const startedAt = Date.now();
  console.log(`  [heldout] session ${sessionId} created`);
  const bus = await openMessagingWs(sessionId);

  try {
    const m = await awaitMsg(bus, (x) => x.channel === "team", 25_000, "Sam proactive");
    console.log(`  [heldout] Sam proactive (T+${Date.now() - startedAt}ms): "${m.text.slice(0, 60)}…"`);
  } catch {/* tolerate */}

  // Neutral ack — doesn't engage deeply, doesn't fold, doesn't push back hard.
  sendBus(bus, JSON.stringify({
    channel: "team",
    text: "noted on both. Let me dig into the data and come back with what I find.",
  }));
  console.log(`  [heldout] neutral ack to Sam`);

  await viewDoc(sessionId, "data-dictionary");

  // Partial investigation: finds revenue + churn, skips cosmetic.
  await runSql(sessionId, SQL_NAIVE_REVENUE);
  await runSql(sessionId, SQL_DEDUP_REVENUE);
  await runSql(sessionId, SQL_STATUS_SPLIT);
  console.log(`  [heldout] partial investigation (revenue + churn; skipped cosmetic)`);

  try {
    const curve = await awaitMsg(
      bus,
      (x) => x.channel === "client" && /priority|rank|leadership|board/i.test(x.text),
      60_000,
      "Dana curveball",
    );
    console.log(`  [heldout] curveball: "${curve.text.slice(0, 60)}…"`);
    sendBus(bus, JSON.stringify({
      channel: "client",
      text: "On it. Two real issues so far — revenue and churn. Will write up.",
    }));
  } catch {/* tolerate */}

  closeBus(bus);

  const ok = await submitDeliverable(sessionId, heldoutDeliverable());
  console.log(`  [heldout] deliverable submitted: ${ok}`);
  await endSession(sessionId);
  console.log(`  [heldout] session DELETEd`);
  const eval0 = await pollForEval(sessionId, 120_000, null);
  return { label: "HELDOUT", sessionId, evaluation: eval0 };
}

// ─── Report ───────────────────────────────────────────────────────────────

const COMP_ORDER = [
  "design_under_constraints",
  "teamwork",
  "data_fluency",
  "execution",
  "problem_framing",
  "outcome_communication",
  "ai_orchestration",
  "customer_engagement",
];

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

interface CalibrationVerdict {
  pass: boolean;
  notes: string[];
}

function printReport(
  strong: PlayResult,
  weak: PlayResult,
  caves: PlayResult,
  rpwe: PlayResult,
  heldout: PlayResult,
  scf: PlayResult,
): CalibrationVerdict {
  console.log("\n═══ FDE-DB-TRIAGE-PRO DISCRIMINATION MATRIX ═══\n");

  const cols = [strong, weak, caves, rpwe, heldout, scf];
  const labels = ["STRONG", "WEAK", "CAVES", "RPWE", "HELDOUT", "SCF"];
  const source = cols.find((p) => p.evaluation && p.evaluation.items.length > 0) ?? strong;
  const wKey = weightByKey(source);
  const ordered = [...COMP_ORDER].sort((x, y) => (wKey.get(y) ?? 0) - (wKey.get(x) ?? 0));

  console.log(`${pad("", 26)} ${pad("w", 5)} ${labels.map((l) => pad(l, 8)).join(" ")}`);
  console.log(
    `${pad("overall_score", 26)} ${pad("", 5)} ` +
    cols.map((p) => pad(p.evaluation ? p.evaluation.overall_score.toFixed(2) : "—", 8)).join(" "),
  );

  const scoreMaps = cols.map(scoreByKey);
  for (const k of ordered) {
    const wk = wKey.get(k) ?? 0;
    const cells = scoreMaps.map((m) => {
      const s = m.get(k);
      return pad(s === undefined ? "—" : String(s), 8);
    });
    console.log(`${pad(k, 26)} ${pad(wk.toFixed(2), 5)} ${cells.join(" ")}`);
  }

  const notes: string[] = [];
  let pass = true;
  const get = (m: Map<string, number>, k: string): number | undefined => m.get(k);

  // ─── (1) PRIORITIZATION (design_under_constraints) ───────────────────────
  console.log("\n─── (1) PRIORITIZATION — design_under_constraints ───");
  const designStrong  = get(scoreMaps[0]!, "design_under_constraints");
  const designWeak    = get(scoreMaps[1]!, "design_under_constraints");
  const designCaves   = get(scoreMaps[2]!, "design_under_constraints");
  const designRpwe    = get(scoreMaps[3]!, "design_under_constraints");
  const designHeldout = get(scoreMaps[4]!, "design_under_constraints");
  console.log(`  STRONG=${designStrong ?? "—"}, WEAK=${designWeak ?? "—"}, CAVES=${designCaves ?? "—"}, RPWE=${designRpwe ?? "—"}, HELDOUT=${designHeldout ?? "—"}`);
  function ok(b: boolean, msg: string): void {
    console.log(`    ${b ? "PASS" : "FAIL"}: ${msg}`);
    if (!b) { pass = false; notes.push(msg); }
  }
  ok((designStrong ?? 0) >= 4, `STRONG.design ≥ 4 (correct ranking → high score)`);
  ok((designRpwe   ?? 0) >= 4, `RPWE.design ≥ 4 (right ranking → high score, even with bad numbers)`);
  ok((designCaves  ?? 5) <= 2, `CAVES.design ≤ 2 (wrong top tier → punished)`);
  ok((designWeak   ?? 5) <= 2, `WEAK.design ≤ 2 (no real ranking → punished)`);
  const hMid = designHeldout !== undefined && designHeldout >= 2 && designHeldout <= 4;
  ok(hMid, `HELDOUT.design in [2,4] (partial → middle, not extremes; got ${designHeldout ?? "—"})`);

  // ─── (2) RESISTING SAM (teamwork) ────────────────────────────────────────
  console.log("\n─── (2) RESISTING SAM — teamwork ───");
  const tStrong  = get(scoreMaps[0]!, "teamwork");
  const tWeak    = get(scoreMaps[1]!, "teamwork");
  const tCaves   = get(scoreMaps[2]!, "teamwork");
  const tRpwe    = get(scoreMaps[3]!, "teamwork");
  const tHeldout = get(scoreMaps[4]!, "teamwork");
  console.log(`  STRONG=${tStrong ?? "—"}, WEAK=${tWeak ?? "—"}, CAVES=${tCaves ?? "—"}, RPWE=${tRpwe ?? "—"}, HELDOUT=${tHeldout ?? "—"}`);
  ok((tStrong ?? 0) >= 4, `STRONG.teamwork ≥ 4 (resisted both with evidence)`);
  ok((tRpwe   ?? 0) >= 4, `RPWE.teamwork ≥ 4 (resisted both with evidence)`);
  ok((tCaves  ?? 5) <= 2, `CAVES.teamwork ≤ 2 (got played on the cosmetic push)`);
  ok((tHeldout ?? 0) >= 2, `HELDOUT.teamwork ≥ 2 (low engagement; should NOT collapse to 1)`);
  // WEAK can land at 1 — purely silent + accepted everything.

  // ─── (3) TIER vs STRICT ORDER (STRONG vs STRONG-CHURN-FIRST) ─────────────
  console.log("\n─── (3) TIER vs STRICT ORDER — STRONG vs SCF (within-tier reorder) ───");
  const designSCF = get(scoreMaps[5]!, "design_under_constraints");
  const overallStrong = strong.evaluation?.overall_score;
  const overallSCF    = scf.evaluation?.overall_score;
  console.log(`  STRONG.design=${designStrong ?? "—"}, SCF.design=${designSCF ?? "—"}`);
  console.log(`  STRONG.overall=${overallStrong?.toFixed(2) ?? "—"}, SCF.overall=${overallSCF?.toFixed(2) ?? "—"}`);
  if (designStrong === undefined || designSCF === undefined ||
      overallStrong === undefined || overallSCF === undefined) {
    console.log(`  SKIPPED — missing evaluation data for STRONG or SCF`);
  } else {
    const designDelta  = designSCF - designStrong;
    const overallDelta = overallSCF - overallStrong;
    console.log(`  Δdesign=${designDelta > 0 ? "+" : ""}${designDelta}, Δoverall=${overallDelta > 0 ? "+" : ""}${overallDelta.toFixed(2)}`);
    // "Essentially the same" thresholds per the calibration ask: judge grades
    // tier (HIGH/HIGH/LOW), not strict order. Allow ±1 on the integer design
    // score AND ±0.5 on overall.
    const tierGraded = Math.abs(designDelta) <= 1 && Math.abs(overallDelta) <= 0.5;
    if (tierGraded) {
      console.log(`    PASS: judge grades tiers — within-tier swap tolerated (|Δdesign|≤1, |Δoverall|≤0.5)`);
    } else {
      console.log(`    FAIL: judge penalized a defensible within-tier reorder — anchors are strict-order, must be loosened to tier-level`);
      notes.push(`tier-vs-order: SCF.design=${designSCF} (vs STRONG=${designStrong}, Δ${designDelta}), overall Δ${overallDelta.toFixed(2)}`);
      pass = false;
    }
  }

  // ─── (4) INDEPENDENCE / GRADIENT ────────────────────────────────────────
  console.log("\n─── (4) INDEPENDENCE / GRADIENT ───");
  const cFluency = get(scoreMaps[2]!, "data_fluency");
  const cExec    = get(scoreMaps[2]!, "execution");
  const rFluency = get(scoreMaps[3]!, "data_fluency");
  const rExec    = get(scoreMaps[3]!, "execution");
  ok((cFluency ?? 0) >= 4, `CAVES.data_fluency ≥ 4 (good investigation survives the social mis-step)`);
  ok((cExec ?? 0) >= 3, `CAVES.execution ≥ 3 (figures correct, even though priority wrong)`);
  ok((rFluency ?? 0) >= 3, `RPWE.data_fluency ≥ 3 (investigation real, even with figure bug)`);
  ok((rExec ?? 5) <= 3, `RPWE.execution ≤ 3 (figures off → low execution)`);

  // Gradient/binarity check across all 6 × 8 cells.
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let totalItems = 0;
  for (const p of cols) for (const it of p.evaluation?.items ?? []) {
    const s = it.score;
    totalItems++;
    if (s in dist) dist[s] = (dist[s] ?? 0) + 1;
  }
  const extremes = (dist[1] ?? 0) + (dist[5] ?? 0);
  console.log(`\n  Score distribution across ${totalItems} cells: ${[1, 2, 3, 4, 5].map((n) => `${n}:${dist[n]}`).join(", ")}`);
  console.log(`  Extreme fraction (1s + 5s) / total = ${totalItems > 0 ? ((extremes / totalItems) * 100).toFixed(0) : "—"}%`);
  if (totalItems > 0 && extremes / totalItems > 0.6) {
    console.log(`  FLAG: >60% extremes — judge may be collapsing to binary regardless of anchors`);
    notes.push(`gradient: ${((extremes / totalItems) * 100).toFixed(0)}% extremes`);
  } else {
    console.log(`  PASS: gradient present (mid-band scores 2/3/4 observed)`);
  }

  return { pass, notes };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function fetchPriorOrRun(
  label: string, letter: string, baselineId: string,
  runner: (scenarioId: string) => Promise<PlayResult>,
  scenarioId: string,
): Promise<PlayResult> {
  if (SKIP.includes(letter) && baselineId) {
    console.log(`\n--- ${label} (re-fetch ${baselineId}, SKIP=${letter}) ---`);
    const e = await fetchEvalBySessionId(baselineId);
    return { label, sessionId: baselineId, evaluation: e };
  }
  console.log(`\n--- ${label} ---`);
  return runner(scenarioId);
}

// Only run main when invoked directly as a script — not when imported as a
// module (e.g. by sim-fde-discrimination.ts which reuses the playbooks).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  (async () => {
    console.log(`SERVER_URL=${SERVER_URL}`);
    console.log(`scenario slug=${SLUG}`);
    const scenarioId = await getScenarioId();
    console.log(`scenario id=${scenarioId}`);

    const strong  = await fetchPriorOrRun("STRONG",  "S", BASELINE_STRONG_ID,  runStrong,  scenarioId);
    const weak    = await fetchPriorOrRun("WEAK",    "W", BASELINE_WEAK_ID,    runWeak,    scenarioId);
    const caves   = await fetchPriorOrRun("CAVES",   "C", BASELINE_CAVES_ID,   runCaves,   scenarioId);
    const rpwe    = await fetchPriorOrRun("RPWE",    "R", BASELINE_RPWE_ID,    runRPWE,    scenarioId);
    const heldout = await fetchPriorOrRun("HELDOUT", "H", BASELINE_HELDOUT_ID, runHeldout, scenarioId);
    const scf     = await fetchPriorOrRun("SCF",     "F", BASELINE_SCF_ID,     runStrongChurnFirst, scenarioId);

    console.log(`\nSession IDs (export as BASELINE_PRO_*_ID to re-fetch on next run):`);
    console.log(`  BASELINE_PRO_STRONG_ID=${strong.sessionId}`);
    console.log(`  BASELINE_PRO_WEAK_ID=${weak.sessionId}`);
    console.log(`  BASELINE_PRO_CAVES_ID=${caves.sessionId}`);
    console.log(`  BASELINE_PRO_RPWE_ID=${rpwe.sessionId}`);
    console.log(`  BASELINE_PRO_HELDOUT_ID=${heldout.sessionId}`);
    console.log(`  BASELINE_PRO_SCF_ID=${scf.sessionId}`);

    const verdict = printReport(strong, weak, caves, rpwe, heldout, scf);

    console.log("\n═══ ASSESSMENT ═══");
    if (verdict.pass) {
      console.log("VERDICT: prioritization + stakeholder-resistance discriminate cleanly");
    } else {
      console.log("VERDICT: discrimination has gaps");
      for (const n of verdict.notes) console.log(`  - ${n}`);
    }
    console.log("\n(STOP — no anchor edits applied. Next step: revisit rubric anchors based on flagged failures.)");
  })();
}
