// Acceptance verifier for P5.3 — band equating hook.
// Infra-light: no server, no E2B, no LLM. Seeds a synthetic family with two
// hard-band members (+ one easy member with no partner) and
// competency_difficulty_stats rows directly, runs services/equating.ts, and
// asserts:
//   - band-matched members with n >= EQUATING_MIN_N per side are compared
//   - gap = |meanA - meanB| (4dp) and comparable = gap <= EQUATING_MAX_GAP
//     (both the pure compareMeans and the DB-driven checkBandEquating)
//   - a side with n < EQUATING_MIN_N is excluded (no comparison emitted)
//   - stats rows from a DIFFERENT stats_version are ignored
//   - a band with a single calibrated member yields nothing
//   - unknown family → [] (and the whole hook is read-only: stats rows are
//     byte-identical after the run)
// Self-cleans. Exit 0 on PASS, 1 on FAIL. If migration 0020 is NOT applied,
// the full assertions can't run; the script verifies graceful degradation
// ([] without throwing) and exits 0 with a loud SKIP.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-equating-hook.ts
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

// Import AFTER dotenv so the service modules pick up env at load.
const eq = await import("../src/services/equating.js");
const { DIFFICULTY_STATS_VERSION } = await import("../src/services/difficulty-stats.js");

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

// Fixed synthetic ids (self-cleaning; d5 53 prefix = equating verifier).
const FAMILY = "verify-equating-hook-family";
const A    = "00000000-0000-4000-8000-0000000d5301"; // hard member A
const B    = "00000000-0000-4000-8000-0000000d5302"; // hard member B
const EASY = "00000000-0000-4000-8000-0000000d5303"; // easy member, no partner

async function cleanup(): Promise<void> {
  await supabase.from("competency_difficulty_stats").delete().in("scenario_id", [A, B, EASY]);
  await supabase.from("scenarios").delete().in("id", [A, B, EASY]);
  await supabase.from("scenario_families").delete().eq("family_id", FAMILY);
}

async function seed(): Promise<void> {
  const { error: famErr } = await supabase.from("scenario_families").insert({
    family_id: FAMILY, title: "verify equating hook (synthetic)", difficulty_band: "hard",
  });
  if (famErr) throw new Error(`family seed: ${famErr.message}`);
  const { error } = await supabase.from("scenarios").insert([
    { id: A,    slug: "verify-equating-a",    title: "veq A",    role: "fde", difficulty: "hard", family_id: FAMILY },
    { id: B,    slug: "verify-equating-b",    title: "veq B",    role: "fde", difficulty: "hard", family_id: FAMILY },
    { id: EASY, slug: "verify-equating-easy", title: "veq easy", role: "fde", difficulty: "easy", family_id: FAMILY },
  ]);
  if (error) throw new Error(`scenario seed: ${error.message}`);

  const V = DIFFICULTY_STATS_VERSION;
  const stat = (scenario_id: string, band: string, competency_key: string, n: number, mean: number, version = V) => ({
    scenario_id, difficulty_band: band, competency_key, n,
    mean_score: mean, pass_rate: 0.5, spread: 0.5, stats_version: version,
  });
  const { error: stErr } = await supabase.from("competency_difficulty_stats").insert([
    // problem_framing: 3.5 vs 4.0 → gap 0.5, comparable (<= 0.75)
    stat(A, "hard", "problem_framing", 8, 3.5),
    stat(B, "hard", "problem_framing", 6, 4.0),
    // data_fluency: 2.0 vs 3.1 → gap 1.1, NOT comparable
    stat(A, "hard", "data_fluency", 12, 2.0),
    stat(B, "hard", "data_fluency", 5, 3.1),
    // execution: B side has n=4 < min → excluded entirely
    stat(A, "hard", "execution", 9, 3.0),
    stat(B, "hard", "execution", 4, 5.0),
    // teamwork: B side computed under an OLD stats version → ignored
    stat(A, "hard", "teamwork", 7, 3.0),
    stat(B, "hard", "teamwork", 7, 3.2, "0-legacy"),
    // easy band: single calibrated member → nothing to compare
    stat(EASY, "easy", "problem_framing", 10, 4.5),
  ]);
  if (stErr) throw new Error(`stats seed: ${stErr.message}`);
}

(async () => {
  console.log("verify-equating-hook — P5.3");

  // ── [0] pure gap math (no DB required) ──
  console.log("\n[0] compareMeans (pure)");
  check("gap = |meanA - meanB| (4dp)", eq.compareMeans(3.5, 4.0).gap === 0.5);
  check("gap exactly at threshold 0.75 → comparable", eq.compareMeans(3.0, 3.75).comparable === true);
  check("gap just above threshold → NOT comparable", eq.compareMeans(3.0, 3.76).comparable === false);
  check("order-independent", eq.compareMeans(4.0, 3.5).gap === eq.compareMeans(3.5, 4.0).gap);
  check(`EQUATING_MAX_GAP = 0.75, EQUATING_MIN_N = 5`,
    eq.EQUATING_MAX_GAP === 0.75 && eq.EQUATING_MIN_N === 5);

  // ── migration probe ──
  const { error: tableErr } = await supabase
    .from("competency_difficulty_stats").select("scenario_id").limit(1);
  if (tableErr) {
    console.log("\n  SKIP: migration 0020 not applied (competency_difficulty_stats missing) — verifying graceful degradation only.");
    // Seed the family + two same-band members so the check actually REACHES
    // the missing stats table (an unknown family would return [] earlier).
    await cleanup();
    try {
      const { error: famErr } = await supabase.from("scenario_families").insert({
        family_id: FAMILY, title: "verify equating hook (synthetic)", difficulty_band: "hard",
      });
      if (famErr) throw new Error(`family seed: ${famErr.message}`);
      const { error: scErr } = await supabase.from("scenarios").insert([
        { id: A, slug: "verify-equating-a", title: "veq A", role: "fde", difficulty: "hard", family_id: FAMILY },
        { id: B, slug: "verify-equating-b", title: "veq B", role: "fde", difficulty: "hard", family_id: FAMILY },
      ]);
      if (scErr) throw new Error(`scenario seed: ${scErr.message}`);
      const rows = await eq.checkBandEquating(FAMILY);
      check("checkBandEquating degrades to [] without throwing (stats table missing)",
        Array.isArray(rows) && rows.length === 0);
    } catch (err) {
      fail(`graceful degradation broken: ${(err as Error).message}`);
    }
    await cleanup();
    console.log("\n" + (failures === 0 ? "SKIPPED (0020 not applied) — degradation checks passed" : `FAILED: ${failures} check(s)`));
    process.exit(failures === 0 ? 0 : 1);
  }

  await cleanup();
  try {
    await seed();
  } catch (err) {
    console.error("seed failed:", (err as Error).message);
    await cleanup();
    process.exit(1);
  }

  // Snapshot for the read-only assertion.
  const { data: before } = await supabase
    .from("competency_difficulty_stats").select("*").in("scenario_id", [A, B, EASY])
    .order("scenario_id").order("competency_key");

  // ── [1] comparisons ──
  console.log("\n[1] checkBandEquating over the seeded family");
  const rows = await eq.checkBandEquating(FAMILY);
  const byComp = new Map(rows.map((r) => [`${r.band}/${r.competency}`, r]));

  check("exactly 2 comparisons (pf + df; execution n-gated, teamwork version-gated, easy unpaired)",
    rows.length === 2, `got ${rows.length}: ${rows.map((r) => `${r.band}/${r.competency}`).join(", ")}`);

  const pf = byComp.get("hard/problem_framing");
  check("hard/problem_framing compared", !!pf);
  if (pf) {
    check("…meanA=3.5 meanB=4.0 (member order deterministic)",
      pf.meanA === 3.5 && pf.meanB === 4.0, JSON.stringify(pf));
    check("…gap=0.5, comparable:true", pf.gap === 0.5 && pf.comparable === true);
    check("…n rides along (8 / 6)", pf.nA === 8 && pf.nB === 6);
    check("…scenario pair is (A, B)", pf.scenarioA === A && pf.scenarioB === B);
    check("…versioned with DIFFICULTY_STATS_VERSION", pf.stats_version === DIFFICULTY_STATS_VERSION);
    check("…family + band echoed", pf.family === FAMILY && pf.band === "hard");
  }

  const df = byComp.get("hard/data_fluency");
  check("hard/data_fluency compared", !!df);
  if (df) {
    check("…gap=1.1, comparable:false (> 0.75)", df.gap === 1.1 && df.comparable === false, JSON.stringify(df));
  }

  // ── [2] exclusions ──
  console.log("\n[2] exclusions");
  check("execution excluded (one side n=4 < 5)", !byComp.has("hard/execution"));
  check("teamwork excluded (one side has a stale stats_version)", !byComp.has("hard/teamwork"));
  check("easy band excluded (single calibrated member)", !rows.some((r) => r.band === "easy"));

  // ── [3] read-only + unknown family ──
  console.log("\n[3] read-only + unknown family");
  const { data: after } = await supabase
    .from("competency_difficulty_stats").select("*").in("scenario_id", [A, B, EASY])
    .order("scenario_id").order("competency_key");
  check("stats rows untouched by the check (read-only hook)",
    JSON.stringify(before) === JSON.stringify(after));
  const none = await eq.checkBandEquating("verify-equating-hook-no-such-family");
  check("unknown family → []", Array.isArray(none) && none.length === 0);

  console.log("\n[cleanup]");
  await cleanup();
  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
