/**
 * verify-exclusions.ts — V.2 acceptance (exclusion breakdown, 4.5).
 *
 * Infra-light (Supabase service-role + in-process Fastify inject — no E2B, no
 * LLM). Seeds 5 sessions on the existing fde-db-triage scenario, in a
 * far-future per-run window spanning TWO ISO weeks:
 *   week 1: 2 scorable + 1 excluded_infra
 *   week 2: 1 excluded_infra + 1 excluded_abandoned
 * Expects totals {scorable:2, excluded:3}, by_reason {excluded_infra:2,
 * excluded_abandoned:1}, over_time split across exactly those two ISO weeks —
 * and that the view is UNAFFECTED by evaluations (it reads stored scorability
 * verdicts only): adding an evaluation to an excluded session changes nothing.
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; clean SKIP (exit 0)
 * without Supabase creds or before migration 0018.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-exclusions.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

interface ExclusionsBody {
  totals: { scorable: number; excluded: number };
  by_reason: Array<{ reason: string; n: number }>;
  over_time: Array<{ week: string; scorable: number; excluded: number }>;
}

async function main(): Promise<void> {
  console.log("verify-exclusions — V.2");
  if (!url || !key) {
    console.log("  ⚠ SKIP — Supabase creds absent");
    process.exit(0);
  }
  const { supabase } = await import("../src/services/supabase.js");
  if (!supabase) {
    console.log("  ⚠ SKIP — service-role client unavailable");
    process.exit(0);
  }
  const db = supabase;
  const missingTable = (e: { code?: string; message?: string } | null) =>
    !!e && /42P01|PGRST205|does not exist|Could not find the table/i.test(`${e.code} ${e.message}`);
  const orgsProbe = await db.from("orgs").select("id").limit(1);
  if (missingTable(orgsProbe.error)) {
    console.log("  ⚠ SKIP — orgs table absent (migration 0018 not applied)");
    process.exit(0);
  }

  const { createOrg, getDefaultOrg } = await import("../src/services/orgs.js");
  const { JUDGE_PROMPT_VERSION } = await import("../src/services/analysis-agent.js");
  const { validityRoutes } = await import("../src/routes/validity.js");
  const { default: Fastify } = await import("fastify");

  const scen = await db.from("scenarios").select("id, version").eq("slug", "fde-db-triage").maybeSingle();
  if (!scen.data) throw new Error("fde-db-triage scenario not found — cannot seed");
  const SCEN_ID = (scen.data as { id: string }).id;
  const SCEN_VERSION = (scen.data as { version: number | null }).version ?? 1;
  const cmv = await db.from("competency_model_versions").select("version")
    .order("version", { ascending: false }).limit(1).maybeSingle();
  const MODEL_VERSION = (cmv.data as { version: number } | null)?.version ?? 1;
  const defOrg = await getDefaultOrg();
  if (!defOrg) throw new Error("default asaya org not found");

  // ── Seed window: base is a Monday (2031-01-06 + k×7d), so week boundaries
  //    are deterministic: week1 = day 0-6, week2 = day 7-13.
  const run = randomUUID().slice(0, 8);
  const DAY = 86_400_000;
  const base = Date.UTC(2031, 0, 6) + Math.floor(Math.random() * 400) * 7 * DAY;
  const at = (days: number): string => new Date(base + days * DAY + 12 * 3_600_000).toISOString();
  const weekOf = (days: number): string => new Date(base + Math.floor(days / 7) * 7 * DAY).toISOString().slice(0, 10);
  const FROM = new Date(base - DAY).toISOString();
  const TO = new Date(base + 20 * DAY).toISOString();
  const sessionIds: string[] = [];

  const seedSession = async (scorable: boolean, reason: string | null, createdAt: string): Promise<string> => {
    const id = randomUUID();
    const { error } = await db.from("sessions").insert({
      id, status: "completed", sandbox_id: `vd-ex-${run}`, template: "crucible-dev",
      litellm_key_alias: `vd-ex-${run}-${id.slice(0, 8)}`, model: "gemini-flash",
      budget_usd: 1.0, timeout_min: 60, deadline: "2032-01-01T00:00:00.000Z",
      scenario_state: {}, org_id: defOrg.id, scenario_id: SCEN_ID,
      scorable, exclusion_reason: reason, difficulty_band: "mid", created_at: createdAt,
    });
    if (error) throw new Error(`seed session failed: ${error.message}`);
    sessionIds.push(id);
    return id;
  };

  let adminKey = process.env.ORG_ADMIN_KEY ?? "";
  let adminOrgId: string | null = null;
  if (!adminKey) {
    const a = await createOrg(`vd-ex-adm-${run}`, `vd-ex-adm-${run}`);
    adminOrgId = a.org.id;
    const { error } = await db.from("orgs").update({ role: "admin" }).eq("id", a.org.id);
    if (error) throw new Error(`admin role flip failed: ${error.message}`);
    adminKey = a.apiKey;
  }

  const app = Fastify();
  await app.register(validityRoutes);
  const fetchExclusions = async (): Promise<ExclusionsBody> => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/validity/exclusions",
      headers: { "x-org-key": adminKey },
      query: { scenario_id: SCEN_ID, from: FROM, to: TO },
    });
    if (res.statusCode !== 200) throw new Error(`exclusions → ${res.statusCode}: ${res.body.slice(0, 200)}`);
    return res.json() as ExclusionsBody;
  };

  try {
    console.log("\n[seed] 2 scorable + 3 excluded across two ISO weeks");
    await seedSession(true, null, at(0));                        // week 1
    await seedSession(true, null, at(1));                        // week 1
    const e1 = await seedSession(false, "excluded_infra", at(2)); // week 1
    await seedSession(false, "excluded_infra", at(7));            // week 2
    await seedSession(false, "excluded_abandoned", at(8));        // week 2

    console.log("\n[a] totals / by_reason / over_time");
    const body = await fetchExclusions();
    check("totals = {scorable:2, excluded:3}",
      body.totals.scorable === 2 && body.totals.excluded === 3, JSON.stringify(body.totals));
    const reason = (r: string): number => body.by_reason.find((x) => x.reason === r)?.n ?? 0;
    check("by_reason: excluded_infra = 2", reason("excluded_infra") === 2, JSON.stringify(body.by_reason));
    check("by_reason: excluded_abandoned = 1", reason("excluded_abandoned") === 1, JSON.stringify(body.by_reason));
    check("by_reason has no other reasons", body.by_reason.length === 2, JSON.stringify(body.by_reason));
    const w1 = body.over_time.find((w) => w.week === weekOf(0));
    const w2 = body.over_time.find((w) => w.week === weekOf(7));
    check(`over_time week ${weekOf(0)} = {scorable:2, excluded:1}`,
      w1?.scorable === 2 && w1?.excluded === 1, JSON.stringify(body.over_time));
    check(`over_time week ${weekOf(7)} = {scorable:0, excluded:2}`,
      w2?.scorable === 0 && w2?.excluded === 2, JSON.stringify(body.over_time));
    check("over_time has exactly the two seeded weeks", body.over_time.length === 2, JSON.stringify(body.over_time));

    console.log("\n[b] unaffected by evaluations (reads stored verdicts only)");
    const { error: evErr } = await db.from("evaluations").insert({
      id: randomUUID(), session_id: e1, scenario_id: SCEN_ID, overall_score: 4.2,
      summary: "verify-exclusions seed", model: "verify", status: "complete",
      competency_model_version: MODEL_VERSION, detector_version: "2",
      judge_prompt_version: JUDGE_PROMPT_VERSION, scenario_version: SCEN_VERSION,
    });
    if (evErr) throw new Error(`seed evaluation failed: ${evErr.message}`);
    const after = await fetchExclusions();
    check("totals unchanged after adding an evaluation",
      JSON.stringify(after.totals) === JSON.stringify(body.totals), JSON.stringify(after.totals));
    check("by_reason unchanged", JSON.stringify(after.by_reason) === JSON.stringify(body.by_reason));
    check("over_time unchanged", JSON.stringify(after.over_time) === JSON.stringify(body.over_time));
  } finally {
    console.log("\n[cleanup]");
    await app.close();
    if (sessionIds.length > 0) {
      await db.from("evaluations").delete().in("session_id", sessionIds);
      await db.from("sessions").delete().in("id", sessionIds);
    }
    if (adminOrgId) await db.from("orgs").delete().eq("id", adminOrgId);
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-exclusions crashed:", err);
  process.exit(1);
});
