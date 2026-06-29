// Slice 5.2 acceptance — deterministic evidence extraction (L5 Stage A).
//
// Drives two LLM-FREE playthroughs of fde-db-triage against a live server
// (queries + deliverable only — no persona/AI calls), waits for telemetry to
// flush, reads the durable event stream, and runs the REAL detectors
// (services/evidence-extractor.ts#runDetectors) over them. Asserts the expected
// unit kinds + values:
//
//   STRONG: dedup_correct=true, status_filter_missing=false,
//           verified_before_submit=true, figures_match_truth.matched=true
//   WEAK:   dedup_correct=false, status_filter_missing=true,
//           verified_before_submit=false, figures_match_truth.matched=false
//
// The assertions never touch the LLM — extraction is deterministic. (Ending the
// sessions for cleanup fires the normal background analysis, which is ignored.)
//
// Run: pnpm exec tsx apps/server/scripts/verify-evidence-units.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";
import { runDetectors, type EventRow, type EvidenceUnit } from "../src/services/evidence-extractor.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const SLUG = "fde-db-triage";

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF
    ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`
    : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

const groundTruth = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures", SLUG, "ground_truth.json"), "utf8"),
) as Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Per-session JWTs minted on POST /sessions ───────────────────────────────
const tokens = new Map<string, string>();
function authHeaders(sessionId: string): Record<string, string> {
  const t = tokens.get(sessionId);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function getScenarioId(): Promise<string> {
  const { data, error } = await supabase.from("scenarios").select("id").eq("slug", SLUG).single();
  if (error || !data) throw new Error(`could not load scenario ${SLUG}: ${error?.message}`);
  return (data as { id: string }).id;
}

async function createSession(scenarioId: string): Promise<string> {
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { sessionId: string; token?: string };
  if (body.token) tokens.set(body.sessionId, body.token);
  return body.sessionId;
}

async function runSql(sessionId: string, sql: string): Promise<void> {
  const r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ sql }),
  });
  if (!r.ok) console.log(`    query HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

interface DeliverableData {
  corrected_monthly_revenue: string;
  root_cause_finding: string;
  client_facing_summary: string;
  decisions_and_tradeoffs: string;
}
async function putDeliverable(sessionId: string, status: "draft" | "submitted", data: DeliverableData): Promise<void> {
  const r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
    body: JSON.stringify({ status, data }),
  });
  if (!r.ok) console.log(`    deliverable HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

async function endSession(sessionId: string): Promise<void> {
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: authHeaders(sessionId) });
}

async function readEvents(sessionId: string): Promise<EventRow[]> {
  const { data } = await supabase
    .from("events").select("seq, type, actor, payload").eq("session_id", sessionId)
    .order("seq", { ascending: true });
  return (data ?? []) as unknown as EventRow[];
}

// ── SQL ─────────────────────────────────────────────────────────────────────
const SQL_DEDUP_CORRECT =
  "WITH deduped AS (SELECT MIN(id) AS id FROM payments WHERE status='succeeded' GROUP BY external_payment_id) " +
  "SELECT substr(p.created_at,1,7) AS month, SUM(p.amount_cents) AS rev " +
  "FROM payments p JOIN deduped d ON p.id=d.id GROUP BY month ORDER BY month;";
const SQL_VERIFY_DUPES =
  "SELECT external_payment_id, COUNT(*) c FROM payments GROUP BY external_payment_id HAVING c > 1 LIMIT 5;";
const SQL_NAIVE =
  "SELECT substr(created_at,1,7) AS month, SUM(amount_cents) AS rev FROM payments GROUP BY month ORDER BY month;";

const CORRECT_REVENUE = "Corrected total revenue Mar–May 2026 is $3,942,033.32 after dedup + status filter.";
const NAIVE_REVENUE = "Total revenue Mar–May 2026 is $4,202,031.71.";
const FILLER = "See analysis.";

// ── Assertions ───────────────────────────────────────────────────────────────
let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => { console.log(`  ✗ ${m}`); failures++; };

function byKind(units: EvidenceUnit[], kind: string): EvidenceUnit | undefined {
  return units.find((u) => u.kind === kind);
}
function expectBool(units: EvidenceUnit[], kind: string, want: boolean): void {
  const u = byKind(units, kind);
  if (!u) return fail(`${kind}: unit missing`);
  if (u.value === want) pass(`${kind} = ${want} (seqs: [${u.event_seqs.join(",")}])`);
  else fail(`${kind}: expected ${want}, got ${JSON.stringify(u.value)}`);
}
function expectFiguresMatched(units: EvidenceUnit[], want: boolean): void {
  const u = byKind(units, "figures_match_truth");
  if (!u) return fail("figures_match_truth: unit missing");
  const v = u.value as { matched?: boolean; best_rel_delta?: number };
  if (v.matched === want) pass(`figures_match_truth.matched = ${want} (Δ=${v.best_rel_delta})`);
  else fail(`figures_match_truth: expected matched=${want}, got ${JSON.stringify(v)}`);
}

(async () => {
  console.log(`Evidence-unit extraction check against ${SERVER_URL}\n`);
  const scenarioId = await getScenarioId();

  // ── STRONG ─────────────────────────────────────────────────────────────
  console.log("STRONG playthrough (dedup + status filter, verify-after-draft, correct figure)");
  const strong = await createSession(scenarioId);
  await runSql(strong, SQL_DEDUP_CORRECT);
  await putDeliverable(strong, "draft", {
    corrected_monthly_revenue: CORRECT_REVENUE, root_cause_finding: FILLER,
    client_facing_summary: FILLER, decisions_and_tradeoffs: FILLER,
  });
  await runSql(strong, SQL_VERIFY_DUPES); // verification query AFTER the draft
  await putDeliverable(strong, "submitted", {
    corrected_monthly_revenue: CORRECT_REVENUE, root_cause_finding: "Webhook double-insert; dedup by external_payment_id.",
    client_facing_summary: "Revenue overstated ~$260k from duplicate payments.", decisions_and_tradeoffs: "Deduped, filtered to succeeded.",
  });
  await sleep(1_500); // let telemetry flush (250ms interval)
  const strongUnits = runDetectors(SLUG, await readEvents(strong), groundTruth);
  expectBool(strongUnits, "dedup_correct", true);
  expectBool(strongUnits, "status_filter_missing", false);
  expectBool(strongUnits, "verified_before_submit", true);
  expectFiguresMatched(strongUnits, true);

  // ── WEAK ───────────────────────────────────────────────────────────────
  console.log("\nWEAK playthrough (naive SUM, no dedup/status filter, inflated figure, no verify)");
  const weak = await createSession(scenarioId);
  await runSql(weak, SQL_NAIVE);
  await putDeliverable(weak, "submitted", {
    corrected_monthly_revenue: NAIVE_REVENUE, root_cause_finding: FILLER,
    client_facing_summary: FILLER, decisions_and_tradeoffs: FILLER,
  });
  await sleep(1_500);
  const weakUnits = runDetectors(SLUG, await readEvents(weak), groundTruth);
  expectBool(weakUnits, "dedup_correct", false);
  expectBool(weakUnits, "status_filter_missing", true);
  expectBool(weakUnits, "verified_before_submit", false);
  expectFiguresMatched(weakUnits, false);

  // ── Sanity: agnostic units always present ───────────────────────────────
  console.log("\nAgnostic detectors present");
  for (const k of ["deliverable_present", "ai_turn_count", "query_error_count"]) {
    if (byKind(strongUnits, k)) pass(`${k} emitted`);
    else fail(`${k} missing`);
  }

  // ── Cleanup (fires background analysis — ignored) ───────────────────────
  await endSession(strong).catch(() => {});
  await endSession(weak).catch(() => {});

  console.log(`\n${"=".repeat(60)}`);
  console.log(failures === 0 ? "PASS — detectors emit the expected units" : `FAIL — ${failures} problem(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(2);
});
