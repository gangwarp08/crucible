// verify-fork-discrimination.ts — Slice 7.5 acceptance (the point of the change).
//
// Runs TWO playthroughs on the fork clone that differ ONLY in the product-sense
// decision, holding the rest constant (same client clarify, same team
// engagement volume, same investigation):
//   PS-STRONG   — protects the user on Sam's shortcut + reasons about the cost,
//                 ships the RECONCILED figure.
//   PS-WEAK     — takes the shortcut (agrees, no user-impact reasoning), ships
//                 the OVERSTATED naive figure.
// Asserts the fork INCREASES design_under_constraints separation (strong ≫ weak)
// while the UNRELATED, held-constant competencies (teamwork, customer_engagement,
// problem_framing) stay comparable — the fork adds Product-Sense signal without
// disturbing other bands.
//
// Run: pnpm exec tsx scripts/verify-fork-discrimination.ts
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

const SUPABASE_URL = process.env.SUPABASE_URL ?? (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing Supabase creds"); process.exit(1); }
const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const COOLDOWN_MS = Number(process.env.FORK_COOLDOWN_MS ?? "60000");
const SLUG = "fde-db-triage-fork";
const FAR = 3_600_000, SHORTCUT_MS = 4_000;

const MIN_DESIGN_SEPARATION = 2;   // strong design − weak design

const tokens = new Map<string, string>();
const auth = (s: string) => { const t = tokens.get(s); return t ? { Authorization: `Bearer ${t}` } : {}; };
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, realtime: { transport: WebSocket as unknown as never } });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);

interface Msg { channel?: string; text?: string }
interface GT { naive_monthly_cents: Record<string, number>; corrected_monthly_cents: Record<string, number>; overstatement_cents: number }
const fmt = (c: number) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gt = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/ground_truth.json"), "utf8")) as GT;

function openWs(sessionId: string): Promise<WS> {
  const wsBase = SERVER_URL.replace(/^http/, "ws");
  return new Promise((res, rej) => { const t = tokens.get(sessionId); const ws = new WS(`${wsBase}/messages/${sessionId}`, t ? [`bearer.${t}`] : undefined); ws.once("open", () => res(ws)); ws.once("error", rej); });
}
async function createSession(scenarioId: string): Promise<string> {
  const r = await fetch(`${SERVER_URL}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenarioId, beatTimingOverridesMs: { shortcut_suggestion: SHORTCUT_MS, misleading_teammate_hint: FAR, requirement_change: FAR, verification: FAR } }) });
  if (!r.ok) throw new Error(`create failed: ${r.status}`);
  const b = (await r.json()) as { sessionId: string; token?: string };
  if (b.token) tokens.set(b.sessionId, b.token);
  return b.sessionId;
}
const DEDUP_SQL = `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) SELECT substr(p.created_at,1,7) m, SUM(p.amount_cents) FROM payments p JOIN dedup d ON d.keep_id=p.id WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1`;
const NAIVE_SQL = `SELECT substr(created_at,1,7) m, SUM(amount_cents) FROM payments WHERE status='succeeded' AND substr(created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1`;

async function play(mode: "protect" | "shortcut", scenarioId: string): Promise<string> {
  const sessionId = await createSession(scenarioId);
  console.log(`  [${mode}] session ${sessionId}`);
  const post = (p: string, b: unknown) => fetch(`${SERVER_URL}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth(sessionId) }, body: JSON.stringify(b) });
  const inbox: Msg[] = [];
  let ws: WS | undefined;
  try { ws = await openWs(sessionId); ws.on("message", (raw: WS.RawData) => { try { const m = JSON.parse(raw.toString()) as Msg; if (m.channel) inbox.push(m); } catch { /* */ } }); } catch { /* */ }

  // HELD CONSTANT across both modes: one client clarify + one team engagement.
  if (ws) {
    ws.send(JSON.stringify({ channel: "client", text: "Which tile and what figure did you expect, and when did it start? Want to pull the right window." }));
    await sleep(1_500);
    ws.send(JSON.stringify({ channel: "team", text: "hey Sam — starting to dig into the revenue numbers now, will keep you posted." }));
    await sleep(1_500);
  }

  // Investigation — both run the naive + dedup queries (held constant).
  await post(`/api/sessions/${sessionId}/query`, { sql: NAIVE_SQL }).catch(() => {});
  await post(`/api/sessions/${sessionId}/query`, { sql: DEDUP_SQL }).catch(() => {});

  // Wait for Sam's shortcut pitch, then diverge by mode.
  const shortcutRe = /ship|raw|skip|reconcil|overkill|close enough|those numbers|straight (monthly )?total/i;
  let saw = false;
  for (let i = 0; i < 25 && ws; i++) { if (inbox.some((m) => m.channel === "team" && shortcutRe.test(m.text ?? ""))) { saw = true; break; } await sleep(1_000); }
  if (ws && saw) {
    if (mode === "protect") {
      ws.send(JSON.stringify({ channel: "team", text: "i hear the deadline, but we can't ship the raw sum — it double-counts the retried webhook payments and overstates revenue by ~$130K/mo. the board would decide on a misleading number and we'd lose trust in the dashboard. i'll reconcile and send the correct figures, it's quick." }));
    } else {
      ws.send(JSON.stringify({ channel: "team", text: "yeah good call, makes sense — let's just ship the raw monthly totals to keep things moving. i'll send those over." }));
    }
    await sleep(3_000);
  }
  if (ws) { try { ws.close(); } catch { /* */ } }

  // Deliverable diverges: protect → reconciled; shortcut → naive.
  const src = mode === "protect" ? gt.corrected_monthly_cents : gt.naive_monthly_cents;
  const mar = src["2026-03"]!, apr = src["2026-04"]!, may = src["2026-05"]!;
  const data = mode === "protect"
    ? {
        corrected_monthly_revenue: `${DEDUP_SQL};\n\nReconciled: Mar ${fmt(mar)}, Apr ${fmt(apr)}, May ${fmt(may)}.`,
        root_cause_finding: "Duplicate succeeded payments sharing external_payment_id double-counted by the naive SUM (webhook-retry). Verified via HAVING COUNT(*)>1.",
        client_facing_summary: `Overstated by ~${fmt(gt.overstatement_cents)}. Reconciled: Mar ${fmt(mar)}, Apr ${fmt(apr)}, May ${fmt(may)}. We did NOT ship the raw figure — it would mislead the board.`,
        decisions_and_tradeoffs: "Declined the shortcut of shipping the raw SUM; reconciled by external_payment_id because the board needs an accurate number. Recommend an idempotency key upstream.",
      }
    : {
        corrected_monthly_revenue: `Monthly totals (straight SUM): Mar ${fmt(mar)}, Apr ${fmt(apr)}, May ${fmt(may)}.`,
        root_cause_finding: "Reported the raw monthly totals as-is to hit the deadline.",
        client_facing_summary: `Monthly revenue: Mar ${fmt(mar)}, Apr ${fmt(apr)}, May ${fmt(may)}. Shipped the raw numbers to move fast.`,
        decisions_and_tradeoffs: "Went with Sam's suggestion to ship the raw SUM and skip the reconciliation to save time.",
      };
  const dr = await post(`/api/sessions/${sessionId}/deliverable`, { status: "submitted", data });
  if (!dr.ok) fail(`[${mode}] deliverable submit failed: ${dr.status}`);
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...auth(sessionId) } });
  console.log(`  [${mode}] DELETEd → auto-eval (shortcut seen: ${saw})`);
  return sessionId;
}

interface EvalRow { overall_score: number; status: string; items: Array<{ competency: string; score: number | null }> }
async function pollEval(sessionId: string, timeoutMs: number): Promise<EvalRow | null> {
  const deadline = Date.now() + timeoutMs;
  let reeval = 0;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const { data: row } = await supabase.from("evaluations").select("id, overall_score, status").eq("session_id", sessionId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (row) {
      const r = row as { id: string; overall_score: number | string; status: string };
      // A transient LiteLLM 'fetch failed' lands a status='error' row. Re-trigger
      // analysis (delete-then-insert) up to twice rather than fail the run.
      if (r.status === "error" && reeval < 2) {
        reeval++;
        console.log(`  [${sessionId.slice(0, 8)}] eval status=error (transient) — re-evaluating (${reeval})`);
        await fetch(`${SERVER_URL}/api/review/sessions/${sessionId}/evaluate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
        await sleep(4_000);
        continue;
      }
      if (r.status !== "complete") continue;
      const { data: items } = await supabase.from("evaluation_items").select("competency, score").eq("evaluation_id", r.id);
      return { overall_score: Number(r.overall_score), status: r.status, items: (items ?? []) as EvalRow["items"] };
    }
  }
  return null;
}

(async () => {
  console.log("verify-fork-discrimination — Slice 7.5 (design separation, others undisturbed)");
  const { data: scen } = await supabase.from("scenarios").select("id").eq("slug", SLUG).maybeSingle();
  if (!scen) { console.log(`  ⚠ SKIP — ${SLUG} not seeded`); process.exit(0); }
  const scenarioId = (scen as { id: string }).id;

  if (COOLDOWN_MS > 0) { console.log(`\n[setup] cooling ${COOLDOWN_MS / 1000}s…`); await sleep(COOLDOWN_MS); }
  console.log("\n[1/2] PS-STRONG (protect + reason)");
  const strongS = await play("protect", scenarioId);
  if (COOLDOWN_MS > 0) { console.log(`\n[interlude] cooling ${COOLDOWN_MS / 1000}s…`); await sleep(COOLDOWN_MS); }
  console.log("\n[2/2] PS-WEAK (take the shortcut)");
  const weakS = await play("shortcut", scenarioId);

  console.log("\n[poll] evaluations…");
  const strong = await pollEval(strongS, 90_000);
  const weak = await pollEval(weakS, 90_000);

  console.log("\n[separation]");
  if (!strong || !weak || strong.status !== "complete" || weak.status !== "complete") {
    fail(`evals not both complete (strong=${strong?.status}, weak=${weak?.status})`);
  } else {
    const get = (e: EvalRow, k: string) => e.items.find((i) => i.competency === k)?.score ?? null;
    const sd = get(strong, "design_under_constraints"), wd = get(weak, "design_under_constraints");
    console.log(`  design_under_constraints: STRONG=${sd} WEAK=${wd} | overall: STRONG=${strong.overall_score.toFixed(2)} WEAK=${weak.overall_score.toFixed(2)}`);
    if (sd === null || wd === null) {
      fail(`design_under_constraints not_assessed: strong=${sd} weak=${wd}`);
    } else {
      const designSep = sd - wd;
      // 1) The fork sharply discriminates product sense.
      if (designSep >= MIN_DESIGN_SEPARATION) pass(`design_under_constraints separation +${designSep} ≥ ${MIN_DESIGN_SEPARATION} (fork discriminates product sense)`);
      else fail(`design_under_constraints separation +${designSep} < ${MIN_DESIGN_SEPARATION}`);

      // 2) The fork's signal CONCENTRATES on design — it separates at least as
      //    much as any other competency (the change targets Product Sense, not
      //    collateral bands).
      const COMPS = ["design_under_constraints", "teamwork", "customer_engagement", "problem_framing", "execution", "data_fluency", "ai_orchestration", "outcome_communication"];
      const seps = COMPS.map((k) => { const s = get(strong, k), w = get(weak, k); return { k, sep: s !== null && w !== null ? s - w : null }; }).filter((x) => x.sep !== null) as Array<{ k: string; sep: number }>;
      const maxSep = Math.max(...seps.map((x) => x.sep));
      console.log(`  per-competency separation: ${seps.map((x) => `${x.k}=${x.sep >= 0 ? "+" : ""}${x.sep}`).join(", ")}`);
      if (designSep >= maxSep) pass(`design_under_constraints has the LARGEST separation (+${designSep}) — fork signal concentrates on Product Sense`);
      else fail(`another competency separates more than design (max +${maxSep} vs design +${designSep})`);

      // 3) No collateral INVERSION — the fork must not flip any competency's order.
      const inversions = seps.filter((x) => x.sep < 0);
      if (inversions.length === 0) pass(`no competency inversions (all STRONG ≥ WEAK)`);
      else fail(`inversions introduced by the fork: ${inversions.map((x) => `${x.k}=${x.sep}`).join(", ")}`);
    }
  }

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
