/**
 * verify-correlation-view.ts — V.4 acceptance (score↔outcome correlation, 4.4).
 *
 * Infra-light (Supabase service-role + in-process Fastify inject — no E2B, no
 * LLM). Seeds, on the existing fde-db-triage scenario in a far-future per-run
 * window, outcome-linked pairs (outcomes.session_id → evaluations.overall,
 * exactly the join correlateOutcomes performs) for outcome_type "ramp_weeks":
 *   - 19 pairs → paired_n surfaced = 19, insufficient_n true, r NULL,
 *     caveat mentions the min-20 gate;
 *   - +1 pair (20, known near-linear relation) → r ≈ hand-computed Pearson
 *     (tolerance 0.01), descriptive caveat present;
 *   - +1 pair on a NON-scorable session (complete evaluation and all) → must
 *     NOT count: paired_n stays 20, r unchanged (scorable + current-version
 *     sessions only).
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; clean SKIP (exit 0)
 * without Supabase creds or before migration 0018.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-correlation-view.ts
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

interface CorrelationPairRow {
  outcome_type: string; competency_key: string; paired_n: number;
  r: number | null; insufficient_n: boolean; caveat: string;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i]! - mx) * (ys[i]! - my);
    vx += (xs[i]! - mx) ** 2;
    vy += (ys[i]! - my) ** 2;
  }
  return cov / Math.sqrt(vx * vy);
}

async function main(): Promise<void> {
  console.log("verify-correlation-view — V.4");
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
  const { MIN_PAIRED_N } = await import("../src/services/validity.js");
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
  const REF_PREFIX = `vd-cor-${run}`;
  const OUTCOME_TYPE = "ramp_weeks";
  const sessionIds: string[] = [];

  // Known near-linear relation (not perfectly collinear thanks to the jitter):
  // score_i = 1 + 0.2 i; ramp_weeks_i = 24 − 4·score_i + 0.7·((i mod 3) − 1).
  const score = (i: number): number => 1 + 0.2 * i;
  const outcomeValue = (i: number): number => 24 - 4 * score(i) + 0.7 * ((i % 3) - 1);

  const seedPair = async (i: number, scorable: boolean): Promise<void> => {
    const id = randomUUID();
    const { error: sErr } = await db.from("sessions").insert({
      id, status: "completed", sandbox_id: `vd-cor-${run}`, template: "crucible-dev",
      litellm_key_alias: `vd-cor-${run}-${id.slice(0, 8)}`, model: "gemini-flash",
      budget_usd: 1.0, timeout_min: 60, deadline: "2032-01-01T00:00:00.000Z",
      scenario_state: {}, org_id: defOrg.id, scenario_id: SCEN_ID,
      scorable, exclusion_reason: scorable ? null : "excluded_infra",
      difficulty_band: "mid", created_at: at(i % 10),
    });
    if (sErr) throw new Error(`seed session failed: ${sErr.message}`);
    sessionIds.push(id);
    const { error: eErr } = await db.from("evaluations").insert({
      id: randomUUID(), session_id: id, scenario_id: SCEN_ID, overall_score: score(i),
      summary: "verify-correlation seed", model: "verify", status: "complete",
      competency_model_version: MODEL_VERSION, detector_version: "2",
      judge_prompt_version: JUDGE_PROMPT_VERSION, scenario_version: SCEN_VERSION,
    });
    if (eErr) throw new Error(`seed evaluation failed: ${eErr.message}`);
    const { error: oErr } = await db.from("outcomes").insert({
      candidate_ref: `${REF_PREFIX}-${i}`, session_id: id, scenario_id: SCEN_ID,
      outcome_type: OUTCOME_TYPE, outcome_value: { value: outcomeValue(i) },
      source: "manual", org_id: defOrg.id,
    });
    if (oErr) throw new Error(`seed outcome failed: ${oErr.message}`);
  };

  let adminKey = process.env.ORG_ADMIN_KEY ?? "";
  let adminOrgId: string | null = null;
  if (!adminKey) {
    const a = await createOrg(`vd-cor-adm-${run}`, `vd-cor-adm-${run}`);
    adminOrgId = a.org.id;
    const { error } = await db.from("orgs").update({ role: "admin" }).eq("id", a.org.id);
    if (error) throw new Error(`admin role flip failed: ${error.message}`);
    adminKey = a.apiKey;
  }

  const app = Fastify();
  await app.register(validityRoutes);
  const fetchOverallPair = async (): Promise<CorrelationPairRow> => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/validity/correlation",
      headers: { "x-org-key": adminKey },
      query: { scenario_id: SCEN_ID, from: FROM, to: TO },
    });
    if (res.statusCode !== 200) throw new Error(`correlation → ${res.statusCode}: ${res.body.slice(0, 200)}`);
    const body = res.json() as { pairs: CorrelationPairRow[] };
    const pair = body.pairs.find((p) => p.outcome_type === OUTCOME_TYPE && p.competency_key === "overall");
    if (!pair) throw new Error(`no ${OUTCOME_TYPE}/overall pair in response: ${JSON.stringify(body.pairs)}`);
    return pair;
  };

  try {
    console.log(`\n[seed] ${MIN_PAIRED_N - 1} outcome-linked pairs (${OUTCOME_TYPE})`);
    for (let i = 0; i < MIN_PAIRED_N - 1; i++) await seedPair(i, true);

    console.log("\n[a] below MIN_PAIRED_N: paired_n surfaced, r nulled, caveat honest");
    const below = await fetchOverallPair();
    check(`paired_n = ${MIN_PAIRED_N - 1}`, below.paired_n === MIN_PAIRED_N - 1, `paired_n=${below.paired_n}`);
    check("insufficient_n = true", below.insufficient_n === true);
    check("r = null (no coefficient below the gate)", below.r === null, `r=${below.r}`);
    check(`caveat mentions the min-${MIN_PAIRED_N} gate`,
      below.caveat.includes(`min=${MIN_PAIRED_N}`), below.caveat);

    console.log(`\n[b] at ${MIN_PAIRED_N}: r matches a hand-computed Pearson`);
    await seedPair(MIN_PAIRED_N - 1, true);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < MIN_PAIRED_N; i++) {
      xs.push(outcomeValue(i)); // outcome_num
      ys.push(score(i));        // overall_score
    }
    const expected = pearson(xs, ys);
    const atMin = await fetchOverallPair();
    check(`paired_n = ${MIN_PAIRED_N}`, atMin.paired_n === MIN_PAIRED_N, `paired_n=${atMin.paired_n}`);
    check("insufficient_n = false", atMin.insufficient_n === false);
    check(`r ≈ hand-computed Pearson (${expected.toFixed(4)}, tol 0.01)`,
      atMin.r !== null && Math.abs(atMin.r - expected) <= 0.01, `r=${atMin.r}`);
    check("descriptive caveat still present at min N",
      atMin.caveat.length > 0 && /descriptive/i.test(atMin.caveat), atMin.caveat);

    console.log("\n[c] a pair on a NON-scorable session must not count");
    await seedPair(MIN_PAIRED_N, false); // scorable=false, eval + outcome and all
    const after = await fetchOverallPair();
    check(`paired_n still ${MIN_PAIRED_N} (non-scorable pair excluded)`,
      after.paired_n === MIN_PAIRED_N, `paired_n=${after.paired_n}`);
    check("r unchanged", after.r === atMin.r, `r=${after.r} vs ${atMin.r}`);
  } finally {
    console.log("\n[cleanup]");
    await app.close();
    await db.from("outcomes").delete().like("candidate_ref", `${REF_PREFIX}%`);
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
  console.error("verify-correlation-view crashed:", err);
  process.exit(1);
});
