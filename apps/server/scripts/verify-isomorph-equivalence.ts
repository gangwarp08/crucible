// Acceptance verifier for Slice 5.6 — isomorph equivalence.
//
// Runs the SAME scripted strong playthrough against two matched isomorphs
// (fde-db-triage and fde-db-triage-iso — same family, same 'mid' band, same
// radical structure, different seeded numbers) and checks the resulting scores
// are COMPARABLE. The only per-scenario difference in the playthrough is the
// corrected figures in the deliverable, read from each scenario's own
// ground_truth.json. If the family is well-formed, a candidate who does the
// same quality of work should score about the same on either isomorph.
//
// Single strong sample per scenario (an LLM-eval proxy, not a full
// distribution): asserts both land in the strong band and the overall + per-
// competency gaps are small. Persona + verification beats are pushed past
// session end so the only model calls are the two Stage B judges.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-isomorph-equivalence.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";
import WS from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const FAR = 3_600_000; // push beats past session end

// Equivalence tolerances (single-sample proxy).
const STRONG_FLOOR = 3.0;     // both matched strong runs should clear this overall
const MAX_OVERALL_GAP = 1.0;  // |overall_base - overall_iso|
const MAX_COMPETENCY_GAP = 2; // per-competency score gap ceiling

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

interface PersonaMsg { channel: string; role: string; text: string; ts: string }
interface ErrMsg { type: "error"; code: string; message: string }

function openWs(sessionId: string): Promise<WS> {
  const wsBase = SERVER_URL.replace(/^http/, "ws");
  return new Promise((res, rej) => {
    const token = tokens.get(sessionId);
    const ws = new WS(`${wsBase}/messages/${sessionId}`, token ? [`bearer.${token}`] : undefined);
    ws.once("open", () => res(ws));
    ws.once("error", (e) => rej(e));
  });
}
function awaitMsg(ws: WS, pred: (m: PersonaMsg) => boolean, timeoutMs: number, what: string): Promise<PersonaMsg> {
  return new Promise((res, rej) => {
    const onMessage = (raw: WS.RawData) => {
      let parsed: PersonaMsg | ErrMsg;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if ((parsed as ErrMsg).type === "error") { cleanup(); rej(new Error((parsed as ErrMsg).message)); return; }
      const m = parsed as PersonaMsg;
      if (pred(m)) { cleanup(); res(m); }
    };
    const timer = setTimeout(() => { cleanup(); rej(new Error(`timeout ${what}`)); }, timeoutMs);
    function cleanup() { clearTimeout(timer); ws.off("message", onMessage); }
    ws.on("message", onMessage);
  });
}

interface GroundTruth { corrected_monthly_cents: Record<string, number>; overstatement_cents: number }
function fmtUsd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface EvalItem { competency: string; score: number }
interface EvalRow { overall_score: number; status: string; items: EvalItem[] }

async function createSession(scenarioId: string): Promise<string> {
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenarioId,
      beatTimingOverridesMs: { misleading_teammate_hint: FAR, requirement_change: FAR, verification: FAR },
    }),
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { sessionId: string; token?: string };
  if (body.token) tokens.set(body.sessionId, body.token);
  return body.sessionId;
}

const DEDUP_SQL = `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) ` +
  `SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) FROM payments p JOIN dedup d ON d.keep_id=p.id ` +
  `WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1`;

/** Identical strong playthrough for either isomorph; deliverable figures come
 *  from that scenario's own ground truth. */
async function strongPlaythrough(slug: string, scenarioId: string, gt: GroundTruth): Promise<string> {
  const sessionId = await createSession(scenarioId);
  console.log(`  [${slug}] session ${sessionId}`);
  const post = (path: string, body: unknown) =>
    fetch(`${SERVER_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(sessionId) }, body: JSON.stringify(body) });

  // Clarify with Dana (best-effort — don't fail the run on quota).
  try {
    const ws = await openWs(sessionId);
    ws.send(JSON.stringify({ channel: "client", text: "Which tile, what figure did you expect, and when did it start? Want to pull the right window." }));
    await awaitMsg(ws, (m) => m.channel === "client", 60_000, "Dana reply").catch(() => undefined);
    // Push back on Sam with evidence to mirror a strong run.
    ws.send(JSON.stringify({ channel: "team", text: "Checked refunds — they net ~$30K/mo but the naive-vs-dedup gap is ~$130K/mo, so refunds don't close it. Looks like duplicate succeeded rows sharing external_payment_id. Webhook retry?" }));
    await awaitMsg(ws, (m) => m.channel === "team", 60_000, "Sam reply").catch(() => undefined);
    ws.close();
  } catch { /* messaging optional */ }

  // Queries: naive, dedup, duplicate fingerprint.
  await post(`/api/sessions/${sessionId}/query`, { sql: "SELECT substr(created_at,1,7) m, SUM(amount_cents) FROM payments WHERE status='succeeded' AND substr(created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1" }).catch(() => {});
  await post(`/api/sessions/${sessionId}/query`, { sql: DEDUP_SQL }).catch(() => {});
  await post(`/api/sessions/${sessionId}/query`, { sql: "SELECT external_payment_id, COUNT(*) FROM payments WHERE status='succeeded' GROUP BY external_payment_id HAVING COUNT(*)>1 LIMIT 5" }).catch(() => {});

  // Correct deliverable from THIS scenario's ground truth.
  const mar = gt.corrected_monthly_cents["2026-03"]!;
  const apr = gt.corrected_monthly_cents["2026-04"]!;
  const may = gt.corrected_monthly_cents["2026-05"]!;
  const deliv = {
    status: "submitted" as const,
    data: {
      corrected_monthly_revenue: `${DEDUP_SQL};\n\nResults: Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}.`,
      root_cause_finding: "Duplicate succeeded payments sharing external_payment_id were double-counted by the naive SUM (webhook-retry bug). Verified via HAVING COUNT(*)>1 fingerprint; refunds (~$30K/mo) don't close the ~$130K/mo gap. UTC bucketing verified correct.",
      client_facing_summary: `The dashboard overstated monthly revenue by about ${fmtUsd(gt.overstatement_cents)} across April and May. Corrected: Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}. Real revenue never changed — a recording bug double-counted some payments; we're fixing it upstream.`,
      decisions_and_tradeoffs: "Dedup by MIN(id) per external_payment_id, SUM where status='succeeded'. Refunds quantified + rejected. UTC verified. Recommend an idempotency key in the Stripe-webhook ingest so retries can't double-insert.",
    },
  };
  const dr = await post(`/api/sessions/${sessionId}/deliverable`, deliv);
  if (!dr.ok) fail(`[${slug}] deliverable submit failed: ${dr.status}`);

  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...authHeaders(sessionId) } });
  console.log(`  [${slug}] DELETEd → auto-eval`);
  return sessionId;
}

async function pollEval(sessionId: string, timeoutMs: number): Promise<EvalRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const { data: row } = await supabase
      .from("evaluations").select("id, overall_score, status")
      .eq("session_id", sessionId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (row) {
      const r = row as { id: string; overall_score: number | string; status: string };
      const { data: items } = await supabase.from("evaluation_items").select("competency, score").eq("evaluation_id", r.id);
      return { overall_score: Number(r.overall_score), status: r.status, items: (items ?? []) as EvalItem[] };
    }
  }
  return null;
}

async function scenarioId(slug: string): Promise<string> {
  const { data, error } = await supabase.from("scenarios").select("id").eq("slug", slug).single();
  if (error || !data) throw new Error(`scenario ${slug} lookup failed: ${error?.message}`);
  return (data as { id: string }).id;
}

(async () => {
  console.log("verify-isomorph-equivalence");

  // Confirm the two scenarios are a same-family, same-band isomorph pair.
  const { data: pair } = await supabase
    .from("scenarios").select("slug, difficulty, family_id, isomorph_of")
    .in("slug", ["fde-db-triage", "fde-db-triage-iso"]);
  const rows = (pair ?? []) as Array<{ slug: string; difficulty: string; family_id: string | null; isomorph_of: string | null }>;
  const base = rows.find((r) => r.slug === "fde-db-triage");
  const iso = rows.find((r) => r.slug === "fde-db-triage-iso");
  console.log("\n[a] family pairing");
  if (base && iso && base.family_id && base.family_id === iso.family_id) pass(`same family (${base.family_id})`);
  else fail(`family mismatch: ${JSON.stringify(rows)}`);
  if (base && iso && base.difficulty === iso.difficulty) pass(`same band (${base?.difficulty})`);
  else fail(`band mismatch: base=${base?.difficulty} iso=${iso?.difficulty}`);
  if (iso?.isomorph_of === "fde-db-triage") pass("iso.isomorph_of → fde-db-triage");
  else fail(`iso.isomorph_of = ${iso?.isomorph_of}`);

  const baseGt = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/ground_truth.json"), "utf8")) as GroundTruth;
  const isoGt = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/fde-db-triage-iso/ground_truth.json"), "utf8")) as GroundTruth;
  // Sanity: the isomorph really has different incidental numbers.
  if (baseGt.corrected_monthly_cents["2026-04"] !== isoGt.corrected_monthly_cents["2026-04"])
    pass("isomorph has different corrected figures (incidentals differ)");
  else fail("isomorph corrected figures identical to base — not a real isomorph");

  console.log("\n[setup] cooling 60s for Gemini rate-limit window…");
  await sleep(60_000);

  console.log("\n[1/2] strong playthrough — fde-db-triage");
  const baseSession = await strongPlaythrough("fde-db-triage", await scenarioId("fde-db-triage"), baseGt);

  console.log("\n[interlude] cooling 60s…");
  await sleep(60_000);

  console.log("\n[2/2] strong playthrough — fde-db-triage-iso");
  const isoSession = await strongPlaythrough("fde-db-triage-iso", await scenarioId("fde-db-triage-iso"), isoGt);

  console.log("\n[poll] evaluations…");
  const baseEval = await pollEval(baseSession, 90_000);
  const isoEval = await pollEval(isoSession, 90_000);

  console.log("\n[b] equivalence");
  if (!baseEval || !isoEval || baseEval.status !== "complete" || isoEval.status !== "complete") {
    fail(`evals not both complete (base=${baseEval?.status ?? "missing"}, iso=${isoEval?.status ?? "missing"})`);
  } else {
    console.log(`  overall: base=${baseEval.overall_score.toFixed(2)}  iso=${isoEval.overall_score.toFixed(2)}`);
    if (baseEval.overall_score >= STRONG_FLOOR && isoEval.overall_score >= STRONG_FLOOR)
      pass(`both strong runs clear the floor (≥ ${STRONG_FLOOR})`);
    else fail(`a strong run fell below ${STRONG_FLOOR}: base=${baseEval.overall_score}, iso=${isoEval.overall_score}`);

    const gap = Math.abs(baseEval.overall_score - isoEval.overall_score);
    if (gap <= MAX_OVERALL_GAP) pass(`overall gap ${gap.toFixed(2)} ≤ ${MAX_OVERALL_GAP} (comparable)`);
    else fail(`overall gap ${gap.toFixed(2)} > ${MAX_OVERALL_GAP} — isomorphs not comparable`);

    const isoBy = new Map(isoEval.items.map((i) => [i.competency, i.score]));
    let worst = 0; let worstKey = "";
    for (const it of baseEval.items) {
      const o = isoBy.get(it.competency);
      if (o === undefined) continue;
      const d = Math.abs(it.score - o);
      if (d > worst) { worst = d; worstKey = it.competency; }
    }
    console.log(`  largest per-competency gap: ${worstKey} Δ=${worst}`);
    if (worst <= MAX_COMPETENCY_GAP) pass(`largest competency gap ${worst} ≤ ${MAX_COMPETENCY_GAP}`);
    else fail(`competency ${worstKey} gap ${worst} > ${MAX_COMPETENCY_GAP}`);
  }

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
