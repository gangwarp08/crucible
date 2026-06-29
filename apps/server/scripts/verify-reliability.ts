// Acceptance verifier for Slice 5.7 — Stage B reliability.
//
// Stage A (evidence units) is deterministic by construction; the open question
// is whether the Stage B LLM judge is STABLE when re-scoring the SAME units. We
// seed one synthetic completed session (a strong fde-db-triage run), extract its
// evidence once, then reinterpret (Stage B only — no replay) N times and check
// per-competency score spread stays within a bound. Wide spread ⇒ the judge is
// noisy and scores aren't trustworthy run-to-run.
//
// Uses the service layer directly (no HTTP server); LLM calls go through the
// LiteLLM master key like the production analysis path. Self-cleans.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-reliability.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";

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

// dotenv loaded — safe to import the service layer (→ services/supabase + env).
const { extractAndPersistEvidence } = await import("../src/services/evidence-extractor.js");
const { reinterpretEvaluation } = await import("../src/services/analysis-agent.js");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let failures = 0;
function fail(msg: string): void { failures += 1; console.error("  FAIL:", msg); }
function pass(msg: string): void { console.log("  PASS:", msg); }

const N_RUNS = 3;
const PER_COMPETENCY_SPREAD_BOUND = 2;  // max(score)-min(score) across reruns
const OVERALL_SPREAD_BOUND = 1.5;
const SESSION_ID = "00000000-0000-4000-8000-00000000c001";

interface GroundTruth { corrected_monthly_cents: Record<string, number> }
const gt = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/ground_truth.json"), "utf8"),
) as GroundTruth;
function fmtUsd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function cleanup(): Promise<void> {
  await supabase.from("evaluations").delete().eq("session_id", SESSION_ID);
  await supabase.from("evidence_units").delete().eq("session_id", SESSION_ID);
  await supabase.from("events").delete().eq("session_id", SESSION_ID);
  await supabase.from("sessions").delete().eq("id", SESSION_ID);
}

const DEDUP_SQL =
  "WITH dedup AS (SELECT MIN(id) AS keep_id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) " +
  "SELECT substr(p.created_at,1,7) m, SUM(p.amount_cents) FROM payments p JOIN dedup d ON d.keep_id=p.id " +
  "WHERE substr(p.created_at,1,7) IN ('2026-03','2026-04','2026-05') GROUP BY 1 ORDER BY 1";

(async () => {
  console.log("verify-reliability");

  const { data: scenarioRow, error: scenErr } = await supabase
    .from("scenarios").select("id").eq("slug", "fde-db-triage").single();
  if (scenErr || !scenarioRow) { console.error("scenario lookup failed:", scenErr?.message); process.exit(1); }
  const scenarioId = (scenarioRow as { id: string }).id;

  console.log("\n[setup] cleaning prior synthetic session…");
  await cleanup();

  // Seed a completed session.
  const { error: sErr } = await supabase.from("sessions").insert({
    id: SESSION_ID,
    status: "completed",
    sandbox_id: "verify-reliability-synthetic",
    template: "crucible-dev",
    litellm_key_alias: "vr-0",
    model: "gemini-flash",
    budget_usd: 1.0,
    timeout_min: 60,
    deadline: "2030-01-01T00:00:00.000Z",
    scenario_id: scenarioId,
    ended_at: "2026-06-01T00:00:00.000Z",
    end_reason: "manual",
    duration_ms: 1_800_000,
    scenario_state: {},
  });
  if (sErr) { fail(`session seed failed: ${sErr.message}`); await cleanup(); process.exit(1); }

  // Seed a strong run's worth of events.
  const mar = gt.corrected_monthly_cents["2026-03"]!;
  const apr = gt.corrected_monthly_cents["2026-04"]!;
  const may = gt.corrected_monthly_cents["2026-05"]!;
  const ts = (s: number) => new Date(Date.parse("2026-06-01T00:00:00Z") + s * 1000).toISOString();
  const ev = (seq: number, type: string, actor: string, payload: Record<string, unknown>) => ({
    session_id: SESSION_ID, seq, type, actor, ts: ts(seq), payload,
  });
  const events = [
    ev(1, "message.client.candidate", "candidate", { text: "Which tile, what figure did you expect, and when did it start?" }),
    ev(2, "message.client.persona", "system", { text: "The monthly recognized revenue tile; we expected ~$1.1-1.3M; it started looking high around April.", persona_name: "Dana" }),
    ev(3, "db.query", "candidate", { sql: "SELECT substr(created_at,1,7) m, SUM(amount_cents) FROM payments WHERE status='succeeded' GROUP BY 1", status: "ok", row_count: 3, duration_ms: 6 }),
    ev(4, "db.query", "candidate", { sql: DEDUP_SQL, status: "ok", row_count: 3, duration_ms: 8 }),
    ev(5, "db.query", "candidate", { sql: "SELECT external_payment_id, COUNT(*) FROM payments WHERE status='succeeded' GROUP BY external_payment_id HAVING COUNT(*)>1 LIMIT 5", status: "ok", row_count: 5, duration_ms: 5 }),
    ev(6, "message.team.candidate", "candidate", { text: "Refunds only net ~$30K/mo but the gap is ~$130K/mo — looks like duplicate succeeded rows sharing external_payment_id. Webhook retry?" }),
    ev(7, "deliverable.submit", "candidate", {
      updated_at: ts(7),
      data: {
        corrected_monthly_revenue: `${DEDUP_SQL};\n\nResults: Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}.`,
        root_cause_finding: "Duplicate succeeded payments sharing external_payment_id were double-counted (webhook-retry bug); verified via HAVING COUNT(*)>1, refunds rejected with numbers.",
        client_facing_summary: `The dashboard overstated revenue across April and May; corrected Mar ${fmtUsd(mar)}, Apr ${fmtUsd(apr)}, May ${fmtUsd(may)}. Real revenue never changed — a recording bug double-counted payments; fixing upstream.`,
        decisions_and_tradeoffs: "Dedup by MIN(id) per external_payment_id, SUM where status='succeeded'. Refunds quantified + rejected. UTC verified. Recommend an idempotency key in the webhook ingest.",
      },
    }),
  ];
  const { error: evErr } = await supabase.from("events").insert(events);
  if (evErr) { fail(`events seed failed: ${evErr.message}`); await cleanup(); process.exit(1); }

  // Stage A once.
  const units = await extractAndPersistEvidence(SESSION_ID);
  console.log(`[setup] extracted ${units.length} evidence units`);

  console.log("\n[setup] cooling 60s for Gemini rate-limit window…");
  await sleep(60_000);

  // Reinterpret (Stage B only) N times over the SAME units.
  console.log(`\n[a] ${N_RUNS} re-interpretations over identical units`);
  const perComp = new Map<string, number[]>();
  const overalls: number[] = [];
  for (let i = 0; i < N_RUNS; i++) {
    if (i > 0) await sleep(45_000); // spread calls under the free-tier rate limit
    const r = await reinterpretEvaluation(SESSION_ID);
    overalls.push(r.overall_score);
    for (const it of r.items) {
      const arr = perComp.get(it.competency) ?? [];
      arr.push(it.score);
      perComp.set(it.competency, arr);
    }
    console.log(`  run ${i + 1}: overall=${r.overall_score.toFixed(2)} (status=${r.status})`);
  }

  // Assertions.
  console.log("\n[b] per-competency stability");
  let worst = 0; let worstKey = "";
  for (const [comp, scores] of perComp) {
    const spread = Math.max(...scores) - Math.min(...scores);
    if (spread > worst) { worst = spread; worstKey = comp; }
    console.log(`  ${comp}: [${scores.join(", ")}] spread=${spread}`);
  }
  if (worst <= PER_COMPETENCY_SPREAD_BOUND)
    pass(`largest per-competency spread ${worst} (${worstKey}) ≤ ${PER_COMPETENCY_SPREAD_BOUND}`);
  else fail(`competency ${worstKey} spread ${worst} > ${PER_COMPETENCY_SPREAD_BOUND} — judge unstable`);

  const overallSpread = Math.max(...overalls) - Math.min(...overalls);
  console.log(`\n[c] overall spread: ${overallSpread.toFixed(2)} over [${overalls.map((o) => o.toFixed(2)).join(", ")}]`);
  if (overallSpread <= OVERALL_SPREAD_BOUND) pass(`overall spread ≤ ${OVERALL_SPREAD_BOUND}`);
  else fail(`overall spread ${overallSpread.toFixed(2)} > ${OVERALL_SPREAD_BOUND}`);

  console.log("\n[cleanup] removing synthetic session…");
  await cleanup();

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
