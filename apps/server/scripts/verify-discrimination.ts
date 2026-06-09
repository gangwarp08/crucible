// Calibration step 1 — discrimination check.
//
// Runs two SCRIPTED playthroughs of fde-db-triage end to end, lets each
// auto-evaluate, and prints a side-by-side scorecard so we can see whether
// the judge actually separates a strong FDE from a weak one before we
// involve real candidates.
//
// STRONG: clarifying question to Dana, both docs viewed, naive SUM + dedup
//         CTE + duplicate fingerprint, push back on Sam with refund-delta
//         evidence (unlocks his webhook clue), one focused AI-assistant
//         turn, complete + correct deliverable from ground_truth.json.
//
// WEAK:   vague Dana message (no clarifier), zero docs, ONE naive SUM,
//         passive ack to Sam (no evidence, no pushback), zero AI-assistant
//         turns, incomplete deliverable with inflated naive figures and
//         "refunds" as cause (the red-herring trap).
//
// Both runs push Dana's requirement_change curveball past session end
// (the curveball needs its own slice to calibrate adaptability).
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-discrimination.ts
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

function openMessagingWs(sessionId: string): Promise<WS> {
  const wsBase = SERVER_URL.replace(/^http/, "ws");
  return new Promise((resolveOpen, rejectOpen) => {
    const ws = new WS(`${wsBase}/messages/${sessionId}`);
    ws.once("open", () => resolveOpen(ws));
    ws.once("error", (err) => rejectOpen(err));
  });
}

function awaitMsg(
  ws: WS,
  predicate: (msg: PersonaMsg) => boolean,
  timeoutMs: number,
  what: string,
): Promise<PersonaMsg> {
  return new Promise((resolveAw, rejectAw) => {
    const onMessage = (raw: WS.RawData) => {
      let parsed: Inbound;
      try { parsed = JSON.parse(raw.toString()) as Inbound; } catch { return; }
      if ((parsed as ErrMsg).type === "error") {
        cleanup();
        rejectAw(new Error(`server error: ${(parsed as ErrMsg).message}`));
        return;
      }
      const msg = parsed as PersonaMsg;
      if (predicate(msg)) { cleanup(); resolveAw(msg); }
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectAw(new Error(`timeout (${timeoutMs}ms) waiting for ${what}`));
    }, timeoutMs);
    function cleanup() { clearTimeout(timer); ws.off("message", onMessage); }
    ws.on("message", onMessage);
  });
}

// ─── Ground truth (drives the deliverable contents) ───────────────────────

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

// ─── Playthrough result shape ──────────────────────────────────────────────

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
  label: "STRONG" | "WEAK";
  sessionId: string;
  evaluation: EvaluationRow | null;
  log: string[];
}

function note(p: PlayResult, line: string): void {
  p.log.push(line);
  console.log(`  [${p.label.toLowerCase()}] ${line}`);
}

// ─── Create a fresh session ────────────────────────────────────────────────

async function createSession(scenarioId: string): Promise<string> {
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenarioId,
      beatTimingOverridesMs: {
        // Sam pings fast so we can run the harness in a few minutes,
        // not the scripted ~5 minutes. The curveball is pushed past
        // session end — calibrating adaptability needs its own slice.
        misleading_teammate_hint: 3_000,
        requirement_change:       3_600_000,
      },
    }),
  });
  if (!r.ok) {
    throw new Error(`session create failed: ${r.status} ${await r.text()}`);
  }
  const { sessionId } = (await r.json()) as { sessionId: string };
  return sessionId;
}

// ─── STRONG playthrough ────────────────────────────────────────────────────

async function runStrongPlaythrough(scenarioId: string): Promise<PlayResult> {
  const sessionId = await createSession(scenarioId);
  const result: PlayResult = {
    label: "STRONG", sessionId, evaluation: null, log: [],
  };
  const startedAt = Date.now();
  note(result, `session ${sessionId} created`);

  const ws = await openMessagingWs(sessionId);

  // [1] Wait for Sam's proactive refund hint.
  try {
    const samMsg = await awaitMsg(ws, (m) => m.channel === "team", 25_000, "Sam proactive");
    note(result, `Sam proactive (T+${Date.now() - startedAt}ms): "${samMsg.text.slice(0, 70)}…"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    note(result, `Sam proactive SKIP (${msg.slice(0, 60)})`);
  }

  await sleep(13_000);

  // [2] Clarifying question to Dana — should unlock beat-2 specifics.
  try {
    ws.send(JSON.stringify({
      channel: "client",
      text: "Which tile specifically, what number were you expecting, and when did this start? Want to make sure I'm pulling the right window.",
    }));
    const dana = await awaitMsg(ws, (m) => m.channel === "client", 60_000, "Dana reply");
    note(result, `Dana clarifying reply: "${dana.text.slice(0, 70)}…"`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `Dana clarifying reply SKIP (${m.slice(0, 60)})`);
  }

  await sleep(13_000);

  // [3] View both docs.
  for (const docId of ["data-dictionary", "revenue-dashboard-definition"]) {
    const r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/docs/${docId}/view`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!r.ok) note(result, `doc view ${docId} failed: ${r.status}`);
  }
  note(result, "viewed both docs");

  // [4] Naive SUM first — establishes the inflated baseline.
  const naiveSql = `
    SELECT substr(created_at, 1, 7) AS month, SUM(amount_cents) AS cents
    FROM payments
    WHERE status = 'succeeded'
      AND substr(created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
    GROUP BY substr(created_at, 1, 7)
    ORDER BY month
  `.trim();
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql: naiveSql }),
  });
  note(result, "naive monthly SUM query (inflated baseline)");

  // [5] Dedup CTE — produces the corrected figures.
  const dedupSql = `
    WITH dedup AS (
      SELECT MIN(id) AS keep_id
      FROM payments
      WHERE status = 'succeeded'
      GROUP BY external_payment_id
    )
    SELECT substr(p.created_at, 1, 7) AS month, SUM(p.amount_cents) AS cents
    FROM payments p
    JOIN dedup d ON d.keep_id = p.id
    WHERE substr(p.created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
    GROUP BY substr(p.created_at, 1, 7)
    ORDER BY month
  `.trim();
  const dedupRes = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql: dedupSql }),
  }).then((r) => r.json()) as { status: string; rows?: unknown[][] };
  if (dedupRes.status === "ok" && (dedupRes.rows ?? []).length === 3) {
    note(result, "dedup CTE query returned 3 monthly rows");
  } else {
    note(result, `dedup CTE FAILED: ${JSON.stringify(dedupRes).slice(0, 120)}`);
  }

  // [6] Duplicate fingerprint — proves the duplicates exist.
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sql: "SELECT external_payment_id, COUNT(*) FROM payments WHERE status='succeeded' GROUP BY external_payment_id HAVING COUNT(*) > 1 LIMIT 5",
    }),
  });
  note(result, "duplicate-fingerprint query (HAVING COUNT > 1)");

  await sleep(13_000);

  // [7] Push back on Sam with EVIDENCE — should unlock his webhook clue.
  try {
    const ws2 = await openMessagingWs(sessionId);
    ws2.send(JSON.stringify({
      channel: "team",
      text: "Hey Sam — checked refunds. They net out to maybe ~$30K/mo, but the gap between naive and corrected SUM is closer to ~$130K/mo. Doesn't close it. The smoking gun looks like duplicate succeeded rows sharing external_payment_id — ring a bell? Anything in the webhook ingest path that could cause that?",
    }));
    const samReply = await awaitMsg(ws2, (m) => m.channel === "team", 60_000, "Sam push-back reply");
    note(result, `Sam push-back reply: "${samReply.text.slice(0, 70)}…"`);
    ws2.close();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `Sam push-back SKIP (${m.slice(0, 60)})`);
  }

  await sleep(13_000);

  // [8] One AI-assistant turn (canonical SQLite dedup pattern).
  try {
    const cr = await fetch(`${SERVER_URL}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        prompt: "One sentence: in SQLite, when SUMming amount_cents from a payments table with duplicate rows sharing external_payment_id, what's the canonical dedup-then-SUM pattern?",
      }),
    });
    if (cr.ok) note(result, "AI-assistant turn (verified against own dedup query)");
    else {
      const body = await cr.text();
      note(result, `AI-assistant SKIP (HTTP ${cr.status}${isQuotaError(body) ? " quota" : ""})`);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `AI-assistant SKIP (${m.slice(0, 60)})`);
  }

  ws.close();

  // [9] Complete + correct deliverable.
  const march = ground.corrected_monthly_cents["2026-03"]!;
  const april = ground.corrected_monthly_cents["2026-04"]!;
  const may   = ground.corrected_monthly_cents["2026-05"]!;
  const deliv = {
    status: "submitted" as const,
    data: {
      corrected_monthly_revenue:
        `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) ` +
        `SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) FROM payments p JOIN dedup d ON d.keep_id=p.id ` +
        `WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1;\n\n` +
        `Results: Mar ${fmtUsd(march)}, Apr ${fmtUsd(april)}, May ${fmtUsd(may)}.`,
      root_cause_finding:
        "Duplicate succeeded payments (~8% of Apr+May succeeded rows) sharing the same external_payment_id were double-counted by the naive SUM. " +
        "Verified by HAVING COUNT(*)>1 fingerprint + by quantifying that refunds only account for ~$30K/mo of a ~$130K/mo gap. " +
        "UTC bucketing also ruled out (already correct).",
      client_facing_summary:
        `The dashboard was overstating monthly revenue by about ${fmtUsd(ground.overstatement_cents)} across April and May. ` +
        `Corrected figures are Mar ${fmtUsd(march)}, Apr ${fmtUsd(april)}, May ${fmtUsd(may)}. ` +
        `Real revenue never changed — the dashboard double-counted some payments due to a recording bug we're already fixing upstream.`,
      decisions_and_tradeoffs:
        "Dedup approach: kept MIN(id) per external_payment_id then SUMed amount_cents where status='succeeded'. " +
        "Refunds quantified and rejected as the cause. UTC bucketing verified-correct. " +
        "Recommend an idempotency-key check in the Stripe-webhook ingest path so retries can't double-insert — fixing it downstream in the dashboard would just paper over the data bug.",
    },
  };
  const dr = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(deliv),
  });
  if (dr.ok) note(result, "deliverable submitted (complete, correct figures, upstream-fix rec)");
  else note(result, `deliverable submit FAILED: ${dr.status} ${(await dr.text()).slice(0, 100)}`);

  // End → auto-eval.
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE" });
  note(result, "session DELETEd → auto-eval triggered");

  return result;
}

// ─── WEAK playthrough ──────────────────────────────────────────────────────

async function runWeakPlaythrough(scenarioId: string): Promise<PlayResult> {
  const sessionId = await createSession(scenarioId);
  const result: PlayResult = {
    label: "WEAK", sessionId, evaluation: null, log: [],
  };
  const startedAt = Date.now();
  note(result, `session ${sessionId} created`);

  const ws = await openMessagingWs(sessionId);

  // [1] Wait for Sam's proactive refund hint (unavoidable; Sam pings first).
  try {
    const samMsg = await awaitMsg(ws, (m) => m.channel === "team", 25_000, "Sam proactive");
    note(result, `Sam proactive (T+${Date.now() - startedAt}ms): "${samMsg.text.slice(0, 70)}…"`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `Sam proactive SKIP (${m.slice(0, 60)})`);
  }

  await sleep(13_000);

  // [2] Vague Dana message — no clarifier, no specifics.
  try {
    ws.send(JSON.stringify({
      channel: "client",
      text: "hey what's wrong with the dashboard",
    }));
    const dana = await awaitMsg(ws, (m) => m.channel === "client", 60_000, "Dana reply (vague)");
    note(result, `Dana reply to vague msg: "${dana.text.slice(0, 70)}…"`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `Dana reply SKIP (${m.slice(0, 60)})`);
  }

  // [3] SKIP both docs — no /docs/:id/view POST at all.
  note(result, "intentionally SKIPPED both docs (anti-pattern)");

  // [4] One naive SUM, no dedup, no fingerprint.
  const naiveSql = `
    SELECT substr(created_at, 1, 7) AS month, SUM(amount_cents) AS cents
    FROM payments
    WHERE status = 'succeeded'
      AND substr(created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
    GROUP BY substr(created_at, 1, 7)
    ORDER BY month
  `.trim();
  await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql: naiveSql }),
  });
  note(result, "ONE naive SUM query (no dedup, no fingerprint)");

  await sleep(13_000);

  // [5] Passive ack to Sam — no evidence, no pushback. Webhook clue stays locked.
  try {
    ws.send(JSON.stringify({
      channel: "team",
      text: "ok, let me check refunds",
    }));
    // Don't even wait for his reply — we just want the message logged.
    await sleep(8_000);
    note(result, "passive ack to Sam (no evidence, no pushback)");
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    note(result, `Sam ack SKIP (${m.slice(0, 60)})`);
  }

  // [6] ZERO AI-assistant turns — no /api/chat POST at all.
  note(result, "intentionally ZERO AI-assistant turns (anti-pattern)");

  ws.close();

  // [7] Incomplete deliverable with INFLATED (naive) figures + red-herring cause.
  const naiveMar = ground.naive_monthly_cents["2026-03"]!;
  const naiveApr = ground.naive_monthly_cents["2026-04"]!;
  const naiveMay = ground.naive_monthly_cents["2026-05"]!;
  const deliv = {
    status: "submitted" as const,
    data: {
      corrected_monthly_revenue:
        `SELECT substr(created_at,1,7), SUM(amount_cents) FROM payments WHERE status='succeeded' GROUP BY 1;\n\n` +
        `Mar ${fmtUsd(naiveMar)}, Apr ${fmtUsd(naiveApr)}, May ${fmtUsd(naiveMay)}.`,
      root_cause_finding:
        "Refunds aren't being subtracted from the dashboard total.",
      client_facing_summary:
        "We'll fix the refund handling and the numbers should look right.",
      decisions_and_tradeoffs:
        "n/a",
    },
  };
  const dr = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(deliv),
  });
  if (dr.ok) note(result, "deliverable submitted (inflated figures, red-herring cause, trivial tradeoffs)");
  else note(result, `deliverable submit FAILED: ${dr.status} ${(await dr.text()).slice(0, 100)}`);

  // End → auto-eval.
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE" });
  note(result, "session DELETEd → auto-eval triggered");

  return result;
}

// ─── Wait for the evaluation row to land ───────────────────────────────────

async function pollForEval(sessionId: string, timeoutMs: number): Promise<EvaluationRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const { data: row } = await supabase
      .from("evaluations")
      .select("id, overall_score, summary, status")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (row) {
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
  }
  return null;
}

// ─── Final report ──────────────────────────────────────────────────────────

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

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function printReport(strong: PlayResult, weak: PlayResult): { verdict: string; flags: string[] } {
  console.log("\n═══ DISCRIMINATION CHECK ═══\n");

  const sEval = strong.evaluation;
  const wEval = weak.evaluation;

  function evalHeader(label: string, p: PlayResult): void {
    const e = p.evaluation;
    if (!e) {
      console.log(`${label}: ${p.sessionId}  <no evaluation row>`);
      return;
    }
    const score = e.overall_score.toFixed(2);
    console.log(`${label}: ${p.sessionId}  overall_score: ${score} / 5   status: ${e.status}`);
  }
  evalHeader("STRONG", strong);
  evalHeader("WEAK  ", weak);

  const flags: string[] = [];

  if (sEval && wEval) {
    const spread = sEval.overall_score - wEval.overall_score;
    const sep = spread >= 1.5 ? "PASS" : "FAIL";
    console.log(`SPREAD: ${spread >= 0 ? "+" : ""}${spread.toFixed(2)} (≥ 1.5 separation: ${sep})`);
    if (spread < 1.5) flags.push(`no-separation flag: overall spread ${spread.toFixed(2)} < 1.5`);

    console.log("\nCOMPETENCY (sorted by weight desc)");
    console.log(`  ${pad("", 26)} ${pad("w", 5)} ${pad("STRONG", 9)} ${pad("WEAK", 8)} ${pad("Δ", 5)} FLAGS`);

    const sByKey = new Map(sEval.items.map((i) => [i.competency, i]));
    const wByKey = new Map(wEval.items.map((i) => [i.competency, i]));

    const ordered = [...COMP_ORDER].sort((a, b) => {
      const wa = sByKey.get(a)?.weight ?? 0;
      const wb = sByKey.get(b)?.weight ?? 0;
      return wb - wa;
    });

    interface Row { key: string; weight: number; sScore: number; wScore: number; delta: number }
    const rows: Row[] = [];

    for (const key of ordered) {
      const s = sByKey.get(key);
      const w = wByKey.get(key);
      if (!s || !w) {
        console.log(`  ${pad(key, 26)} MISSING (s=${!!s} w=${!!w})`);
        continue;
      }
      const delta = s.score - w.score;
      rows.push({ key, weight: s.weight, sScore: s.score, wScore: w.score, delta });
      const rowFlags: string[] = [];
      if (s.score <= 2) rowFlags.push("strictness");
      if (w.score >= 3) rowFlags.push("leniency");
      if (delta <= 0) rowFlags.push("INVERSION");
      console.log(
        `  ${pad(key, 26)} ${pad(s.weight.toFixed(2), 5)} ${pad(`${s.score}/5`, 9)} ${pad(`${w.score}/5`, 8)} ${pad(`${delta >= 0 ? "+" : ""}${delta}`, 5)} ${rowFlags.join(", ")}`,
      );
      if (s.score <= 2) flags.push(`strictness flag on STRONG.${key}: scored ${s.score}/5`);
      if (w.score >= 3) flags.push(`leniency flag on WEAK.${key}: scored ${w.score}/5`);
      if (delta <= 0) flags.push(`INVERSION flag on ${key}: STRONG=${s.score}, WEAK=${w.score}`);
    }

    if (rows.length > 0) {
      const sortedByGap = [...rows].sort((a, b) => b.delta - a.delta);
      const maxDelta = sortedByGap[0]!.delta;
      const minDelta = sortedByGap[sortedByGap.length - 1]!.delta;
      const largest = sortedByGap.filter((r) => r.delta === maxDelta).map((r) => `${r.key}(${r.delta >= 0 ? "+" : ""}${r.delta})`);
      const smallest = sortedByGap.filter((r) => r.delta === minDelta).map((r) => `${r.key}(${r.delta >= 0 ? "+" : ""}${r.delta})`);
      console.log(`\nLARGEST GAPS:  ${largest.join(", ")}`);
      console.log(`SMALLEST GAPS: ${smallest.join(", ")}`);
    }
  } else {
    flags.push(`evaluation missing — STRONG=${!!sEval}, WEAK=${!!wEval}`);
  }

  console.log("\nFLAGS:");
  if (flags.length === 0) console.log("  (none)");
  else for (const f of flags) console.log(`  - ${f}`);

  console.log("\nJUDGE SUMMARIES:");
  console.log(`  STRONG: ${sEval?.summary ?? "<missing>"}`);
  console.log(`  WEAK:   ${wEval?.summary ?? "<missing>"}`);

  let verdict: string;
  if (!sEval || !wEval) {
    verdict = "INCONCLUSIVE — one or both evaluations missing";
  } else {
    const spread = sEval.overall_score - wEval.overall_score;
    const hasInversion = flags.some((f) => f.startsWith("INVERSION"));
    const hasNoSep = spread < 1.5;
    const hasLeniency = flags.some((f) => f.startsWith("leniency flag"));
    const hasStrictness = flags.some((f) => f.startsWith("strictness flag"));
    if (hasInversion) verdict = `DOES NOT DISCRIMINATE — inversion(s) present`;
    else if (hasNoSep) verdict = `INSUFFICIENT SEPARATION — overall spread ${spread.toFixed(2)} < 1.5`;
    else if (hasLeniency || hasStrictness) verdict = `DISCRIMINATES BUT MISCALIBRATED — leniency/strictness flags present`;
    else verdict = `DISCRIMINATES CLEANLY — spread ${spread.toFixed(2)}, no inversions, no leniency ≥ 3 on WEAK, no strictness ≤ 2 on STRONG`;
  }

  console.log(`\nVERDICT: ${verdict}`);
  return { verdict, flags };
}

// ─── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("verify-discrimination");

  const { data: scenarioRow, error: scenErr } = await supabase
    .from("scenarios").select("id").eq("slug", SLUG).single();
  if (scenErr || !scenarioRow) {
    console.error("scenario lookup failed:", scenErr?.message);
    process.exit(1);
  }
  const scenarioId = scenarioRow.id as string;

  console.log("\n[setup] cooling down 60s for Gemini rate-limit window…");
  await sleep(60_000);

  console.log("\n[1/2] STRONG playthrough");
  const strong = await runStrongPlaythrough(scenarioId);
  console.log(`  [strong] polling for evaluation (up to 90s)…`);
  strong.evaluation = await pollForEval(strong.sessionId, 90_000);
  if (!strong.evaluation) console.log("  [strong] WARNING: no evaluation row appeared");
  else console.log(`  [strong] evaluation appeared (status=${strong.evaluation.status}, overall=${strong.evaluation.overall_score})`);

  console.log("\n[interlude] cooling down 60s before WEAK run…");
  await sleep(60_000);

  console.log("\n[2/2] WEAK playthrough");
  const weak = await runWeakPlaythrough(scenarioId);
  console.log(`  [weak] polling for evaluation (up to 90s)…`);
  weak.evaluation = await pollForEval(weak.sessionId, 90_000);
  if (!weak.evaluation) console.log("  [weak] WARNING: no evaluation row appeared");
  else console.log(`  [weak] evaluation appeared (status=${weak.evaluation.status}, overall=${weak.evaluation.overall_score})`);

  // If either is error/missing, the discrimination check can't be meaningful.
  if (
    !strong.evaluation || !weak.evaluation
    || strong.evaluation.status !== "complete"
    || weak.evaluation.status !== "complete"
  ) {
    console.log("\nFATAL: cannot run discrimination check — one or both evaluations failed.");
    console.log(`  STRONG: ${strong.evaluation?.status ?? "missing"}`);
    console.log(`  WEAK:   ${weak.evaluation?.status ?? "missing"}`);
    // Print whatever we have so the operator can see the partial state.
    printReport(strong, weak);
    process.exit(1);
  }

  const { verdict } = printReport(strong, weak);
  process.exit(verdict.startsWith("DISCRIMINATES CLEANLY") ? 0 : 1);
})();
