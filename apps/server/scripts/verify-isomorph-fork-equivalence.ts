// verify-isomorph-fork-equivalence.ts — Slice 7.4 acceptance.
//
// Runs a matched FORK-AWARE strong playthrough against the two fork clones
// (fde-db-triage-fork and fde-db-triage-iso-fork — same construct, same 'mid'
// band, surface-different shortcut copy) and asserts they score COMPARABLY —
// especially on design_under_constraints (the product-sense fork's competency).
// Each playthrough: dedup queries → protect the user on Sam's shortcut pitch
// (respond with user-impact reasoning) → submit the reconciled deliverable.
// A well-formed parallel fork scores the same product-sense on either isomorph.
//
// Run: pnpm exec tsx scripts/verify-isomorph-fork-equivalence.ts
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
const FAR = 3_600_000;
const SHORTCUT_MS = 4_000;

const DESIGN_FLOOR = 4;        // a protected + reasoned run should earn ≥4 on design_under_constraints
const MAX_OVERALL_GAP = 1.0;
const MAX_DESIGN_GAP = 2;

const tokens = new Map<string, string>();
const auth = (s: string) => { const t = tokens.get(s); return t ? { Authorization: `Bearer ${t}` } : {}; };
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, realtime: { transport: WebSocket as unknown as never } });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);

interface Msg { channel?: string; role?: string; text?: string }
interface GT { corrected_monthly_cents: Record<string, number>; overstatement_cents: number }
const fmt = (c: number) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function openWs(sessionId: string): Promise<WS> {
  const wsBase = SERVER_URL.replace(/^http/, "ws");
  return new Promise((res, rej) => {
    const t = tokens.get(sessionId);
    const ws = new WS(`${wsBase}/messages/${sessionId}`, t ? [`bearer.${t}`] : undefined);
    ws.once("open", () => res(ws)); ws.once("error", rej);
  });
}

async function createSession(scenarioId: string): Promise<string> {
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId, beatTimingOverridesMs: { shortcut_suggestion: SHORTCUT_MS, misleading_teammate_hint: FAR, requirement_change: FAR, verification: FAR } }),
  });
  if (!r.ok) throw new Error(`create failed: ${r.status} ${await r.text()}`);
  const b = (await r.json()) as { sessionId: string; token?: string };
  if (b.token) tokens.set(b.sessionId, b.token);
  return b.sessionId;
}

const DEDUP_SQL = `WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) SELECT substr(p.created_at,1,7) m, SUM(p.amount_cents) FROM payments p JOIN dedup d ON d.keep_id=p.id WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1`;

async function forkPlaythrough(slug: string, scenarioId: string, gt: GT): Promise<string> {
  const sessionId = await createSession(scenarioId);
  console.log(`  [${slug}] session ${sessionId}`);
  const post = (path: string, body: unknown) => fetch(`${SERVER_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth(sessionId) }, body: JSON.stringify(body) });

  // Buffer ALL inbound messages so the T+4s shortcut beat is never dropped.
  const inbox: Msg[] = [];
  let ws: WS | undefined;
  try {
    ws = await openWs(sessionId);
    ws.on("message", (raw: WS.RawData) => { try { const m = JSON.parse(raw.toString()) as Msg; if (m.channel) inbox.push(m); } catch { /* ignore */ } });
  } catch { /* messaging optional */ }

  // Dedup queries (sound method).
  await post(`/api/sessions/${sessionId}/query`, { sql: "SELECT substr(created_at,1,7) m, SUM(amount_cents) FROM payments WHERE status='succeeded' AND substr(created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1" }).catch(() => {});
  await post(`/api/sessions/${sessionId}/query`, { sql: DEDUP_SQL }).catch(() => {});
  await post(`/api/sessions/${sessionId}/query`, { sql: "SELECT external_payment_id, COUNT(*) FROM payments WHERE status='succeeded' GROUP BY external_payment_id HAVING COUNT(*)>1 LIMIT 5" }).catch(() => {});

  // Wait for Sam's shortcut pitch (in the buffer), then PROTECT + reason.
  const shortcutRe = /ship|raw|skip|reconcil|overkill|close enough|those numbers|straight (monthly )?total/i;
  let sawShortcut = false;
  for (let i = 0; i < 25 && ws; i++) {
    if (inbox.some((m) => m.channel === "team" && shortcutRe.test(m.text ?? ""))) { sawShortcut = true; break; }
    await sleep(1_000);
  }
  if (sawShortcut && ws) {
    ws.send(JSON.stringify({ channel: "team", text: "i hear the time pressure, but we can't ship the raw sum — it double-counts the retried webhook payments and overstates revenue by ~$130K/mo. the board would be making decisions on a misleading number and we'd lose trust in the dashboard. i'll dedup and send the reconciled figures, it's quick." }));
    await sleep(3_000); // let Sam concede
  } else {
    console.log(`  [${slug}] (shortcut pitch not observed in buffer — deliverable still reconciled)`);
  }
  if (ws) { try { ws.close(); } catch { /* ignore */ } }

  // Reconciled (user-protected) deliverable from THIS scenario's ground truth.
  const mar = gt.corrected_monthly_cents["2026-03"]!, apr = gt.corrected_monthly_cents["2026-04"]!, may = gt.corrected_monthly_cents["2026-05"]!;
  const dr = await post(`/api/sessions/${sessionId}/deliverable`, {
    status: "submitted",
    data: {
      corrected_monthly_revenue: `${DEDUP_SQL};\n\nReconciled: Mar ${fmt(mar)}, Apr ${fmt(apr)}, May ${fmt(may)}.`,
      root_cause_finding: "Duplicate succeeded payments sharing external_payment_id were double-counted by the naive SUM (webhook-retry bug). Verified via HAVING COUNT(*)>1.",
      client_facing_summary: `The dashboard overstated monthly revenue by about ${fmt(gt.overstatement_cents)}. Reconciled: Mar ${fmt(mar)}, Apr ${fmt(apr)}, May ${fmt(may)}. We did NOT ship the raw figure — it would have misled the board; a recording bug double-counted payments and we're fixing it upstream.`,
      decisions_and_tradeoffs: "Declined the shortcut of shipping the raw SUM: reconciling by external_payment_id is quick and the board needs an accurate number. Dedup by MIN(id) per external_payment_id, SUM where status='succeeded'. Recommend an idempotency key in the webhook ingest.",
    },
  });
  if (!dr.ok) fail(`[${slug}] deliverable submit failed: ${dr.status}`);
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...auth(sessionId) } });
  console.log(`  [${slug}] DELETEd → auto-eval (shortcut seen: ${sawShortcut})`);
  return sessionId;
}

interface EvalRow { overall_score: number; status: string; items: Array<{ competency: string; score: number | null }> }
async function pollEval(sessionId: string, timeoutMs: number): Promise<EvalRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const { data: row } = await supabase.from("evaluations").select("id, overall_score, status").eq("session_id", sessionId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (row) {
      const r = row as { id: string; overall_score: number | string; status: string };
      const { data: items } = await supabase.from("evaluation_items").select("competency, score").eq("evaluation_id", r.id);
      return { overall_score: Number(r.overall_score), status: r.status, items: (items ?? []) as EvalRow["items"] };
    }
  }
  return null;
}
async function scenarioId(slug: string): Promise<string | null> {
  const { data } = await supabase.from("scenarios").select("id").eq("slug", slug).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

(async () => {
  console.log("verify-isomorph-fork-equivalence — Slice 7.4");
  const baseId = await scenarioId("fde-db-triage-fork");
  const isoId = await scenarioId("fde-db-triage-iso-fork");
  if (!baseId || !isoId) { console.log("  ⚠ SKIP — fork clones not seeded (run scripts/seed-fork-scenario.ts)"); process.exit(0); }

  const baseGt = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/ground_truth.json"), "utf8")) as GT;
  const isoGt = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/fde-db-triage-iso/ground_truth.json"), "utf8")) as GT;
  if (baseGt.corrected_monthly_cents["2026-04"] !== isoGt.corrected_monthly_cents["2026-04"]) pass("iso has different corrected figures (real isomorph)");
  else fail("iso figures identical to base");

  if (COOLDOWN_MS > 0) { console.log(`\n[setup] cooling ${COOLDOWN_MS / 1000}s…`); await sleep(COOLDOWN_MS); }
  console.log("\n[1/2] fork playthrough — fde-db-triage-fork");
  const baseSession = await forkPlaythrough("fde-db-triage-fork", baseId, baseGt);
  if (COOLDOWN_MS > 0) { console.log(`\n[interlude] cooling ${COOLDOWN_MS / 1000}s…`); await sleep(COOLDOWN_MS); }
  console.log("\n[2/2] fork playthrough — fde-db-triage-iso-fork");
  const isoSession = await forkPlaythrough("fde-db-triage-iso-fork", isoId, isoGt);

  console.log("\n[poll] evaluations…");
  const baseEval = await pollEval(baseSession, 90_000);
  const isoEval = await pollEval(isoSession, 90_000);

  console.log("\n[equivalence]");
  if (!baseEval || !isoEval || baseEval.status !== "complete" || isoEval.status !== "complete") {
    fail(`evals not both complete (base=${baseEval?.status ?? "missing"}, iso=${isoEval?.status ?? "missing"})`);
  } else {
    const design = (e: EvalRow) => e.items.find((i) => i.competency === "design_under_constraints")?.score ?? null;
    const bd = design(baseEval), id = design(isoEval);
    console.log(`  overall: base=${baseEval.overall_score.toFixed(2)} iso=${isoEval.overall_score.toFixed(2)} | design_under_constraints: base=${bd} iso=${id}`);
    const gap = Math.abs(baseEval.overall_score - isoEval.overall_score);
    if (gap <= MAX_OVERALL_GAP) pass(`overall gap ${gap.toFixed(2)} ≤ ${MAX_OVERALL_GAP}`); else fail(`overall gap ${gap.toFixed(2)} > ${MAX_OVERALL_GAP}`);
    if (bd !== null && id !== null) {
      if (bd >= DESIGN_FLOOR && id >= DESIGN_FLOOR) pass(`both design_under_constraints ≥ ${DESIGN_FLOOR} (protected + reasoned scored well via fork anchors)`);
      else fail(`design_under_constraints below floor: base=${bd} iso=${id}`);
      const dgap = Math.abs(bd - id);
      if (dgap <= MAX_DESIGN_GAP) pass(`design_under_constraints gap ${dgap} ≤ ${MAX_DESIGN_GAP} (comparable Product Sense across isomorphs)`);
      else fail(`design_under_constraints gap ${dgap} > ${MAX_DESIGN_GAP}`);
    } else fail(`design_under_constraints not_assessed on a fork run: base=${bd} iso=${id}`);
  }

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
