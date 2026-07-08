/**
 * verify-discrimination-view.ts — V.3 acceptance (discrimination, 4.1).
 *
 * Infra-light (Supabase service-role + in-process Fastify inject — no E2B, no
 * LLM). Seeds, on the existing fde-db-triage scenario in a far-future per-run
 * window, MIN_N (10) scorable evaluations under one version set with:
 *   - competency "spread":  scores varied 1..5  → no flags, item_total_r present
 *   - competency "bunched": all 3.0             → "bunched" flag (sd < 0.5)
 *   - competency "rare":    items on only 5 evals → insufficient_n, numerics null
 * Then seeds 3 EXTRA evaluations under judge_prompt_version "1" (legacy) with
 * wild scores and asserts the discrimination segments are byte-for-byte
 * UNCHANGED (no pooling across the version boundary), while the versions view
 * shows a boundary_warning + a legacy segment.
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; clean SKIP (exit 0)
 * without Supabase creds or before migration 0018.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-discrimination-view.ts
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

interface Segment {
  competency_key: string; n: number;
  mean: number | null; sd: number | null; cv: number | null;
  item_total_r: number | null; insufficient_n: boolean; flags: string[];
}
interface VersionSegment {
  competency_model_version: string; detector_version: string;
  judge_prompt_version: string; scenario_version: string; n: number; legacy: boolean;
}

async function main(): Promise<void> {
  console.log("verify-discrimination-view — V.3");
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
  const { MIN_N } = await import("../src/services/validity.js");
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
  const FROM = new Date(base - DAY).toISOString();
  const TO = new Date(base + 20 * DAY).toISOString();
  const SPREAD = `vd_spread_${run}`;
  const BUNCHED = `vd_bunched_${run}`;
  const RARE = `vd_rare_${run}`;
  const sessionIds: string[] = [];

  const seedSession = async (createdAt: string): Promise<string> => {
    const id = randomUUID();
    const { error } = await db.from("sessions").insert({
      id, status: "completed", sandbox_id: `vd-dis-${run}`, template: "crucible-dev",
      litellm_key_alias: `vd-dis-${run}-${id.slice(0, 8)}`, model: "gemini-flash",
      budget_usd: 1.0, timeout_min: 60, deadline: "2032-01-01T00:00:00.000Z",
      scenario_state: {}, org_id: defOrg.id, scenario_id: SCEN_ID,
      scorable: true, exclusion_reason: null, difficulty_band: "mid", created_at: createdAt,
    });
    if (error) throw new Error(`seed session failed: ${error.message}`);
    sessionIds.push(id);
    return id;
  };
  const seedEval = async (sessionId: string, overall: number, judge: string, detector: string): Promise<string> => {
    const id = randomUUID();
    const { error } = await db.from("evaluations").insert({
      id, session_id: sessionId, scenario_id: SCEN_ID, overall_score: overall,
      summary: "verify-discrimination seed", model: "verify", status: "complete",
      competency_model_version: MODEL_VERSION, detector_version: detector,
      judge_prompt_version: judge, scenario_version: SCEN_VERSION,
    });
    if (error) throw new Error(`seed evaluation failed: ${error.message}`);
    return id;
  };
  const seedItem = async (evaluationId: string, competency: string, score: number, weight: number): Promise<void> => {
    const { error } = await db.from("evaluation_items").insert({
      evaluation_id: evaluationId, competency, score, weight, assessed: true, rationale: "verify seed",
    });
    if (error) throw new Error(`seed item failed: ${error.message}`);
  };

  let adminKey = process.env.ORG_ADMIN_KEY ?? "";
  let adminOrgId: string | null = null;
  if (!adminKey) {
    const a = await createOrg(`vd-dis-adm-${run}`, `vd-dis-adm-${run}`);
    adminOrgId = a.org.id;
    const { error } = await db.from("orgs").update({ role: "admin" }).eq("id", a.org.id);
    if (error) throw new Error(`admin role flip failed: ${error.message}`);
    adminKey = a.apiKey;
  }

  const app = Fastify();
  await app.register(validityRoutes);
  const fetchView = async <T>(view: string): Promise<T> => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/validity/${view}`,
      headers: { "x-org-key": adminKey },
      query: { scenario_id: SCEN_ID, from: FROM, to: TO },
    });
    if (res.statusCode !== 200) throw new Error(`${view} → ${res.statusCode}: ${res.body.slice(0, 200)}`);
    return res.json() as T;
  };

  try {
    // ── Seed: MIN_N scorable evaluations under the current version set ──────
    console.log(`\n[seed] ${MIN_N} scorable evaluations under judge v${JUDGE_PROMPT_VERSION}`);
    const spreadScores = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 2];
    const rareScores = [2, 3, 4, 2.5, 3.5]; // only 5 rows → below MIN_N
    for (let i = 0; i < MIN_N; i++) {
      const s = spreadScores[i]!;
      const sid = await seedSession(at(i % 5));
      // overall deliberately ≠ exact weighted mean so the CORRECTED total
      // varies: corrected_spread = 2*overall − s = 3 + 0.1s → item_total_r = 1.
      const eid = await seedEval(sid, (s + 3) / 2 + 0.05 * s, JUDGE_PROMPT_VERSION, "2");
      await seedItem(eid, SPREAD, s, 0.5);
      await seedItem(eid, BUNCHED, 3.0, 0.5);
      if (i < rareScores.length) await seedItem(eid, RARE, rareScores[i]!, 0.2);
    }

    console.log("\n[a] segment shape: spread clean, bunched flagged, rare insufficient");
    const disc1 = await fetchView<{ segments: Segment[] }>("discrimination");
    const seg = (k: string): Segment | undefined => disc1.segments.find((x) => x.competency_key === k);
    const spread = seg(SPREAD), bunched = seg(BUNCHED), rare = seg(RARE);

    check(`spread: n = ${MIN_N}, not insufficient`, spread?.n === MIN_N && spread.insufficient_n === false, JSON.stringify(spread));
    check("spread: no flags (sd well above 0.5, r well above 0.2)",
      spread !== undefined && spread.flags.length === 0, JSON.stringify(spread?.flags));
    check("spread: item_total_r present and ≈ 1 (corrected-total pairing)",
      spread?.item_total_r !== null && spread !== undefined && Math.abs((spread.item_total_r ?? 0) - 1) < 0.01,
      `item_total_r=${spread?.item_total_r}`);
    check("bunched: 'bunched' flag set (sd < 0.5)",
      bunched !== undefined && bunched.flags.includes("bunched"), JSON.stringify(bunched));
    check("bunched: sd = 0", bunched?.sd === 0, `sd=${bunched?.sd}`);
    check("rare (n=5 < MIN_N): insufficient_n true", rare?.insufficient_n === true, JSON.stringify(rare));
    check("rare: numeric fields nulled server-side",
      rare !== undefined && rare.mean === null && rare.sd === null && rare.cv === null && rare.item_total_r === null,
      JSON.stringify(rare));

    // ── Legacy contamination attempt: 3 wild judge-v1 evaluations ───────────
    console.log("\n[b] legacy (judge v1) rows must NOT pool into the segments");
    for (let i = 0; i < 3; i++) {
      const sid = await seedSession(at(5 + i));
      const eid = await seedEval(sid, 1.0, "1", "1"); // wild: everything extreme
      await seedItem(eid, SPREAD, 5, 0.5);
      await seedItem(eid, BUNCHED, 1, 0.5);
    }
    const disc2 = await fetchView<{ segments: Segment[] }>("discrimination");
    check("discrimination segments UNCHANGED after legacy seed (no pooling)",
      JSON.stringify(disc2.segments) === JSON.stringify(disc1.segments),
      JSON.stringify(disc2.segments));

    const versions = await fetchView<{ segments: VersionSegment[]; boundary_warning: string | null }>("versions");
    check("versions: boundary_warning present", typeof versions.boundary_warning === "string" && versions.boundary_warning.length > 0,
      String(versions.boundary_warning));
    const legacySeg = versions.segments.find((s) => s.legacy && s.judge_prompt_version === "1");
    check("versions: legacy judge-v1 segment present with n = 3", legacySeg?.n === 3, JSON.stringify(versions.segments));
    const currentSeg = versions.segments.find((s) => !s.legacy && s.judge_prompt_version === JUDGE_PROMPT_VERSION);
    check(`versions: current segment n = ${MIN_N}`, currentSeg?.n === MIN_N, JSON.stringify(versions.segments));
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
  console.error("verify-discrimination-view crashed:", err);
  process.exit(1);
});
