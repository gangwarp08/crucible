/**
 * verify-cohort-dashboard.ts — P4.1 acceptance.
 *
 * Infra-light (Supabase service-role only — no server, no sandbox, no LLM):
 * seeds a synthetic scenario + two orgs' sessions/evaluations directly, then
 * exercises services/cohort.ts (the assembly behind
 * GET /api/review/cohorts/:scenarioId).
 *
 * Acceptance (spec P4.1): ranking + status correct; org-scoped —
 *   [a] ranking by overall_score desc; unevaluated rows sink (rank null);
 *   [b] ORG SCOPING: a partner org sees ONLY its own sessions; admin sees all
 *       (and the cross-org row tops the admin ranking);
 *   [c] scorable/excluded status + exclusion_reason surface per row;
 *   [d] aggregates: n / scorable / excluded counts, mean+stddev computed over
 *       SCORABLE evaluated sessions only (excluded scores never averaged);
 *   [e] per-competency cells, candidate_label, difficulty band per row;
 *   [f] AI-Fluency placement mapped from the ai_orchestration score;
 *   [g] suspicion computed from integrity.* events (batch query), zero when
 *       a session has none;
 *   [h] unknown scenario → null (route 404).
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; SKIPs (exit 0)
 * without Supabase creds or before migrations 0018/0020.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-cohort-dashboard.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID, randomBytes } from "crypto";

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
  console.log("verify-cohort-dashboard — P4.1");
  if (!url || !key) {
    console.log("  ⚠ SKIP — Supabase creds absent");
    process.exit(0);
  }

  const { supabase } = await import("../src/services/supabase.js");
  if (!supabase) {
    console.log("  ⚠ SKIP — service-role client unavailable");
    process.exit(0);
  }
  const { createOrg } = await import("../src/services/orgs.js");
  const { buildCohort } = await import("../src/services/cohort.js");

  const orgsProbe = await supabase.from("orgs").select("id").limit(1);
  if (orgsProbe.error) {
    console.log(`  ⚠ SKIP — orgs table unavailable (0018 not applied?): ${orgsProbe.error.message}`);
    process.exit(0);
  }
  const bandProbe = await supabase.from("sessions").select("difficulty_band").limit(1);
  if (bandProbe.error) {
    console.log(`  ⚠ SKIP — sessions.difficulty_band unavailable (0020 not applied?): ${bandProbe.error.message}`);
    process.exit(0);
  }

  const suffix = randomBytes(4).toString("hex");
  const seeded = {
    orgIds: [] as string[],
    sessionIds: [] as string[],
    evalIds: [] as string[],
    linkIds: [] as string[],
    scenarioIds: [] as string[],
  };
  async function cleanup(): Promise<void> {
    // evaluation_items cascade with evaluations; events cascade with sessions.
    if (seeded.evalIds.length) await supabase!.from("evaluations").delete().in("id", seeded.evalIds);
    if (seeded.linkIds.length) await supabase!.from("session_links").delete().in("id", seeded.linkIds);
    if (seeded.sessionIds.length) await supabase!.from("sessions").delete().in("id", seeded.sessionIds);
    if (seeded.scenarioIds.length) await supabase!.from("scenarios").delete().in("id", seeded.scenarioIds);
    if (seeded.orgIds.length) await supabase!.from("orgs").delete().in("id", seeded.orgIds);
  }

  try {
    // ── Seed ─────────────────────────────────────────────────────────────
    const a = await createOrg(`Cohort A ${suffix}`, `test-cohort-a-${suffix}`);
    const b = await createOrg(`Cohort B ${suffix}`, `test-cohort-b-${suffix}`);
    seeded.orgIds.push(a.org.id, b.org.id);
    const adminOrg = { ...a.org, role: "admin" as const };

    const { data: scen, error: scenErr } = await supabase
      .from("scenarios")
      .insert({ slug: `verify-cohort-${suffix}`, title: `Verify Cohort ${suffix}`, role: "fde" })
      .select("id")
      .single();
    if (scenErr) throw new Error(`scenario seed failed: ${scenErr.message}`);
    const scenarioId = (scen as { id: string }).id;
    seeded.scenarioIds.push(scenarioId);

    async function seedSession(opts: {
      orgId: string;
      band: string | null;
      scorable: boolean | null;
      exclusionReason?: string | null;
    }): Promise<string> {
      const id = randomUUID();
      const { error } = await supabase!.from("sessions").insert({
        id,
        sandbox_id: `verify-cohort-${suffix}`,
        template: "verify",
        litellm_key_alias: `verify-${id}`,
        model: "none",
        budget_usd: 0,
        timeout_min: 1,
        deadline: new Date(Date.now() + 60_000).toISOString(),
        status: "completed",
        org_id: opts.orgId,
        scenario_id: scenarioId,
        difficulty_band: opts.band,
        scorable: opts.scorable,
        exclusion_reason: opts.exclusionReason ?? null,
        defense_outcome: "coherent",
      });
      if (error) throw new Error(`session seed failed: ${error.message}`);
      seeded.sessionIds.push(id);
      return id;
    }

    async function seedEval(
      sessionId: string,
      overall: number,
      items: Array<{ competency: string; score: number | null; assessed: boolean }>,
    ): Promise<void> {
      const { data, error } = await supabase!
        .from("evaluations")
        .insert({ session_id: sessionId, scenario_id: scenarioId, overall_score: overall, status: "complete" })
        .select("id")
        .single();
      if (error) throw new Error(`evaluation seed failed: ${error.message}`);
      const evalId = (data as { id: string }).id;
      seeded.evalIds.push(evalId);
      const { error: itemsErr } = await supabase!.from("evaluation_items").insert(
        items.map((it) => ({
          evaluation_id: evalId,
          competency: it.competency,
          score: it.score,
          assessed: it.assessed,
          weight: 0.5,
          rationale: `seeded ${it.competency}`,
          evidence: [],
        })),
      );
      if (itemsErr) throw new Error(`items seed failed: ${itemsErr.message}`);
    }

    // Org A: two scorable (4.5 / 3.0), one excluded (2.0), one unevaluated.
    const a1 = await seedSession({ orgId: a.org.id, band: "easy", scorable: true });
    const a2 = await seedSession({ orgId: a.org.id, band: "mid", scorable: true });
    const a3 = await seedSession({
      orgId: a.org.id, band: "mid", scorable: false, exclusionReason: "excluded_abandoned",
    });
    const a4 = await seedSession({ orgId: a.org.id, band: null, scorable: null });
    // Org B: one scorable top scorer (5.0) — must NOT leak into A's cohort.
    const b1 = await seedSession({ orgId: b.org.id, band: "hard", scorable: true });

    await seedEval(a1, 4.5, [
      { competency: "execution", score: 5, assessed: true },
      { competency: "ai_orchestration", score: 4.5, assessed: true },
    ]);
    await seedEval(a2, 3.0, [
      { competency: "execution", score: 3, assessed: true },
      { competency: "ai_orchestration", score: 3, assessed: true },
    ]);
    await seedEval(a3, 2.0, [
      { competency: "execution", score: 2, assessed: true },
      { competency: "ai_orchestration", score: 2, assessed: true },
    ]);
    await seedEval(b1, 5.0, [
      { competency: "execution", score: 5, assessed: true },
      { competency: "ai_orchestration", score: 5, assessed: true },
    ]);

    // Candidate label for a1 (bound session link, owned by org A).
    const { data: link, error: linkErr } = await supabase
      .from("session_links")
      .insert({
        token_hash: randomBytes(32).toString("hex"),
        candidate_label: `Candidate One ${suffix}`,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        consumed_at: new Date().toISOString(),
        session_id: a1,
        org_id: a.org.id,
      })
      .select("id")
      .single();
    if (linkErr) throw new Error(`link seed failed: ${linkErr.message}`);
    seeded.linkIds.push((link as { id: string }).id);

    // Integrity events for a2 only (suspicion via the batch events query).
    const { error: evErr } = await supabase.from("events").insert(
      [0, 1, 2, 3].map((i) => ({
        session_id: a2,
        seq: i + 1,
        type: "integrity.tab_blur",
        actor: "candidate",
        payload: {},
      })),
    );
    if (evErr) throw new Error(`events seed failed: ${evErr.message}`);

    // ── [a] ranking ──────────────────────────────────────────────────────
    console.log("\n[a] ranking (partner A's cohort)");
    const cohortA = await buildCohort(scenarioId, a.org);
    if (!cohortA) throw new Error("cohort A came back null");
    const order = cohortA.rows.map((r) => r.session_id);
    check("ranked by overall desc", order[0] === a1 && order[1] === a2 && order[2] === a3,
      order.join(","));
    check("ranks assigned 1..3 to evaluated rows",
      cohortA.rows[0]!.rank === 1 && cohortA.rows[1]!.rank === 2 && cohortA.rows[2]!.rank === 3);
    check("unevaluated session sinks with rank null",
      order[3] === a4 && cohortA.rows[3]!.rank === null && cohortA.rows[3]!.overall_score === null);

    // ── [b] org scoping ──────────────────────────────────────────────────
    console.log("\n[b] org scoping");
    check("partner A sees exactly its 4 sessions", cohortA.rows.length === 4, `got ${cohortA.rows.length}`);
    check("B's session does not leak into A's cohort", !order.includes(b1));
    const cohortAdmin = await buildCohort(scenarioId, adminOrg);
    check("admin sees all 5 sessions", cohortAdmin?.rows.length === 5, `got ${cohortAdmin?.rows.length}`);
    check("admin ranking topped by B's 5.0", cohortAdmin?.rows[0]?.session_id === b1);

    // ── [c] scorable / excluded status ───────────────────────────────────
    console.log("\n[c] scorable / excluded status");
    const rowA3 = cohortA.rows.find((r) => r.session_id === a3)!;
    check("excluded row carries scorable=false + reason",
      rowA3.scorable === false && rowA3.exclusion_reason === "excluded_abandoned");
    check("scorable rows carry scorable=true",
      cohortA.rows.find((r) => r.session_id === a1)?.scorable === true);

    // ── [d] aggregates ───────────────────────────────────────────────────
    console.log("\n[d] aggregates (server-side)");
    const agg = cohortA.aggregates;
    check("n = 4", agg.n === 4, `n=${agg.n}`);
    check("scorable_count = 2", agg.scorable_count === 2, `${agg.scorable_count}`);
    check("excluded_count = 1", agg.excluded_count === 1, `${agg.excluded_count}`);
    // Mean over SCORABLE evaluated sessions only: (4.5 + 3.0) / 2 — the
    // excluded 2.0 must NOT drag it down (it would be 3.17 if it leaked in).
    check("mean over scorable only = 3.75", agg.mean === 3.75, `mean=${agg.mean}`);
    check("stddev (population) = 0.75", agg.stddev === 0.75, `stddev=${agg.stddev}`);

    // ── [e] row detail: cells, label, band ───────────────────────────────
    console.log("\n[e] per-row detail");
    const rowA1 = cohortA.rows.find((r) => r.session_id === a1)!;
    check("candidate_label from the bound session link",
      rowA1.candidate_label === `Candidate One ${suffix}`);
    check("difficulty band on the row", rowA1.difficulty_band === "easy");
    const execCell = rowA1.competencies.find((c) => c.key === "execution");
    check("per-competency cell present (execution 5)", execCell?.score === 5 && execCell.assessed === true);

    // ── [f] AI-Fluency placement ─────────────────────────────────────────
    console.log("\n[f] AI-Fluency (presentation-only)");
    check("4.5 → ai_orchestrator", rowA1.ai_fluency === "ai_orchestrator");
    check("3.0 → ai_augmented",
      cohortA.rows.find((r) => r.session_id === a2)?.ai_fluency === "ai_augmented");
    check("2.0 → ai_dependent", rowA3.ai_fluency === "ai_dependent");
    check("no evaluation → no placement",
      cohortA.rows.find((r) => r.session_id === a4)?.ai_fluency === null);

    // ── [g] suspicion from the batch integrity query ─────────────────────
    console.log("\n[g] suspicion");
    const rowA2 = cohortA.rows.find((r) => r.session_id === a2)!;
    check("integrity events → suspicion > 0", rowA2.suspicion.score > 0, `score=${rowA2.suspicion.score}`);
    check("no integrity events → suspicion 0", rowA1.suspicion.score === 0);

    // ── [h] unknown scenario ─────────────────────────────────────────────
    console.log("\n[h] unknown scenario");
    check("random scenario id → null (route 404)", (await buildCohort(randomUUID(), adminOrg)) === null);
  } finally {
    await cleanup();
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-cohort-dashboard crashed:", err);
  process.exit(1);
});
