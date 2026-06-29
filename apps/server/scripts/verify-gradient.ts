// Calibration step 2 — gradient + independence check.
//
// Step 1 (verify-discrimination.ts) showed clean separation between a
// scripted-strong and scripted-weak playthrough (4.95 vs 1.00, spread
// +3.95, no inversions). But the per-competency deltas were nearly all
// maxed at +4 — consistent with the judge handling extremes well while
// collapsing the realistic middle to ceiling or floor.
//
// This step runs THREE mixed profiles against fde-db-triage and reports
// them alongside the existing STRONG/WEAK baselines so we can see whether
// scores are INDEPENDENT (within-profile mix matches the profile), have
// a GRADIENT (2s/3s/4s actually appear, not just 5s and 1s), order
// correctly, and avoid the BINARY (only-5-or-1) failure mode per
// competency.
//
// PROFILE A — technically strong, socially absent:
//   correct figures + dedup queries; zero client messages, zero Sam
//   messages, zero AI assistant turns, terse client_facing_summary.
//   Expects: high data_fluency / execution / design; low engagement / teamwork / outcome_comm / ai_orch.
//
// PROFILE B — process strong, technically wrong:
//   clarifying Q to Dana, both docs, thank Sam for the refund hint,
//   AI-assistant turn pursuing the refund red herring, calmly absorb the
//   curveball, then submit INFLATED naive figures with "refunds" as the
//   cause but in clean board-ready prose.
//   Expects: high problem_framing / engagement / teamwork / outcome_comm; low data_fluency / execution.
//
// PROFILE C — near-miss execution:
//   brief Dana question + docs + lots of broad-scan SELECT * queries
//   (compute drain + poor selectivity) + 2 long AI prompts (token drain)
//   + dedup query MISSING the status='succeeded' filter so the captured
//   monthly figures include refunded/failed rows. Right insight, sibling
//   oversight, wrong figures by >2%. No upstream-fix recommendation.
//   Expects: data_fluency ~4, execution ~3, design ~2-3 (NOT 5, NOT 1).
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-gradient.ts

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

// Baselines from prior runs. Override via env if you re-run upstream steps.
//   STRONG, WEAK: from verify-discrimination step 1.
//   A: from the first verify-gradient run (saved here so we don't waste a
//   Gemini call re-running an already-clean playthrough). When re-running
//   only B/C after fixes, pass SKIP=A.
// Baselines re-established under JUDGE_PROMPT_VERSION=2 (the "3 = meets bar is
// earned" tightening). The prior v1 defaults are stale; re-score under the new
// prompt if the judge changes again (drift detection flags the version bump).
const BASELINE_STRONG_ID = process.env.BASELINE_STRONG_ID ?? "f42fbde7-d4f3-455a-a3e7-25ad5b8bffe5";
const BASELINE_WEAK_ID   = process.env.BASELINE_WEAK_ID   ?? "c66032bd-c737-4350-ae53-a3c2dadab2c8";
const BASELINE_A_ID      = process.env.BASELINE_A_ID      ?? "281cfe0a-c9bb-42fd-bb30-f5b7843695c5";
const BASELINE_B_ID      = process.env.BASELINE_B_ID      ?? "e1c33afb-75d3-446c-8972-aef44f922734";
const BASELINE_C_ID      = process.env.BASELINE_C_ID      ?? "93a30f84-c7a0-488f-aa82-a7ff7bfb6687";
// SKIP="A" or "AB" or "ABC" — for any letter in SKIP we fetch the baseline
// instead of running. (STRONG/WEAK are always fetched.)
const SKIP_PROFILES = (process.env.SKIP ?? "").toUpperCase();

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function isQuotaError(message: string): boolean {
  return /RateLimitError|RESOURCE_EXHAUSTED|quota|429/i.test(message);
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

// MessageBus — a persistent WS listener that queues every PersonaMsg it sees.
// Replaces the attach-detach handler pattern that dropped messages arriving
// between awaitMsg calls (the bug that caused PROFILE B's curveball to be
// lost — when the requirement_change beat fired during the /api/chat call,
// no listener was attached and the WS message was emitted-and-dropped).
// Now: messages arrive → match against any pending waiter → if no waiter
// matches, push to buffer → next awaitMsg sees the buffered message first.
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
      // Match against the first pending waiter whose predicate accepts it.
      for (let i = 0; i < bus.waiters.length; i++) {
        const w = bus.waiters[i]!;
        if (w.predicate(msg)) {
          bus.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
      }
      // No waiter — buffer for a future awaitMsg.
      bus.buffer.push(msg);
    });
    ws.once("open", () => resolveOpen(bus));
    ws.once("error", (err) => rejectOpen(err));
    ws.once("close", () => { bus.closed = true; });
  });
}

function closeBus(bus: MessageBus): void {
  for (const w of bus.waiters.splice(0)) {
    clearTimeout(w.timer);
    w.reject(new Error("bus closed"));
  }
  bus.ws.close();
}

function sendBus(bus: MessageBus, raw: string): void {
  bus.ws.send(raw);
}

function awaitMsg(
  bus: MessageBus,
  predicate: (msg: PersonaMsg) => boolean,
  timeoutMs: number,
  what: string,
): Promise<PersonaMsg> {
  return new Promise((resolveAw, rejectAw) => {
    // Buffered messages take priority — they arrived before this awaitMsg
    // even started, so they should be consumed first.
    for (let i = 0; i < bus.buffer.length; i++) {
      const msg = bus.buffer[i]!;
      if (predicate(msg)) { bus.buffer.splice(i, 1); resolveAw(msg); return; }
    }
    const waiter: MessageBus["waiters"][number] = {
      predicate,
      resolve: resolveAw,
      reject: rejectAw,
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

// ─── Result shape ──────────────────────────────────────────────────────────

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
  log: string[];
}

function note(p: PlayResult, line: string): void {
  p.log.push(line);
  console.log(`  [${p.label.toLowerCase()}] ${line}`);
}

// ─── Session helpers ───────────────────────────────────────────────────────

async function createSession(
  scenarioId: string,
  beatOverrides: Record<string, number>,
): Promise<string> {
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId, beatTimingOverridesMs: beatOverrides }),
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { sessionId: string; token?: string };
  if (body.token) tokens.set(body.sessionId, body.token);
  return body.sessionId;
}

async function pollForEval(sessionId: string, timeoutMs: number): Promise<EvaluationRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const got = await fetchEvalBySessionId(sessionId);
    if (got) return got;
  }
  return null;
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

// ─── PROFILE A — technically strong, socially absent ───────────────────────

async function runProfileA(scenarioId: string): Promise<PlayResult> {
  // Curveball pushed past session end.
  const sessionId = await createSession(scenarioId, {
    misleading_teammate_hint: 3_000,
    requirement_change:       3_600_000,
  });
  const result: PlayResult = { label: "A", sessionId, evaluation: null, log: [] };
  const startedAt = Date.now();
  note(result, `session ${sessionId} created (technically-strong, socially-absent)`);

  const ws = await openMessagingWs(sessionId);

  // Just consume Sam's proactive ping — never reply.
  try {
    const m = await awaitMsg(ws, (x) => x.channel === "team", 25_000, "Sam proactive");
    note(result, `Sam proactive (T+${Date.now() - startedAt}ms) consumed silently: "${m.text.slice(0, 60)}…"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    note(result, `Sam proactive SKIP (${msg.slice(0, 60)})`);
  }

  // Intentionally NO Dana message, NO Sam message, NO AI assistant.

  // Technical work: view docs (research signal, not social).
  for (const docId of ["data-dictionary", "revenue-dashboard-definition"]) {
    const r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/docs/${docId}/view`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) }, body: "{}",
    });
    if (!r.ok) note(result, `doc view ${docId} failed: ${r.status}`);
  }
  note(result, "viewed both docs (technical research)");

  // Same precise query path as STRONG: naive → dedup → fingerprint.
  const naiveSql = `SELECT substr(created_at,1,7) AS month, SUM(amount_cents) AS cents FROM payments WHERE status='succeeded' AND substr(created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY substr(created_at,1,7) ORDER BY month`;
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ sql: naiveSql }),
  });
  const dedupSql = `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) AS cents FROM payments p JOIN dedup d ON d.keep_id=p.id WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY substr(p.created_at,1,7) ORDER BY month`;
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ sql: dedupSql }),
  });
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ sql: "SELECT external_payment_id, COUNT(*) FROM payments WHERE status='succeeded' GROUP BY external_payment_id HAVING COUNT(*)>1 LIMIT 5" }),
  });
  note(result, "ran naive SUM + dedup CTE + duplicate fingerprint");

  closeBus(ws);

  const march = ground.corrected_monthly_cents["2026-03"]!;
  const april = ground.corrected_monthly_cents["2026-04"]!;
  const may   = ground.corrected_monthly_cents["2026-05"]!;
  // Correct figures + correct root cause + correct rec, but client_facing_summary
  // is one terse sentence (anti-social).
  const deliv = {
    status: "submitted" as const,
    data: {
      corrected_monthly_revenue:
        `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) ` +
        `SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) FROM payments p JOIN dedup d ON d.keep_id=p.id ` +
        `WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1;\n\n` +
        `Results: Mar ${fmtUsd(march)}, Apr ${fmtUsd(april)}, May ${fmtUsd(may)}.`,
      root_cause_finding:
        "Duplicate succeeded payments (~8% of Apr+May succeeded rows) sharing external_payment_id were double-counted by the naive SUM. " +
        "Verified by HAVING COUNT(*)>1 fingerprint; refunds quantified and rejected.",
      client_facing_summary:
        `Corrected: Mar ${fmtUsd(march)}, Apr ${fmtUsd(april)}, May ${fmtUsd(may)}. Cause: duplicate webhook payments.`,
      decisions_and_tradeoffs:
        "Dedup approach: MIN(id) per external_payment_id then SUM amount_cents where status='succeeded'. " +
        "Recommend adding an idempotency key check in the Stripe webhook ingest path to prevent retries from double-inserting.",
    },
  };
  const dr = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) }, body: JSON.stringify(deliv),
  });
  if (dr.ok) note(result, "deliverable submitted (correct figures + terse client_facing_summary)");
  else note(result, `deliverable submit FAILED: ${dr.status}`);

  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...authHeaders(sessionId) } });
  note(result, "session DELETEd → auto-eval triggered");
  return result;
}

// ─── PROFILE B — process strong, technically wrong ─────────────────────────

async function runProfileB(scenarioId: string): Promise<PlayResult> {
  // Curveball at T+30s. Two constraints:
  //   - The scheduler ticks every 15s (services/scheduler.ts TICK_MS) and
  //     fires beats at the first sweep where due_ts <= now. A due_ts close
  //     to session-end can be missed entirely if the next tick lands after
  //     DELETE — that's what burned us on the T+90s setting.
  //   - Persistent message buffer (openMessagingWs) absorbs the timing on
  //     the harness side: whenever the beat fires, the message stays
  //     queued until step 6's awaitMsg consumes it. So firing EARLIER is
  //     strictly safer; we don't need to align with our step ordering.
  const sessionId = await createSession(scenarioId, {
    misleading_teammate_hint: 3_000,
    requirement_change:       30_000,
  });
  const result: PlayResult = { label: "B", sessionId, evaluation: null, log: [] };
  const startedAt = Date.now();
  note(result, `session ${sessionId} created (process-strong, technically-wrong)`);

  const ws = await openMessagingWs(sessionId);

  // [1] Sam proactive.
  try {
    const m = await awaitMsg(ws, (x) => x.channel === "team", 25_000, "Sam proactive");
    note(result, `Sam proactive (T+${Date.now() - startedAt}ms): "${m.text.slice(0, 60)}…"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    note(result, `Sam proactive SKIP (${msg.slice(0, 60)})`);
  }

  await sleep(13_000);

  // [2] Clarifying Q to Dana (good problem-framing).
  try {
    sendBus(ws, JSON.stringify({
      channel: "client",
      text: "Which tile specifically, what number were you expecting, and when did this start? Want to make sure I'm investigating the right thing.",
    }));
    const dana = await awaitMsg(ws, (x) => x.channel === "client", 60_000, "Dana clarifying reply");
    note(result, `Dana clarifying reply: "${dana.text.slice(0, 60)}…"`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `Dana clarifying reply SKIP (${m.slice(0, 60)})`);
  }

  await sleep(13_000);

  // [3] View both docs.
  for (const docId of ["data-dictionary", "revenue-dashboard-definition"]) {
    const r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/docs/${docId}/view`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) }, body: "{}",
    });
    if (!r.ok) note(result, `doc view ${docId} failed: ${r.status}`);
  }
  note(result, "viewed both docs");

  // [4] Engage Sam — thank him for the hint, DON'T push back (accept the red herring).
  try {
    sendBus(ws, JSON.stringify({
      channel: "team",
      text: "Thanks Sam — good catch on refunds. Want to make sure I'm reading the schema right: when a refund happens, does that show up as a new row with a negative amount, or do you update the original payment's status?",
    }));
    const samReply = await awaitMsg(ws, (x) => x.channel === "team", 60_000, "Sam reply (accepted hint)");
    note(result, `Sam reply (no pushback, accepted hint): "${samReply.text.slice(0, 60)}…"`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `Sam reply SKIP (${m.slice(0, 60)})`);
  }

  await sleep(13_000);

  // [5] AI-assistant turn — pursuing the refund red herring thoughtfully.
  try {
    const cr = await fetch(`${SERVER_URL}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
      body: JSON.stringify({
        sessionId,
        prompt: "Two sentences max: in SQLite, what's the canonical pattern for computing monthly revenue while subtracting refund amounts, when refunds appear as separate rows with status='refunded' linking back to the original via external_payment_id?",
      }),
    });
    if (cr.ok) note(result, "AI-assistant turn (thoughtful, but pursuing red herring)");
    else {
      const body = await cr.text();
      note(result, `AI-assistant SKIP (HTTP ${cr.status}${isQuotaError(body) ? " quota" : ""})`);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `AI-assistant SKIP (${m.slice(0, 60)})`);
  }

  // [6] Wait for the curveball (Dana's requirement-change at T+30s).
  // The buffer absorbs early arrivals — if the beat already fired by now,
  // awaitMsg consumes it from the queue immediately. Long timeout is just
  // tail headroom for a delayed scheduler tick.
  try {
    note(result, `waiting up to 60s for Dana's curveball…`);
    const waitMs = 60_000;
    const curve = await awaitMsg(
      ws,
      (x) => x.channel === "client" && /leadership|board|3 months|three months|paragraph/i.test(x.text),
      waitMs,
      "Dana curveball",
    );
    note(result, `Dana curveball received: "${curve.text.slice(0, 80)}…"`);
    // [7] Respond calmly — absorb the requirement change.
    await sleep(2_000);
    sendBus(ws, JSON.stringify({
      channel: "client",
      text: "Understood — I'll have the corrected last-three-month figures plus a one-paragraph board explanation before end of session.",
    }));
    note(result, "calm acknowledgment sent to Dana");
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `Dana curveball SKIP (${m.slice(0, 60)})`);
  }

  // [8] Run ONE naive SUM only (no dedup, no fingerprint).
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({
      sql: `SELECT substr(created_at,1,7) AS month, SUM(amount_cents) AS cents FROM payments WHERE status='succeeded' AND substr(created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY substr(created_at,1,7) ORDER BY month`,
    }),
  });
  note(result, "ONE naive SUM query (no dedup, no fingerprint)");

  closeBus(ws);

  // [9] Submit deliverable — INFLATED naive figures, "refunds" cause, but cleanly written.
  const naiveMar = ground.naive_monthly_cents["2026-03"]!;
  const naiveApr = ground.naive_monthly_cents["2026-04"]!;
  const naiveMay = ground.naive_monthly_cents["2026-05"]!;
  const deliv = {
    status: "submitted" as const,
    data: {
      corrected_monthly_revenue:
        `SELECT substr(created_at,1,7) AS month, SUM(amount_cents) ` +
        `FROM payments WHERE status='succeeded' GROUP BY 1 ORDER BY 1;\n\n` +
        `Corrected monthly revenue (last 3 months): Mar ${fmtUsd(naiveMar)}, Apr ${fmtUsd(naiveApr)}, May ${fmtUsd(naiveMay)}.`,
      root_cause_finding:
        "The dashboard total is being inflated by duplicate-counted refund transactions: when a refund is issued, the original 'succeeded' payment remains in the SUM but the offsetting refund row is never deducted. The naive monthly sum therefore overstates true recognized revenue by approximately the total refund volume for the month.",
      client_facing_summary:
        `Dana — to confirm what you flagged: the 'monthly recognized revenue' tile has been overstating real revenue across Apr and May because the dashboard query sums all succeeded payments without netting out refunds issued in the same month. ` +
        `The corrected figures from the last three months are Mar ${fmtUsd(naiveMar)}, Apr ${fmtUsd(naiveApr)}, May ${fmtUsd(naiveMay)}. ` +
        `Real revenue never changed — the dashboard was double-counting refunded transactions. ` +
        `We'll update the dashboard's revenue query to subtract refund amounts and the tile will reflect the correct number going forward.`,
      decisions_and_tradeoffs:
        "Decision: trust Sam's hint about refund handling — corroborated by data-dictionary which confirms refunds land as separate rows linked by external_payment_id. " +
        "Tradeoff: chose to fix this in the dashboard query rather than the upstream ingest pipeline, because the source-of-truth payments table is correct (the refund rows are valid); only the dashboard's aggregation is wrong. " +
        "Followup: recommend a regression test that compares the dashboard total against a refunds-netted reference query nightly so this can't drift again.",
    },
  };
  const dr = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) }, body: JSON.stringify(deliv),
  });
  if (dr.ok) note(result, "deliverable submitted (INFLATED figures + clean board-ready prose)");
  else note(result, `deliverable submit FAILED: ${dr.status}`);

  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...authHeaders(sessionId) } });
  note(result, "session DELETEd → auto-eval triggered");
  return result;
}

// ─── PROFILE C — near-miss execution ───────────────────────────────────────

async function runProfileC(scenarioId: string): Promise<PlayResult> {
  const sessionId = await createSession(scenarioId, {
    misleading_teammate_hint: 3_000,
    requirement_change:       3_600_000,
  });
  const result: PlayResult = { label: "C", sessionId, evaluation: null, log: [] };
  const startedAt = Date.now();
  note(result, `session ${sessionId} created (near-miss execution)`);

  const ws = await openMessagingWs(sessionId);

  // [1] Sam proactive.
  try {
    const m = await awaitMsg(ws, (x) => x.channel === "team", 25_000, "Sam proactive");
    note(result, `Sam proactive (T+${Date.now() - startedAt}ms): "${m.text.slice(0, 60)}…"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    note(result, `Sam proactive SKIP (${msg.slice(0, 60)})`);
  }

  await sleep(13_000);

  // [2] Brief Dana clarifying question (some problem_framing signal).
  try {
    sendBus(ws, JSON.stringify({
      channel: "client",
      text: "Which tile, and what window are you comparing against?",
    }));
    const dana = await awaitMsg(ws, (x) => x.channel === "client", 60_000, "Dana reply (brief)");
    note(result, `Dana reply: "${dana.text.slice(0, 60)}…"`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `Dana reply SKIP (${m.slice(0, 60)})`);
  }

  closeBus(ws);

  // [3] View docs.
  for (const docId of ["data-dictionary", "revenue-dashboard-definition"]) {
    await fetch(`${SERVER_URL}/api/sessions/${sessionId}/docs/${docId}/view`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) }, body: "{}",
    });
  }
  note(result, "viewed both docs");

  // [4] BURN BUDGET — 15 broad SELECT * queries with no LIMIT, low selectivity.
  // 15 × 0.25 compute-minutes = 3.75 minutes used; trajectory will visibly drain
  // and the events log will show 15 wasteful queries the judge can see.
  const wasteSqls = [
    "SELECT * FROM payments",
    "SELECT * FROM customers",
    "SELECT * FROM subscriptions",
    "SELECT * FROM payments WHERE 1=1",
    "SELECT * FROM customers WHERE 1=1",
    "SELECT * FROM subscriptions WHERE 1=1",
    "SELECT * FROM payments WHERE id > 0",
    "SELECT * FROM payments WHERE amount_cents > 0",
    "SELECT * FROM payments WHERE created_at IS NOT NULL",
    "SELECT * FROM customers WHERE id IS NOT NULL",
    "SELECT * FROM subscriptions WHERE id IS NOT NULL",
    "SELECT * FROM payments WHERE status IS NOT NULL",
    "SELECT * FROM payments WHERE external_payment_id IS NOT NULL",
    "SELECT * FROM payments WHERE subscription_id IS NOT NULL",
    "SELECT * FROM payments WHERE id < 10000",
  ];
  for (const sql of wasteSqls) {
    await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
      body: JSON.stringify({ sql }),
    });
  }
  note(result, `burned compute: ${wasteSqls.length} broad-scan SELECT * queries (~${(wasteSqls.length * 0.25).toFixed(2)} compute-min)`);

  // [5] AI-assistant turns — two long prompts to burn tokens.
  try {
    await fetch(`${SERVER_URL}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
      body: JSON.stringify({
        sessionId,
        prompt: "I'm investigating a revenue dashboard discrepancy where the SUM of amount_cents in a payments table doesn't match the expected total. Walk me through the considerations when deciding whether to dedup payments by external_payment_id alone, or by a composite fingerprint of (external_payment_id, amount_cents, subscription_id), or by looking for rows created within N seconds of each other with otherwise-identical fields. What are the failure modes of each approach in a SQLite database that ingests from a Stripe-style webhook with at-least-once delivery semantics?",
      }),
    });
    note(result, "AI-assistant turn 1 (long, exploratory)");
  } catch (err) {
    note(result, `AI-assistant 1 SKIP (${(err instanceof Error ? err.message : String(err)).slice(0, 60)})`);
  }

  await sleep(13_000);

  try {
    await fetch(`${SERVER_URL}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
      body: JSON.stringify({
        sessionId,
        prompt: "Given a payments table where some succeeded payments have been duplicated by webhook retries, write out a complete SQLite CTE that deduplicates them by external_payment_id, keeping the row with the smallest id per group. Then aggregate monthly revenue. Explain each step.",
      }),
    });
    note(result, "AI-assistant turn 2 (long, exploratory)");
  } catch (err) {
    note(result, `AI-assistant 2 SKIP (${(err instanceof Error ? err.message : String(err)).slice(0, 60)})`);
  }

  // [6] Run the CORRECT dedup query and capture its values (proves data_fluency).
  const goodDedupRes = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({
      sql: `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) ` +
           `SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) AS cents FROM payments p JOIN dedup d ON d.keep_id=p.id ` +
           `WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1`,
    }),
  }).then((r) => r.json()) as { status: string; rows?: unknown[][] };
  if (goodDedupRes.status === "ok") note(result, "ran (correct) dedup CTE — data_fluency signal");

  // [7] Run the NEAR-MISS dedup query: dedup applied, but no status filter,
  // so refunded/failed rows leak into the SUM. Capture these as the
  // "wrong by >2%" figures we'll submit.
  const nearMissSql = `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments GROUP BY external_payment_id) ` +
                      `SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) AS cents FROM payments p JOIN dedup d ON d.keep_id=p.id ` +
                      `WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1`;
  const nearMissRes = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ sql: nearMissSql }),
  }).then((r) => r.json()) as { status: string; rows?: unknown[][] };

  let nearMissByMonth: Record<string, number> = {};
  if (nearMissRes.status === "ok" && Array.isArray(nearMissRes.rows)) {
    for (const row of nearMissRes.rows) {
      const [m, cents] = row as [string, number];
      nearMissByMonth[m] = cents;
    }
    note(result, `near-miss dedup (no status filter) → Mar ${fmtUsd(nearMissByMonth["2026-03"] ?? 0)}, Apr ${fmtUsd(nearMissByMonth["2026-04"] ?? 0)}, May ${fmtUsd(nearMissByMonth["2026-05"] ?? 0)}`);
  } else {
    note(result, `near-miss query FAILED: ${JSON.stringify(nearMissRes).slice(0, 100)}`);
    // Fall back to naive figures so the deliverable still submits.
    nearMissByMonth = { ...ground.naive_monthly_cents };
  }

  // [8] Deliverable: correct ROOT CAUSE, wrong figures, no upstream-fix rec.
  const mar = nearMissByMonth["2026-03"] ?? 0;
  const apr = nearMissByMonth["2026-04"] ?? 0;
  const may = nearMissByMonth["2026-05"] ?? 0;
  const deliv = {
    status: "submitted" as const,
    data: {
      corrected_monthly_revenue:
        `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments GROUP BY external_payment_id) ` +
        `SELECT substr(p.created_at,1,7), SUM(p.amount_cents) FROM payments p JOIN dedup d ON d.keep_id=p.id ` +
        `WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1;\n\n` +
        `Results: Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}.`,
      root_cause_finding:
        "Duplicate succeeded payments from webhook retries were being double-counted by the naive monthly SUM. " +
        "Same external_payment_id appears on 2+ rows for ~8% of Apr+May payments. " +
        "Refunds and timezone bucketing were checked and ruled out.",
      client_facing_summary:
        `The 'monthly recognized revenue' tile was overstating Apr and May because the dashboard query was double-counting some payments that the webhook ingest had inserted twice. ` +
        `Corrected figures: Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}. ` +
        `Real revenue never changed.`,
      decisions_and_tradeoffs:
        "Dedup by external_payment_id, keeping the lowest id per group, then SUM amount_cents grouped by month. " +
        "Verified the duplicate pattern with a HAVING COUNT(*)>1 fingerprint query. " +
        "Explored refund-subtraction and timezone-bucketing hypotheses and ruled them out before settling on the dedup approach.",
    },
  };
  const dr = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) }, body: JSON.stringify(deliv),
  });
  if (dr.ok) note(result, "deliverable submitted (correct insight, WRONG figures, no upstream-fix rec)");
  else note(result, `deliverable submit FAILED: ${dr.status}`);

  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...authHeaders(sessionId) } });
  note(result, "session DELETEd → auto-eval triggered");
  return result;
}

// ─── Report ────────────────────────────────────────────────────────────────

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

// Expected directions per profile (the user-stated test cases).
const A_HIGH = ["data_fluency", "execution", "design_under_constraints"];
const A_LOW  = ["customer_engagement", "teamwork", "outcome_communication", "ai_orchestration"];
const B_HIGH = ["problem_framing", "customer_engagement", "teamwork", "outcome_communication"];
const B_LOW  = ["data_fluency", "execution"];

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
  strong: PlayResult,
  weak:   PlayResult,
  a:      PlayResult,
  b:      PlayResult,
  c:      PlayResult,
): { pass: boolean; failures: string[] } {
  console.log("\n═══ GRADIENT + INDEPENDENCE CHECK ═══\n");

  const cols = [strong, weak, a, b, c];
  const labels = ["STRONG", "WEAK", "A", "B", "C"];

  // Header.
  console.log(
    `${pad("", 26)} ${pad("w", 5)} ${labels.map((l) => pad(l, 9)).join(" ")}`,
  );
  // Overall scores row.
  console.log(
    `${pad("overall_score", 26)} ${pad("", 5)} ` +
    cols.map((p) => pad(p.evaluation ? p.evaluation.overall_score.toFixed(2) : "—", 9)).join(" "),
  );

  // Per-competency rows, sorted by weight desc.
  const wKey = weightByKey(strong);
  const ordered = [...COMP_ORDER].sort((x, y) => (wKey.get(y) ?? 0) - (wKey.get(x) ?? 0));
  const scoreMaps = cols.map(scoreByKey);

  // Track all observed scores per competency for binarity check.
  const observed: Record<string, Set<number>> = {};
  for (const k of COMP_ORDER) observed[k] = new Set<number>();

  for (const k of ordered) {
    const wk = wKey.get(k) ?? 0;
    const cells = scoreMaps.map((m) => {
      const s = m.get(k);
      if (s !== undefined) observed[k]!.add(s);
      return pad(s === undefined ? "—" : String(s), 9);
    });
    console.log(`${pad(k, 26)} ${pad(wk.toFixed(2), 5)} ${cells.join(" ")}`);
  }

  const failures: string[] = [];

  // ─── INDEPENDENCE ────────────────────────────────────────────────────────
  console.log("\nINDEPENDENCE");
  function describeProfile(p: PlayResult, hi: string[], lo: string[]): boolean {
    const sm = scoreByKey(p);
    if (sm.size === 0) {
      console.log(`  PROFILE ${p.label}: no evaluation — INCONCLUSIVE`);
      failures.push(`independence-${p.label}: no evaluation`);
      return false;
    }
    const hiScores = hi.map((k) => ({ k, s: sm.get(k) ?? 0 }));
    const loScores = lo.map((k) => ({ k, s: sm.get(k) ?? 0 }));
    const hiMean = hiScores.reduce((a2, x) => a2 + x.s, 0) / Math.max(hiScores.length, 1);
    const loMean = loScores.reduce((a2, x) => a2 + x.s, 0) / Math.max(loScores.length, 1);
    const gap = hiMean - loMean;
    const hiActualHigh = hiScores.filter((x) => x.s >= 4);
    const loActualLow  = loScores.filter((x) => x.s <= 2);
    const independent = hiActualHigh.length >= 1 && loActualLow.length >= 1 && gap >= 1.0;
    console.log(`  PROFILE ${p.label}: expected-high mean=${hiMean.toFixed(2)}, expected-low mean=${loMean.toFixed(2)}, gap=${gap.toFixed(2)}`);
    console.log(`    -> expected high: ${hiScores.map((x) => `${x.k}(${x.s})`).join(", ")}`);
    console.log(`    -> expected low:  ${loScores.map((x) => `${x.k}(${x.s})`).join(", ")}`);
    console.log(`    -> verdict: ${independent ? "INDEPENDENT (matches profile)" : "NOT INDEPENDENT (scores collapsed or wrong direction)"}`);
    if (!independent) failures.push(`independence-${p.label}: hiMean=${hiMean.toFixed(2)} loMean=${loMean.toFixed(2)} gap=${gap.toFixed(2)}`);
    return independent;
  }
  describeProfile(a, A_HIGH, A_LOW);
  describeProfile(b, B_HIGH, B_LOW);

  // ─── GRADIENT ────────────────────────────────────────────────────────────
  console.log("\nGRADIENT");
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const p of cols) for (const it of p.evaluation?.items ?? []) {
    const s = it.score;
    if (s in dist) dist[s] = (dist[s] ?? 0) + 1;
  }
  console.log(`  Score distribution across all 5 runs × 8 competencies = ${Object.values(dist).reduce((a2, n) => a2 + n, 0)} datapoints:`);
  console.log(`    ${[1, 2, 3, 4, 5].map((n) => `${n}: ${dist[n]}`).join(",  ")}`);
  const midCount = (dist[2] ?? 0) + (dist[3] ?? 0) + (dist[4] ?? 0);
  if (midCount === 0) failures.push(`gradient: zero mid (2/3/4) scores across 40 datapoints — judge is BINARY`);
  else console.log(`    -> mid (2/3/4) datapoints: ${midCount} / 40`);

  const cScores = scoreByKey(c);
  const cExec = cScores.get("execution");
  const cDesign = cScores.get("design_under_constraints");
  const cExecOnTarget = cExec !== undefined && cExec >= 2 && cExec <= 4;
  const cDesignOnTarget = cDesign !== undefined && cDesign >= 2 && cDesign <= 4;
  console.log(`  PROFILE C execution: ${cExec ?? "—"}/5 (target: ~3, NOT 5 or 1) → ${cExecOnTarget ? "ON-TARGET" : "OFF"}`);
  console.log(`  PROFILE C design:    ${cDesign ?? "—"}/5 (target: ~2-3, NOT 5 or 1) → ${cDesignOnTarget ? "ON-TARGET" : "OFF"}`);
  if (!cExecOnTarget) failures.push(`gradient: C.execution=${cExec} not mid (target 2-4)`);
  if (!cDesignOnTarget) failures.push(`gradient: C.design=${cDesign} not mid (target 2-4)`);

  // ─── ORDERING ────────────────────────────────────────────────────────────
  console.log("\nORDERING");
  const sOverall = strong.evaluation?.overall_score ?? NaN;
  const wOverall = weak.evaluation?.overall_score ?? NaN;
  const aOverall = a.evaluation?.overall_score ?? NaN;
  const bOverall = b.evaluation?.overall_score ?? NaN;
  const cOverall = c.evaluation?.overall_score ?? NaN;
  function ord(name: string, x: number): boolean {
    const ok = Number.isFinite(x) && x > wOverall && x < sOverall;
    console.log(`  ${name} (${x.toFixed(2)}) ∈ (WEAK ${wOverall.toFixed(2)}, STRONG ${sOverall.toFixed(2)}): ${ok ? "PASS" : "FAIL"}`);
    if (!ok) failures.push(`ordering: ${name} overall=${x} not strictly between WEAK and STRONG`);
    return ok;
  }
  ord("A", aOverall);
  ord("B", bOverall);
  ord("C", cOverall);

  const sScores = scoreByKey(strong);
  const sExec = sScores.get("execution");
  const cExecBelow = cExec !== undefined && sExec !== undefined && cExec < sExec;
  console.log(`  C.execution (${cExec ?? "—"}) < STRONG.execution (${sExec ?? "—"}): ${cExecBelow ? "PASS" : "FAIL"}`);
  if (!cExecBelow) failures.push(`ordering: C.execution=${cExec} not below STRONG.execution=${sExec}`);

  // ─── BINARITY ────────────────────────────────────────────────────────────
  console.log("\nBINARITY (the ceiling/floor failure mode)");
  const binaryKeys: string[] = [];
  for (const k of ordered) {
    const set = observed[k]!;
    const sortedScores = [...set].sort((x, y) => x - y);
    const onlyExtremes = sortedScores.length > 0 && sortedScores.every((s) => s === 1 || s === 5);
    console.log(`  ${pad(k, 26)} observed {${sortedScores.join(", ")}} → ${onlyExtremes ? "BINARY (flag)" : "gradient-capable"}`);
    if (onlyExtremes) binaryKeys.push(k);
  }
  if (binaryKeys.length > 0) failures.push(`binarity: ${binaryKeys.join(", ")} only ever scored 1 or 5`);

  // ─── JUDGE SUMMARIES ─────────────────────────────────────────────────────
  console.log("\nJUDGE SUMMARIES:");
  console.log(`  STRONG: ${strong.evaluation?.summary ?? "<missing>"}`);
  console.log(`  WEAK:   ${weak.evaluation?.summary ?? "<missing>"}`);
  console.log(`  A:      ${a.evaluation?.summary ?? "<missing>"}`);
  console.log(`  B:      ${b.evaluation?.summary ?? "<missing>"}`);
  console.log(`  C:      ${c.evaluation?.summary ?? "<missing>"}`);

  // ─── VERDICT ─────────────────────────────────────────────────────────────
  console.log("\nVERDICT:");
  if (failures.length === 0) {
    console.log("  PASS — judge shows independence, gradient, correct ordering, no binary competencies.");
    return { pass: true, failures: [] };
  }
  console.log(`  NEEDS TUNING — ${failures.length} issue(s):`);
  for (const f of failures) console.log(`    - ${f}`);
  return { pass: false, failures };
}

// ─── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("verify-gradient");

  const { data: scenarioRow, error: scenErr } = await supabase
    .from("scenarios").select("id").eq("slug", SLUG).single();
  if (scenErr || !scenarioRow) {
    console.error("scenario lookup failed:", scenErr?.message);
    process.exit(1);
  }
  const scenarioId = scenarioRow.id as string;

  // Baselines from step 1.
  console.log("\n[baselines] loading STRONG + WEAK evaluations from step 1");
  const strong: PlayResult = { label: "STRONG", sessionId: BASELINE_STRONG_ID, evaluation: null, log: [] };
  const weak:   PlayResult = { label: "WEAK",   sessionId: BASELINE_WEAK_ID,   evaluation: null, log: [] };
  strong.evaluation = await fetchEvalBySessionId(BASELINE_STRONG_ID);
  weak.evaluation   = await fetchEvalBySessionId(BASELINE_WEAK_ID);
  if (!strong.evaluation || strong.evaluation.status !== "complete") {
    console.error(`  STRONG baseline missing or status=error (${BASELINE_STRONG_ID}). Re-run verify-discrimination first.`);
    process.exit(1);
  }
  if (!weak.evaluation || weak.evaluation.status !== "complete") {
    console.error(`  WEAK baseline missing or status=error (${BASELINE_WEAK_ID}). Re-run verify-discrimination first.`);
    process.exit(1);
  }
  console.log(`  STRONG: overall=${strong.evaluation.overall_score.toFixed(2)} (${strong.evaluation.items.length} items)`);
  console.log(`  WEAK:   overall=${weak.evaluation.overall_score.toFixed(2)} (${weak.evaluation.items.length} items)`);

  // Per-profile orchestration: skip-via-env loads the baseline eval instead
  // of running. Cooldowns only happen between actual runs (not when we're
  // just fetching prior data).
  async function loadOrRun(
    letter: "A" | "B" | "C",
    baselineId: string,
    runner: (id: string) => Promise<PlayResult>,
    cooldownBeforeRun: boolean,
  ): Promise<PlayResult> {
    if (SKIP_PROFILES.includes(letter)) {
      if (!baselineId) {
        console.error(`  PROFILE ${letter} skipped but BASELINE_${letter}_ID is empty — cannot load baseline.`);
        process.exit(1);
      }
      console.log(`\n[PROFILE ${letter}] SKIPPED — loading baseline ${baselineId}`);
      const p: PlayResult = { label: letter, sessionId: baselineId, evaluation: null, log: [] };
      p.evaluation = await fetchEvalBySessionId(baselineId);
      if (!p.evaluation) console.log(`  [${letter.toLowerCase()}] WARNING: baseline evaluation not found`);
      else console.log(`  [${letter.toLowerCase()}] baseline loaded (status=${p.evaluation.status}, overall=${p.evaluation.overall_score})`);
      return p;
    }
    if (cooldownBeforeRun) {
      console.log(`\n[interlude] cooling down 60s before PROFILE ${letter}…`);
      await sleep(60_000);
    }
    console.log(`\n[PROFILE ${letter}] running`);
    const p = await runner(scenarioId);
    console.log(`  [${letter.toLowerCase()}] polling for evaluation (up to 90s)…`);
    p.evaluation = await pollForEval(p.sessionId, 90_000);
    if (!p.evaluation) console.log(`  [${letter.toLowerCase()}] WARNING: no evaluation row appeared`);
    else console.log(`  [${letter.toLowerCase()}] evaluation appeared (status=${p.evaluation.status}, overall=${p.evaluation.overall_score})`);
    return p;
  }

  // Startup cooldown only if any profile is going to actually run.
  const willRunAny = !"ABC".split("").every((l) => SKIP_PROFILES.includes(l));
  if (willRunAny) {
    console.log("\n[setup] cooling down 60s for Gemini rate-limit window…");
    await sleep(60_000);
  }

  // First runner doesn't need its own cooldown — startup cooldown above covered it.
  let cooldownNext = false;
  const a = await loadOrRun("A", BASELINE_A_ID, runProfileA, cooldownNext);
  if (!SKIP_PROFILES.includes("A")) cooldownNext = true;

  const b = await loadOrRun("B", BASELINE_B_ID, runProfileB, cooldownNext);
  if (!SKIP_PROFILES.includes("B")) cooldownNext = true;
  // Reset for C: only need cooldown if B actually ran.
  if (SKIP_PROFILES.includes("B")) cooldownNext = false;

  const c = await loadOrRun("C", BASELINE_C_ID, runProfileC, cooldownNext);

  // Print whatever we got, even if some are missing/errored.
  const { pass } = printReport(strong, weak, a, b, c);
  process.exit(pass ? 0 : 1);
})();
