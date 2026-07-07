// Acceptance verifier for P5.2 — competency_difficulty_stats accumulator.
// Infra-light: no server, no E2B, no LLM. Seeds a synthetic scenario +
// sessions (mixed scorable / bands) + evaluations + evaluation_items directly
// via the service-role client, runs services/difficulty-stats.ts, and asserts:
//   - only scorable IS TRUE sessions are counted (false / null excluded)
//   - only status='complete' evaluations are counted
//   - band grouping keys on sessions.difficulty_band, falling back to the
//     scenario's own difficulty when the session band is null
//   - n / mean_score / pass_rate (score >= 3) / spread (population stddev,
//     4dp) math is right
//   - stats_version === DIFFICULTY_STATS_VERSION is stamped on every row
//   - updateDifficultyStats never throws (fire-and-forget contract), even
//     when migration 0020 is not applied (graceful-degradation branch)
// Self-cleans. Exit 0 on PASS, 1 on FAIL.
//
// If migration 0020 is NOT applied yet, the full assertions can't run; the
// script verifies the graceful no-throw degradation instead and exits 0 with
// a loud SKIP so CI isn't red before the migration lands.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-difficulty-stats.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE env"); process.exit(1); }

// Import AFTER dotenv so the service module picks up env at load.
const ds = await import("../src/services/difficulty-stats.js");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);
const check = (name: string, ok: boolean, detail?: string) =>
  ok ? pass(name) : fail(`${name}${detail ? ` — ${detail}` : ""}`);

// Fixed synthetic ids (self-cleaning; d5 prefix = difficulty-stats verifier).
const SCEN = "00000000-0000-4000-8000-0000000d5200";
const SLUG = "verify-difficulty-stats";
const SIDS = {
  easy1: "00000000-0000-4000-8000-0000000d5201", // easy, scorable=true    → counts (easy)
  easy2: "00000000-0000-4000-8000-0000000d5202", // easy, scorable=true    → counts (easy)
  easy3: "00000000-0000-4000-8000-0000000d5203", // easy, scorable=true    → counts (easy)
  noband: "00000000-0000-4000-8000-0000000d5204", // band NULL, scorable=true → counts under fallback 'mid'
  notscorable: "00000000-0000-4000-8000-0000000d5205", // hard, scorable=false → excluded
  nullscorable: "00000000-0000-4000-8000-0000000d5206", // easy, scorable NULL → excluded
} as const;
const EIDS = {
  easy1: "00000000-0000-4000-8000-0000000d5211",
  easy2: "00000000-0000-4000-8000-0000000d5212",
  easy3: "00000000-0000-4000-8000-0000000d5213",
  noband: "00000000-0000-4000-8000-0000000d5214",
  notscorable: "00000000-0000-4000-8000-0000000d5215",
  nullscorable: "00000000-0000-4000-8000-0000000d5216",
  incomplete: "00000000-0000-4000-8000-0000000d5217", // status != complete → excluded
} as const;

async function cleanup(): Promise<void> {
  await supabase.from("evaluations").delete().in("id", Object.values(EIDS)); // items cascade
  // Table may not exist pre-0020 — ignore the error.
  await supabase.from("competency_difficulty_stats").delete().eq("scenario_id", SCEN);
  await supabase.from("sessions").delete().in("id", Object.values(SIDS));
  await supabase.from("scenarios").delete().eq("id", SCEN);
}

async function seedScenario(): Promise<void> {
  const { error } = await supabase.from("scenarios").insert({
    id: SCEN, slug: SLUG, title: "verify difficulty stats (synthetic)",
    role: "fde", difficulty: "mid", // fallback band for null-band sessions
  });
  if (error) throw new Error(`scenario seed: ${error.message}`);
}

async function seedSession(id: string, band: string | null, scorable: boolean | null): Promise<void> {
  const { error } = await supabase.from("sessions").insert({
    id, status: "completed", sandbox_id: "verify-difficulty-stats", template: "crucible-dev",
    litellm_key_alias: "vds", model: "gemini-flash", budget_usd: 1.0, timeout_min: 60,
    deadline: "2030-01-01T00:00:00.000Z", scenario_state: {}, scenario_id: SCEN,
    difficulty_band: band, scorable,
  });
  if (error) throw new Error(`session seed ${id}: ${error.message}`);
}

async function seedEval(
  id: string, sessionId: string, status: string,
  items: Array<{ competency: string; score: number | null }>,
): Promise<void> {
  const { error } = await supabase.from("evaluations").insert({
    id, session_id: sessionId, scenario_id: SCEN, status, model: "verify",
  });
  if (error) throw new Error(`evaluation seed ${id}: ${error.message}`);
  if (items.length > 0) {
    const { error: iErr } = await supabase.from("evaluation_items").insert(
      items.map((it) => ({ evaluation_id: id, competency: it.competency, score: it.score })),
    );
    if (iErr) throw new Error(`items seed ${id}: ${iErr.message}`);
  }
}

interface StatRow {
  difficulty_band: string; competency_key: string; n: number;
  mean_score: string | number; pass_rate: string | number;
  spread: string | number; stats_version: string;
}
const num = (v: string | number) => Math.round(Number(v) * 1e4) / 1e4;

(async () => {
  console.log("verify-difficulty-stats — P5.2");

  // ── [0] migration probe ──
  const { error: tableErr } = await supabase
    .from("competency_difficulty_stats").select("scenario_id").limit(1);
  const { error: colErr } = await supabase
    .from("sessions").select("difficulty_band").limit(1);

  if (tableErr || colErr) {
    console.log("\n  SKIP: migration 0020 not applied (" +
      (tableErr ? "competency_difficulty_stats missing" : "sessions.difficulty_band missing") +
      ") — verifying graceful degradation only.");
    // Fire-and-forget contract: must not throw even though the schema is
    // missing. Seed enough that the recompute reaches the missing column.
    await cleanup();
    try {
      await seedScenario();
      await supabase.from("sessions").insert({
        id: SIDS.easy1, status: "completed", sandbox_id: "verify-difficulty-stats",
        template: "crucible-dev", litellm_key_alias: "vds", model: "gemini-flash",
        budget_usd: 1.0, timeout_min: 60, deadline: "2030-01-01T00:00:00.000Z",
        scenario_state: {}, scenario_id: SCEN, scorable: true,
      });
      await seedEval(EIDS.easy1, SIDS.easy1, "complete", [{ competency: "problem_framing", score: 4 }]);
      const rows = await ds.updateDifficultyStats(SCEN);
      check("updateDifficultyStats did not throw with 0020 missing", Array.isArray(rows));
      check("degraded call returned no rows", rows.length === 0, `${rows.length} rows`);
    } catch (err) {
      fail(`graceful degradation broken: ${(err as Error).message}`);
    }
    await cleanup();
    console.log("\n" + (failures === 0 ? "SKIPPED (0020 not applied) — degradation checks passed" : `FAILED: ${failures} check(s)`));
    process.exit(failures === 0 ? 0 : 1);
  }

  await cleanup();

  // ── [1] seed ──
  console.log("\n[1] seed synthetic scenario + sessions + evaluations");
  try {
    await seedScenario();
    await seedSession(SIDS.easy1, "easy", true);
    await seedSession(SIDS.easy2, "easy", true);
    await seedSession(SIDS.easy3, "easy", true);
    await seedSession(SIDS.noband, null, true);          // → fallback band 'mid'
    await seedSession(SIDS.notscorable, "hard", false);  // → excluded
    await seedSession(SIDS.nullscorable, "easy", null);  // → excluded (IS TRUE, not IS NOT FALSE)

    // easy comp scores: [4, 2, 1] → n=3 mean=2.3333 pass=1/3 popsd=1.2472
    await seedEval(EIDS.easy1, SIDS.easy1, "complete", [
      { competency: "problem_framing", score: 4 },
      { competency: "data_fluency", score: 2 },
    ]);
    await seedEval(EIDS.easy2, SIDS.easy2, "complete", [{ competency: "problem_framing", score: 2 }]);
    await seedEval(EIDS.easy3, SIDS.easy3, "complete", [
      { competency: "problem_framing", score: 1 },
      { competency: "execution", score: null }, // unassessed → never counted
    ]);
    await seedEval(EIDS.noband, SIDS.noband, "complete", [{ competency: "problem_framing", score: 5 }]);
    // All three below carry loud score-5 items that must NOT appear anywhere:
    await seedEval(EIDS.notscorable, SIDS.notscorable, "complete", [{ competency: "problem_framing", score: 5 }]);
    await seedEval(EIDS.nullscorable, SIDS.nullscorable, "complete", [{ competency: "problem_framing", score: 5 }]);
    await seedEval(EIDS.incomplete, SIDS.easy1, "error", [{ competency: "problem_framing", score: 5 }]);
    pass("seeded 1 scenario, 6 sessions, 7 evaluations");
  } catch (err) {
    fail((err as Error).message);
    await cleanup();
    process.exit(1);
  }

  // ── [2] recompute ──
  console.log("\n[2] updateDifficultyStats recomputes + upserts");
  const returned = await ds.updateDifficultyStats(SCEN);
  check("returned rows (did not degrade)", returned.length > 0, "0 rows returned");

  const { data, error } = await supabase
    .from("competency_difficulty_stats")
    .select("difficulty_band, competency_key, n, mean_score, pass_rate, spread, stats_version")
    .eq("scenario_id", SCEN);
  if (error) { fail(`stats read: ${error.message}`); await cleanup(); process.exit(1); }
  const rows = (data ?? []) as StatRow[];
  const byKey = new Map(rows.map((r) => [`${r.difficulty_band}/${r.competency_key}`, r]));

  // ── [3] assertions ──
  console.log("\n[3] band grouping + exclusions");
  check("exactly 3 stat rows for the scenario", rows.length === 3,
    `got ${rows.length}: ${rows.map((r) => `${r.difficulty_band}/${r.competency_key}`).join(", ")}`);
  check("no 'hard' band row (scorable=false session excluded)",
    !rows.some((r) => r.difficulty_band === "hard"));
  check("null-band scorable session grouped under scenario fallback 'mid'",
    byKey.has("mid/problem_framing"));

  const easyPF = byKey.get("easy/problem_framing");
  check("easy/problem_framing exists", !!easyPF);
  if (easyPF) {
    // Only the 3 scorable easy sessions' complete evals count: scores [4,2,1].
    // scorable=null (5), scorable=false (5) and status='error' (5) excluded.
    check("n=3 (scorable-true, complete evals only)", easyPF.n === 3, `n=${easyPF.n}`);
    check("mean_score=2.3333", num(easyPF.mean_score) === 2.3333, `got ${easyPF.mean_score}`);
    check("pass_rate=0.3333 (score>=3)", num(easyPF.pass_rate) === 0.3333, `got ${easyPF.pass_rate}`);
    check("spread=1.2472 (population stddev, 4dp)", num(easyPF.spread) === 1.2472, `got ${easyPF.spread}`);
  }

  console.log("\n[4] single-sample + null-score handling");
  const easyDF = byKey.get("easy/data_fluency");
  check("easy/data_fluency exists", !!easyDF);
  if (easyDF) {
    check("n=1, mean=2, pass_rate=0, spread=0",
      easyDF.n === 1 && num(easyDF.mean_score) === 2 && num(easyDF.pass_rate) === 0 && num(easyDF.spread) === 0,
      JSON.stringify(easyDF));
  }
  check("null-score item (execution) produced no row", !byKey.has("easy/execution"));
  const midPF = byKey.get("mid/problem_framing");
  if (midPF) {
    check("mid/problem_framing: n=1, mean=5, pass_rate=1, spread=0",
      midPF.n === 1 && num(midPF.mean_score) === 5 && num(midPF.pass_rate) === 1 && num(midPF.spread) === 0,
      JSON.stringify(midPF));
  }

  console.log("\n[5] version stamp + return value");
  check(`stats_version === "${ds.DIFFICULTY_STATS_VERSION}" on every row`,
    rows.length > 0 && rows.every((r) => r.stats_version === ds.DIFFICULTY_STATS_VERSION));
  check("returned rows match persisted rows", returned.length === rows.length,
    `returned ${returned.length} vs persisted ${rows.length}`);

  // ── [6] idempotent re-run ──
  console.log("\n[6] re-run is idempotent");
  const again = await ds.updateDifficultyStats(SCEN);
  const { count } = await supabase
    .from("competency_difficulty_stats")
    .select("competency_key", { count: "exact", head: true })
    .eq("scenario_id", SCEN);
  check("re-run upserts in place (no duplicate rows)", again.length === 3 && (count ?? 0) === 3,
    `returned ${again.length}, count ${count}`);

  console.log("\n[cleanup]");
  await cleanup();
  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
