// Acceptance verifier for Slice 5.4b — L4 interactive verification.
//
// Two sessions submit the SAME passing deliverable (correct dedup'd figures
// from ground_truth.json). The only difference is the end-of-session DEFENSE:
//
//   STRONG: the candidate answers each verifier question with a substantive,
//           correct justification of their work.
//   WEAK:   the candidate cannot defend it — every answer is "I don't know."
//
// Expectation (the slice's contract): a deliverable that PASSES on paper but
// CANNOT be defended scores LOWER on the defended competencies. Concretely:
//   - both sessions fire the verification beat + emit a verification transcript,
//   - Stage A emits defense_weak=true for the WEAK run, false for the STRONG run,
//   - Stage B scores the WEAK run's flagged competencies BELOW the STRONG run's
//     (no inversion), even though the deliverable text is byte-identical.
//
// The persona curveballs are pushed past session end so the only model calls are
// the verifier's question selection (1/session) and the Stage B judge (1/session).
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-verification.ts
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

// Fire verification a few seconds in; push the persona beats past session end.
const VERIFICATION_OFFSET_MS = 3_000;
const FAR_FUTURE_MS = 3_600_000;
// Default sweeper tick is 15s, so a beat due at T+3s fires at the next tick
// boundary — allow up to ~35s before declaring failure.
const PROMPT_WAIT_MS = 38_000;
const NEXT_WAIT_MS = 20_000;
const MAX_QUESTIONS = 5; // safety cap on the answer loop

const tokens = new Map<string, string>();
function authHeaders(sessionId: string): Record<string, string> {
  const t = tokens.get(sessionId);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let failures = 0;
function fail(msg: string): void { failures += 1; console.error("  FAIL:", msg); }
function pass(msg: string): void { console.log("  PASS:", msg); }

// ─── WS helpers ────────────────────────────────────────────────────────────

interface VerifierMsg {
  channel: "client" | "team" | "verifier";
  role: string;
  persona_name?: string;
  text: string;
  ts: string;
}
interface ErrMsg { type: "error"; code: string; message: string }
type Inbound = VerifierMsg | ErrMsg;

function openMessagingWs(sessionId: string): Promise<WS> {
  const wsBase = SERVER_URL.replace(/^http/, "ws");
  return new Promise((resolveOpen, rejectOpen) => {
    const token = tokens.get(sessionId);
    const protocols = token ? [`bearer.${token}`] : undefined;
    const ws = new WS(`${wsBase}/messages/${sessionId}`, protocols);
    ws.once("open", () => resolveOpen(ws));
    ws.once("error", (err) => rejectOpen(err));
  });
}

function awaitVerifier(ws: WS, timeoutMs: number, what: string): Promise<VerifierMsg> {
  return new Promise((resolveAw, rejectAw) => {
    const onMessage = (raw: WS.RawData) => {
      let parsed: Inbound;
      try { parsed = JSON.parse(raw.toString()) as Inbound; } catch { return; }
      if ((parsed as ErrMsg).type === "error") {
        cleanup();
        rejectAw(new Error(`server error: ${(parsed as ErrMsg).message}`));
        return;
      }
      const msg = parsed as VerifierMsg;
      if (msg.channel === "verifier") { cleanup(); resolveAw(msg); }
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectAw(new Error(`timeout (${timeoutMs}ms) waiting for ${what}`));
    }, timeoutMs);
    function cleanup() { clearTimeout(timer); ws.off("message", onMessage); }
    ws.on("message", onMessage);
  });
}

const CLOSING_RE = /that's everything|review is (already )?complete|already complete/i;

// ─── Ground truth + deliverable (identical for both runs) ───────────────────

interface GroundTruth {
  corrected_monthly_cents: Record<string, number>;
  overstatement_cents: number;
}
const repoRoot = resolve(here, "../../..");
const ground = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/ground_truth.json"), "utf8"),
) as GroundTruth;
function fmtUsd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function strongDeliverable() {
  const march = ground.corrected_monthly_cents["2026-03"]!;
  const april = ground.corrected_monthly_cents["2026-04"]!;
  const may = ground.corrected_monthly_cents["2026-05"]!;
  return {
    status: "submitted" as const,
    data: {
      corrected_monthly_revenue:
        `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) ` +
        `SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) FROM payments p JOIN dedup d ON d.keep_id=p.id ` +
        `GROUP BY 1 ORDER BY 1;\n\nResults: Mar ${fmtUsd(march)}, Apr ${fmtUsd(april)}, May ${fmtUsd(may)}.`,
      root_cause_finding:
        "Duplicate succeeded payments sharing external_payment_id were double-counted by the naive SUM; verified with a HAVING COUNT(*)>1 fingerprint and by showing refunds (~$30K/mo) don't close the ~$130K/mo gap.",
      client_facing_summary:
        `The dashboard overstated monthly revenue by about ${fmtUsd(ground.overstatement_cents)} across April and May. ` +
        `Corrected: Mar ${fmtUsd(march)}, Apr ${fmtUsd(april)}, May ${fmtUsd(may)}. Real revenue never changed.`,
      decisions_and_tradeoffs:
        "Dedup by MIN(id) per external_payment_id, then SUM where status='succeeded'. Refunds quantified and rejected. " +
        "Recommend an idempotency key in the Stripe-webhook ingest path so retries can't double-insert.",
    },
  };
}

// Substantive, correct justifications — used for the STRONG defense. The harness
// cycles through these; any extra questions reuse the last one.
const STRONG_ANSWERS = [
  "I deduplicated by keeping MIN(id) per external_payment_id among status='succeeded' rows, then summed amount_cents. I confirmed the duplicates with a HAVING COUNT(*)>1 fingerprint that returned real collisions.",
  "I verified the figure two ways: the dedup CTE returned three monthly totals that matched, and I checked that refunds only net ~$30K/mo while the naive-vs-corrected gap is ~$130K/mo, so refunds can't be the cause.",
  "I filtered on status='succeeded' so refunded and failed charges don't inflate the total, and I bucketed by substr(created_at,1,7) in UTC which I confirmed matches the dashboard's reporting window.",
];

async function postJson(sessionId: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify(body),
  });
}

async function createSession(scenarioId: string): Promise<string> {
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenarioId,
      beatTimingOverridesMs: {
        misleading_teammate_hint: FAR_FUTURE_MS,
        requirement_change: FAR_FUTURE_MS,
        verification: VERIFICATION_OFFSET_MS,
      },
    }),
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { sessionId: string; token?: string };
  if (body.token) tokens.set(body.sessionId, body.token);
  return body.sessionId;
}

// ─── One playthrough: submit deliverable, run dedup, defend ──────────────────

type Defense = "strong" | "weak";

async function playthrough(scenarioId: string, mode: Defense): Promise<string> {
  const sessionId = await createSession(scenarioId);
  console.log(`  [${mode}] session ${sessionId}`);

  // Run a dedup query + submit the (identical) correct deliverable up front so
  // the verifier's snapshot sees real work to probe BEFORE it fires at T+3s.
  await postJson(sessionId, `/api/sessions/${sessionId}/query`, {
    sql: "WITH d AS (SELECT MIN(id) keep FROM payments WHERE status='succeeded' GROUP BY external_payment_id) " +
      "SELECT substr(p.created_at,1,7) m, SUM(p.amount_cents) FROM payments p JOIN d ON d.keep=p.id GROUP BY 1 ORDER BY 1",
  }).catch(() => {});
  const dr = await postJson(sessionId, `/api/sessions/${sessionId}/deliverable`, strongDeliverable());
  if (!dr.ok) fail(`[${mode}] deliverable submit failed: ${dr.status}`);

  const ws = await openMessagingWs(sessionId);

  // Wait for the first verifier prompt.
  const first = await awaitVerifier(ws, PROMPT_WAIT_MS, `${mode} first verifier prompt`);
  console.log(`  [${mode}] verifier Q1: "${first.text.slice(0, 90)}…"`);

  // Answer loop: reply, wait for next verifier message; stop on the closing line.
  let answered = 0;
  let strongIdx = 0;
  for (let i = 0; i < MAX_QUESTIONS; i++) {
    const answer =
      mode === "strong"
        ? STRONG_ANSWERS[Math.min(strongIdx++, STRONG_ANSWERS.length - 1)]!
        : "I don't know.";
    ws.send(JSON.stringify({ channel: "verifier", text: answer }));
    answered += 1;
    let next: VerifierMsg;
    try {
      next = await awaitVerifier(ws, NEXT_WAIT_MS, `${mode} verifier follow-up`);
    } catch (err) {
      fail(`[${mode}] no verifier reply after answer ${answered}: ${(err as Error).message}`);
      break;
    }
    if (CLOSING_RE.test(next.text)) {
      console.log(`  [${mode}] verifier closed after ${answered} answer(s)`);
      break;
    }
    console.log(`  [${mode}] verifier Q${i + 2}: "${next.text.slice(0, 80)}…"`);
  }

  ws.close();
  await sleep(1_500); // telemetry flush

  // End → auto-eval.
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...authHeaders(sessionId) } });
  console.log(`  [${mode}] session DELETEd → auto-eval triggered`);
  return sessionId;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

interface EvalItem { competency: string; score: number; weight: number }
interface EvalRow { id: string; overall_score: number; status: string; items: EvalItem[] }

async function pollForEval(sessionId: string, timeoutMs: number): Promise<EvalRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const { data: row } = await supabase
      .from("evaluations")
      .select("id, overall_score, status")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (row) {
      const r = row as { id: string; overall_score: number | string; status: string };
      const { data: items } = await supabase
        .from("evaluation_items")
        .select("competency, score, weight")
        .eq("evaluation_id", r.id);
      return {
        id: r.id,
        overall_score: Number(r.overall_score),
        status: r.status,
        items: (items ?? []) as EvalItem[],
      };
    }
  }
  return null;
}

interface UnitRow { competency_key: string; kind: string; value: unknown }
async function readUnits(sessionId: string): Promise<UnitRow[]> {
  const { data } = await supabase
    .from("evidence_units")
    .select("competency_key, kind, value")
    .eq("session_id", sessionId);
  return (data ?? []) as UnitRow[];
}

async function countEvents(sessionId: string, type: string): Promise<number> {
  const { count } = await supabase
    .from("events")
    .select("seq", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("type", type);
  return count ?? 0;
}

// ─── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("verify-verification");

  const { data: scenarioRow, error: scenErr } = await supabase
    .from("scenarios").select("id").eq("slug", SLUG).single();
  if (scenErr || !scenarioRow) {
    console.error("scenario lookup failed:", scenErr?.message);
    process.exit(1);
  }
  const scenarioId = scenarioRow.id as string;

  console.log("\n[setup] cooling down 60s for Gemini rate-limit window…");
  await sleep(60_000);

  console.log("\n[1/2] STRONG-defense playthrough");
  const strongId = await playthrough(scenarioId, "strong");

  console.log("\n[interlude] cooling down 60s before WEAK run…");
  await sleep(60_000);

  console.log("\n[2/2] WEAK-defense playthrough");
  const weakId = await playthrough(scenarioId, "weak");

  console.log("\n[poll] waiting for evaluations…");
  const strongEval = await pollForEval(strongId, 90_000);
  const weakEval = await pollForEval(weakId, 90_000);

  // ── [a] verification actually happened on both ──────────────────────────
  console.log("\n[a] verification fired + transcript persisted");
  for (const [label, sid] of [["strong", strongId], ["weak", weakId]] as const) {
    const prompts = await countEvents(sid, "verification.prompt");
    const responses = await countEvents(sid, "verification.response");
    if (prompts >= 2) pass(`[${label}] ${prompts} verification.prompt events`);
    else fail(`[${label}] expected ≥2 verification.prompt events, got ${prompts}`);
    if (responses >= 1) pass(`[${label}] ${responses} verification.response events`);
    else fail(`[${label}] expected ≥1 verification.response event, got ${responses}`);
  }

  // ── [b] Stage A defense_weak units ──────────────────────────────────────
  console.log("\n[b] Stage A defense_weak units");
  const strongUnits = await readUnits(strongId);
  const weakUnits = await readUnits(weakId);

  const strongEngaged = strongUnits.find((u) => u.kind === "verification_engaged");
  if (strongEngaged) pass("[strong] verification_engaged unit present");
  else fail("[strong] verification_engaged unit missing");

  const strongDW = strongUnits.filter((u) => u.kind === "defense_weak");
  const weakDW = weakUnits.filter((u) => u.kind === "defense_weak");
  const isWeak = (u: UnitRow) => (u.value as { weak?: boolean })?.weak === true;

  if (strongDW.length > 0 && strongDW.every((u) => !isWeak(u)))
    pass(`[strong] all ${strongDW.length} defense_weak unit(s) weak=false`);
  else fail(`[strong] expected all defense_weak=false, got ${JSON.stringify(strongDW.map((u) => u.value))}`);

  const weakFlagged = weakDW.filter(isWeak);
  if (weakFlagged.length > 0)
    pass(`[weak] ${weakFlagged.length} competency(ies) flagged defense_weak: ${weakFlagged.map((u) => u.competency_key).join(", ")}`);
  else fail(`[weak] expected ≥1 defense_weak=true unit, got ${JSON.stringify(weakDW.map((u) => u.value))}`);

  // ── [c] the core gate: weak defense scores lower on flagged competencies ──
  console.log("\n[c] Stage B reflects the defense (identical deliverable)");
  if (!strongEval || !weakEval || strongEval.status !== "complete" || weakEval.status !== "complete") {
    fail(`evaluations not both complete (strong=${strongEval?.status ?? "missing"}, weak=${weakEval?.status ?? "missing"})`);
  } else {
    const sBy = new Map(strongEval.items.map((i) => [i.competency, i.score]));
    const wBy = new Map(weakEval.items.map((i) => [i.competency, i.score]));
    const flaggedKeys = [...new Set(weakFlagged.map((u) => u.competency_key))];
    // Fall back to execution if the verifier happened to flag nothing parseable.
    const keys = flaggedKeys.length > 0 ? flaggedKeys : ["execution"];

    let anyDrop = false;
    let inversion = false;
    for (const k of keys) {
      const s = sBy.get(k);
      const w = wBy.get(k);
      if (s === undefined || w === undefined) continue;
      console.log(`  ${k}: STRONG=${s}/5  WEAK=${w}/5  Δ=${s - w >= 0 ? "+" : ""}${s - w}`);
      if (w < s) anyDrop = true;
      if (w > s) inversion = true;
    }
    if (anyDrop && !inversion)
      pass("weak defense scored lower on ≥1 flagged competency, no inversion");
    else if (inversion)
      fail("INVERSION — a flagged competency scored HIGHER under weak defense");
    else
      fail("weak defense did NOT score lower on any flagged competency (defense not reflected)");

    console.log(`  overall: STRONG=${strongEval.overall_score.toFixed(2)}  WEAK=${weakEval.overall_score.toFixed(2)}`);
    if (weakEval.overall_score <= strongEval.overall_score)
      pass("weak overall ≤ strong overall (identical deliverable, weaker defense)");
    else fail(`weak overall ${weakEval.overall_score} > strong overall ${strongEval.overall_score}`);
  }

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
