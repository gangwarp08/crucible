/**
 * verify-not-assessed.ts — V.2 acceptance (not-assessed rates, 4.2).
 *
 * Infra-light (Supabase service-role + in-process Fastify inject — no E2B, no
 * LLM). Seeds — pointed at the EXISTING fde-db-triage scenario, in a far-future
 * per-run date window so live data can't leak in:
 *   - 3 scorable sessions, each with a complete evaluation under the current
 *     version set (judge JUDGE_PROMPT_VERSION, one competency_model_version),
 *     where competency X has assessed=false on 2 of 3 items
 *       → expects rate 0.6667, bound_n 3, not_assessed_n 2 for X;
 *   - 1 NON-scorable session with an evaluation that also has X assessed=false
 *       → must be EXCLUDED (bound_n stays 3 — scorable-only, RD3).
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; clean SKIP (exit 0)
 * without Supabase creds or before migration 0018.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-not-assessed.ts
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

async function main(): Promise<void> {
  console.log("verify-not-assessed — V.2");
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

  // ── Fixtures from the live DB (reused, never inserted) ─────────────────────
  const scen = await db
    .from("scenarios")
    .select("id, slug, version")
    .eq("slug", "fde-db-triage")
    .maybeSingle();
  if (!scen.data) throw new Error("fde-db-triage scenario not found — cannot seed");
  const SCEN_ID = (scen.data as { id: string }).id;
  const SCEN_VERSION = (scen.data as { version: number | null }).version ?? 1;
  const cmv = await db
    .from("competency_model_versions")
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const MODEL_VERSION = (cmv.data as { version: number } | null)?.version ?? 1;
  const defOrg = await getDefaultOrg();
  if (!defOrg) throw new Error("default asaya org not found");

  // ── Seed helpers (far-future window isolates the run from live data) ───────
  const run = randomUUID().slice(0, 8);
  const DAY = 86_400_000;
  const base = Date.UTC(2031, 0, 6) + Math.floor(Math.random() * 400) * 7 * DAY;
  const at = (days: number): string => new Date(base + days * DAY + 12 * 3_600_000).toISOString();
  const FROM = new Date(base - DAY).toISOString();
  const TO = new Date(base + 20 * DAY).toISOString();
  const COMP_X = `vd_na_x_${run}`;
  const sessionIds: string[] = [];

  const seedSession = async (opts: { scorable: boolean; reason?: string; createdAt: string }): Promise<string> => {
    const id = randomUUID();
    const { error } = await db.from("sessions").insert({
      id, status: "completed", sandbox_id: `vd-na-${run}`, template: "crucible-dev",
      litellm_key_alias: `vd-na-${run}-${id.slice(0, 8)}`, model: "gemini-flash",
      budget_usd: 1.0, timeout_min: 60, deadline: "2032-01-01T00:00:00.000Z",
      scenario_state: {}, org_id: defOrg.id, scenario_id: SCEN_ID,
      scorable: opts.scorable, exclusion_reason: opts.reason ?? null,
      difficulty_band: "mid", created_at: opts.createdAt,
    });
    if (error) throw new Error(`seed session failed: ${error.message}`);
    sessionIds.push(id);
    return id;
  };
  const seedEval = async (sessionId: string, overall: number): Promise<string> => {
    const id = randomUUID();
    const { error } = await db.from("evaluations").insert({
      id, session_id: sessionId, scenario_id: SCEN_ID, overall_score: overall,
      summary: "verify-not-assessed seed", model: "verify", status: "complete",
      competency_model_version: MODEL_VERSION, detector_version: "2",
      judge_prompt_version: JUDGE_PROMPT_VERSION, scenario_version: SCEN_VERSION,
    });
    if (error) throw new Error(`seed evaluation failed: ${error.message}`);
    return id;
  };
  const seedItem = async (evaluationId: string, score: number | null, assessed: boolean): Promise<void> => {
    const { error } = await db.from("evaluation_items").insert({
      evaluation_id: evaluationId, competency: COMP_X, score, weight: 0.5,
      assessed, rationale: "verify seed",
    });
    if (error) throw new Error(`seed item failed: ${error.message}`);
  };

  // Admin credential for the gate.
  let adminKey = process.env.ORG_ADMIN_KEY ?? "";
  let adminOrgId: string | null = null;
  if (!adminKey) {
    const a = await createOrg(`vd-na-adm-${run}`, `vd-na-adm-${run}`);
    adminOrgId = a.org.id;
    const { error } = await db.from("orgs").update({ role: "admin" }).eq("id", a.org.id);
    if (error) throw new Error(`admin role flip failed: ${error.message}`);
    adminKey = a.apiKey;
  }

  const app = Fastify();
  await app.register(validityRoutes);

  try {
    // ── Seed: 3 scorable (X not assessed on 2), 1 excluded (also X=false) ───
    console.log("\n[seed] 3 scorable + 1 excluded session on fde-db-triage");
    const s1 = await seedSession({ scorable: true, createdAt: at(0) });
    const s2 = await seedSession({ scorable: true, createdAt: at(1) });
    const s3 = await seedSession({ scorable: true, createdAt: at(2) });
    const sx = await seedSession({ scorable: false, reason: "excluded_infra", createdAt: at(3) });
    await seedItem(await seedEval(s1, 3.0), null, false);
    await seedItem(await seedEval(s2, 3.0), null, false);
    await seedItem(await seedEval(s3, 3.0), 3.0, true);
    await seedItem(await seedEval(sx, 3.0), null, false); // must NOT count

    // ── Assert via the endpoint ──────────────────────────────────────────────
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/validity/not-assessed",
      headers: { "x-org-key": adminKey },
      query: { scenario_id: SCEN_ID, from: FROM, to: TO },
    });
    check("GET not-assessed → 200", res.statusCode === 200, `status=${res.statusCode} body=${res.body.slice(0, 200)}`);
    const body = res.json() as {
      version_context: { judge_prompt_version: string };
      rows: Array<{
        scenario_id: string; scenario_slug: string; band: string | null;
        competency_key: string; bound_n: number; not_assessed_n: number; rate: number;
      }>;
    };

    console.log("\n[a] rate for competency X = 2/3 over scorable evaluations only");
    const rowsX = body.rows.filter((r) => r.competency_key === COMP_X);
    check("exactly one row for competency X (one scenario×band cell)", rowsX.length === 1, `rows=${JSON.stringify(rowsX)}`);
    const x = rowsX[0];
    check("bound_n = 3 (non-scorable evaluation EXCLUDED)", x?.bound_n === 3, `bound_n=${x?.bound_n}`);
    check("not_assessed_n = 2", x?.not_assessed_n === 2, `not_assessed_n=${x?.not_assessed_n}`);
    check("rate = 0.6667", x?.rate === 0.6667, `rate=${x?.rate}`);
    check("row is scenario/band labeled (fde-db-triage, mid)",
      x?.scenario_slug === "fde-db-triage" && x?.band === "mid", JSON.stringify(x));
    check("envelope carries the current judge version",
      body.version_context.judge_prompt_version === JUDGE_PROMPT_VERSION,
      JSON.stringify(body.version_context));
  } finally {
    console.log("\n[cleanup]");
    await app.close();
    if (sessionIds.length > 0) {
      await db.from("evaluations").delete().in("session_id", sessionIds); // items cascade
      await db.from("sessions").delete().in("id", sessionIds);
    }
    if (adminOrgId) await db.from("orgs").delete().eq("id", adminOrgId);
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-not-assessed crashed:", err);
  process.exit(1);
});
