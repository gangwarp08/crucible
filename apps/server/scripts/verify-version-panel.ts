/**
 * verify-version-panel.ts — V.5 acceptance (version / drift boundary panel, 4.6).
 *
 * Infra-light (Supabase service-role + in-process Fastify inject — no E2B, no
 * LLM). Seeds, on the existing fde-db-triage scenario in a far-future per-run
 * window:
 *   - days 0-2:  4 evaluations under the CURRENT judge (JUDGE_PROMPT_VERSION)
 *                + 2 under legacy judge "1" (mixed segment);
 *   - days 10-11: 3 more CURRENT evaluations (homogeneous segment).
 * Asserts:
 *   [a] mixed selection → segments split with correct n (current 7, legacy 2),
 *       legacy flagged true, boundary_warning non-null;
 *   [b] homogeneous current-only selection (date-window filter) →
 *       boundary_warning null, single current segment.
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; clean SKIP (exit 0)
 * without Supabase creds or before migration 0018.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-version-panel.ts
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

interface VersionSegment {
  competency_model_version: string; detector_version: string;
  judge_prompt_version: string; scenario_version: string; n: number; legacy: boolean;
}
interface VersionsBody {
  version_context: { judge_prompt_version: string; competency_model_version: string };
  segments: VersionSegment[];
  boundary_warning: string | null;
}

async function main(): Promise<void> {
  console.log("verify-version-panel — V.5");
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

  const run = randomUUID().slice(0, 8);
  const DAY = 86_400_000;
  const base = Date.UTC(2031, 0, 6) + Math.floor(Math.random() * 400) * 7 * DAY;
  const at = (days: number): string => new Date(base + days * DAY + 12 * 3_600_000).toISOString();
  const sessionIds: string[] = [];

  const seedSessionWithEval = async (days: number, judge: string, detector: string): Promise<void> => {
    const id = randomUUID();
    const { error: sErr } = await db.from("sessions").insert({
      id, status: "completed", sandbox_id: `vd-ver-${run}`, template: "crucible-dev",
      litellm_key_alias: `vd-ver-${run}-${id.slice(0, 8)}`, model: "gemini-flash",
      budget_usd: 1.0, timeout_min: 60, deadline: "2032-01-01T00:00:00.000Z",
      scenario_state: {}, org_id: defOrg.id, scenario_id: SCEN_ID,
      scorable: true, exclusion_reason: null, difficulty_band: "mid", created_at: at(days),
    });
    if (sErr) throw new Error(`seed session failed: ${sErr.message}`);
    sessionIds.push(id);
    const { error: eErr } = await db.from("evaluations").insert({
      id: randomUUID(), session_id: id, scenario_id: SCEN_ID, overall_score: 3.2,
      summary: "verify-version-panel seed", model: "verify", status: "complete",
      competency_model_version: MODEL_VERSION, detector_version: detector,
      judge_prompt_version: judge, scenario_version: SCEN_VERSION,
    });
    if (eErr) throw new Error(`seed evaluation failed: ${eErr.message}`);
  };

  let adminKey = process.env.ORG_ADMIN_KEY ?? "";
  let adminOrgId: string | null = null;
  if (!adminKey) {
    const a = await createOrg(`vd-ver-adm-${run}`, `vd-ver-adm-${run}`);
    adminOrgId = a.org.id;
    const { error } = await db.from("orgs").update({ role: "admin" }).eq("id", a.org.id);
    if (error) throw new Error(`admin role flip failed: ${error.message}`);
    adminKey = a.apiKey;
  }

  const app = Fastify();
  await app.register(validityRoutes);
  const fetchVersions = async (fromDay: number, toDay: number): Promise<VersionsBody> => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/validity/versions",
      headers: { "x-org-key": adminKey },
      query: {
        scenario_id: SCEN_ID,
        from: new Date(base + fromDay * DAY).toISOString(),
        to: new Date(base + toDay * DAY).toISOString(),
      },
    });
    if (res.statusCode !== 200) throw new Error(`versions → ${res.statusCode}: ${res.body.slice(0, 200)}`);
    return res.json() as VersionsBody;
  };

  try {
    console.log(`\n[seed] 4 current (judge v${JUDGE_PROMPT_VERSION}) + 2 legacy (judge v1) on days 0-2; 3 current on days 10-11`);
    await seedSessionWithEval(0, JUDGE_PROMPT_VERSION, "2");
    await seedSessionWithEval(0, JUDGE_PROMPT_VERSION, "2");
    await seedSessionWithEval(1, JUDGE_PROMPT_VERSION, "2");
    await seedSessionWithEval(1, JUDGE_PROMPT_VERSION, "2");
    await seedSessionWithEval(2, "1", "1"); // legacy
    await seedSessionWithEval(2, "1", "1"); // legacy
    await seedSessionWithEval(10, JUDGE_PROMPT_VERSION, "2");
    await seedSessionWithEval(10, JUDGE_PROMPT_VERSION, "2");
    await seedSessionWithEval(11, JUDGE_PROMPT_VERSION, "2");

    console.log("\n[a] mixed selection: segments split, legacy flagged, boundary warned");
    const mixed = await fetchVersions(-1, 13);
    const current = mixed.segments.find((s) => !s.legacy && s.judge_prompt_version === JUDGE_PROMPT_VERSION);
    const legacy = mixed.segments.find((s) => s.legacy && s.judge_prompt_version === "1");
    check("segments split into exactly current + legacy", mixed.segments.length === 2, JSON.stringify(mixed.segments));
    check("current segment: n = 7, legacy = false", current?.n === 7, JSON.stringify(current));
    check("legacy segment: n = 2, flagged legacy = true", legacy?.n === 2 && legacy.legacy === true, JSON.stringify(legacy));
    check("legacy segment carries its own stamps (judge v1)",
      legacy?.judge_prompt_version === "1" && legacy.detector_version === "1", JSON.stringify(legacy));
    check("current segment carries the current stamps",
      current?.competency_model_version === String(MODEL_VERSION) && current.detector_version === "2",
      JSON.stringify(current));
    check("boundary_warning non-null and names the legacy count",
      typeof mixed.boundary_warning === "string" && mixed.boundary_warning.includes("2 evaluation"),
      String(mixed.boundary_warning));
    check("envelope version_context = current judge",
      mixed.version_context.judge_prompt_version === JUDGE_PROMPT_VERSION, JSON.stringify(mixed.version_context));

    console.log("\n[b] homogeneous current-only selection: no boundary warning");
    const homo = await fetchVersions(9, 13);
    check("boundary_warning null when no legacy is in range", homo.boundary_warning === null, String(homo.boundary_warning));
    check("single current segment, n = 3",
      homo.segments.length === 1 && homo.segments[0]?.n === 3 && homo.segments[0]?.legacy === false,
      JSON.stringify(homo.segments));
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
  console.error("verify-version-panel crashed:", err);
  process.exit(1);
});
