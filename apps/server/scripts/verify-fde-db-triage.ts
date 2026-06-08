// Three-part verifier for the fde-db-triage scenario:
//   (a) Read back the scenarios row and assert all JSONB fields are populated
//       and the 8 rubric weights sum to 1.0 (using integer hundredths to dodge
//       float drift).
//   (b) Re-run the generator and confirm the committed seed.sql /
//       ground_truth.json / schema.sql / queries.sql are byte-identical.
//   (c) Load schema.sql + seed.sql into an in-memory sqlite3, run queries.sql,
//       and assert the naive / corrected per-month sums match ground_truth.json
//       exactly. This proves the SQL files actually parse and that the
//       duplicate-payment bug is observable end-to-end.
//
// Run: pnpm exec tsx apps/server/scripts/verify-fde-db-triage.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const fixtureDir = resolve(repoRoot, "fixtures/fde-db-triage");
loadEnv({ path: resolve(repoRoot, ".env") });

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

const EXPECTED_RUBRIC_KEYS = [
  "ai_orchestration",
  "customer_engagement",
  "data_fluency",
  "design_under_constraints",
  "execution",
  "outcome_communication",
  "problem_framing",
  "teamwork",
];

interface GroundTruth {
  reference_date: string;
  reporting_window: string[];
  bug_months: string[];
  naive_monthly_cents: Record<string, number>;
  corrected_monthly_cents: Record<string, number>;
  overstatement_cents: number;
  overstatement_by_month_cents: Record<string, number>;
  duplicate_count_by_month: Record<string, number>;
  succeeded_count_by_month: Record<string, number>;
  totals: {
    payments: number;
    customers: number;
    subscriptions: number;
    base_payments: number;
    duplicate_payments: number;
  };
}

let failures = 0;
function fail(msg: string): void {
  failures += 1;
  console.error("  FAIL:", msg);
}
function pass(msg: string): void {
  console.log("  PASS:", msg);
}

function fmtUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ─── (a) Live DB row read-back ──────────────────────────────────────────────
async function verifyScenarioRow(): Promise<void> {
  console.log("\n[a] DB row read-back ─────────────────────────────────────");
  const { data, error } = await supabase
    .from("scenarios")
    .select(
      "slug, difficulty, dataset_ref, brief, client_persona, team_persona, " +
        "constraints, curveballs, deliverable_spec, rubric, success_criteria",
    )
    .eq("slug", "fde-db-triage")
    .maybeSingle();

  if (error) {
    fail(`select failed: ${error.message}`);
    return;
  }
  if (!data) {
    fail("no row with slug='fde-db-triage'");
    return;
  }

  if (data.difficulty === "mid") pass("difficulty = 'mid'");
  else fail(`difficulty = ${JSON.stringify(data.difficulty)} (expected 'mid')`);

  if (data.dataset_ref === "fixtures/fde-db-triage")
    pass(`dataset_ref = '${data.dataset_ref}'`);
  else
    fail(`dataset_ref = ${JSON.stringify(data.dataset_ref)} (expected 'fixtures/fde-db-triage')`);

  if (typeof data.brief === "string" && data.brief.length > 200)
    pass(`brief populated (${data.brief.length} chars)`);
  else fail(`brief too short or missing (${(data.brief ?? "").length} chars)`);

  const cp = data.client_persona as { beats?: unknown[] } | null;
  if (cp && Array.isArray(cp.beats) && cp.beats.length >= 3)
    pass(`client_persona has ${cp.beats.length} beats`);
  else fail("client_persona missing or has too few beats");

  const tp = data.team_persona as { beats?: unknown[] } | null;
  if (tp && Array.isArray(tp.beats) && tp.beats.length >= 2)
    pass(`team_persona has ${tp.beats.length} beats`);
  else fail("team_persona missing or has too few beats");

  const cb = data.curveballs as unknown[];
  if (Array.isArray(cb) && cb.length === 2)
    pass(`curveballs has ${cb.length} entries`);
  else fail(`curveballs.length = ${Array.isArray(cb) ? cb.length : "n/a"} (expected 2)`);

  const ds = data.deliverable_spec as { components?: unknown[] } | null;
  if (ds && Array.isArray(ds.components) && ds.components.length === 4)
    pass(`deliverable_spec has ${ds.components.length} components`);
  else fail("deliverable_spec missing or has wrong component count");

  const sc = data.success_criteria as { must?: unknown[]; tolerance?: unknown } | null;
  if (sc && Array.isArray(sc.must) && sc.must.length >= 1)
    pass(`success_criteria has ${sc.must.length} 'must' items`);
  else fail("success_criteria missing 'must' items");

  const cons = data.constraints as Record<string, number>;
  const consKeys = Object.keys(cons ?? {}).sort();
  const wantConsKeys = ["compute_minutes", "memory_mb", "money_usd", "time_minutes", "tokens"];
  if (JSON.stringify(consKeys) === JSON.stringify(wantConsKeys))
    pass(`constraints keys = ${consKeys.join(", ")}`);
  else fail(`constraints keys = ${consKeys.join(", ")} (expected ${wantConsKeys.join(", ")})`);

  const rubric = data.rubric as Record<string, { weight: number }>;
  const rubricKeys = Object.keys(rubric ?? {}).sort();
  if (JSON.stringify(rubricKeys) === JSON.stringify(EXPECTED_RUBRIC_KEYS))
    pass(`rubric keys match the 8-competency spec exactly`);
  else
    fail(`rubric keys = [${rubricKeys.join(", ")}], expected [${EXPECTED_RUBRIC_KEYS.join(", ")}]`);

  const weightCents = Object.values(rubric ?? {}).reduce(
    (sum, r) => sum + Math.round((r?.weight ?? 0) * 100),
    0,
  );
  if (weightCents === 100)
    pass(`rubric weights sum to 1.00 (int cents = ${weightCents})`);
  else fail(`rubric weights sum int-cents = ${weightCents}, expected 100`);
}

// ─── (b) Generator determinism ─────────────────────────────────────────────
function verifyDeterminism(): {
  hashes: Record<string, string>;
  ground: GroundTruth;
} {
  console.log("\n[b] Generator determinism ────────────────────────────────");
  const targets = ["schema.sql", "seed.sql", "ground_truth.json", "queries.sql"];

  for (const f of targets) {
    if (!existsSync(resolve(fixtureDir, f))) {
      fail(`${f} missing — run generator first`);
    }
  }

  const before: Record<string, string> = {};
  for (const f of targets) before[f] = sha256File(resolve(fixtureDir, f));

  console.log("  regenerating…");
  execFileSync(
    "pnpm",
    ["--filter", "@crucible/server", "exec", "tsx", "../../fixtures/fde-db-triage/generate.ts"],
    { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] },
  );

  const after: Record<string, string> = {};
  for (const f of targets) after[f] = sha256File(resolve(fixtureDir, f));

  let allEqual = true;
  for (const f of targets) {
    if (before[f] === after[f]) {
      console.log(`  PASS: ${f}  ${after[f]!.slice(0, 16)}…`);
    } else {
      allEqual = false;
      fail(`${f} differs after regen — ${before[f]!.slice(0, 16)} → ${after[f]!.slice(0, 16)}`);
    }
  }
  if (allEqual) pass("all 4 fixture files byte-identical across two generator runs");

  const ground = JSON.parse(
    readFileSync(resolve(fixtureDir, "ground_truth.json"), "utf8"),
  ) as GroundTruth;
  return { hashes: after, ground };
}

// ─── (c) sqlite3 query proof ───────────────────────────────────────────────
function verifySqlQueries(ground: GroundTruth): void {
  console.log("\n[c] sqlite3 query proof ──────────────────────────────────");

  const schema = readFileSync(resolve(fixtureDir, "schema.sql"), "utf8");
  const seed = readFileSync(resolve(fixtureDir, "seed.sql"), "utf8");
  const queries = readFileSync(resolve(fixtureDir, "queries.sql"), "utf8");

  const out = execFileSync("sqlite3", [":memory:", "-cmd", ".mode tabs"], {
    input: schema + "\n" + seed + "\n" + queries,
    encoding: "utf8",
  });

  const naive: Record<string, number> = {};
  const corrected: Record<string, number> = {};
  let duplicateProofRows = 0;

  for (const line of out.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 2) continue;
    if (cols[0] === "naive" && cols[1]) naive[cols[1]] = Number(cols[2]);
    else if (cols[0] === "corrected" && cols[1]) corrected[cols[1]] = Number(cols[2]);
    else if (cols[0] === "duplicates") duplicateProofRows += 1;
  }

  console.log("  sqlite3 query output:");
  for (const m of ground.reporting_window) {
    const n = naive[m] ?? 0;
    const c = corrected[m] ?? 0;
    const diff = n - c;
    console.log(
      `    ${m}:  naive=${fmtUsd(n).padStart(15)}   corrected=${fmtUsd(c).padStart(15)}   diff=${fmtUsd(diff).padStart(13)}`,
    );
  }
  console.log(
    `    total overstatement: ${fmtUsd(ground.overstatement_cents)} across ${ground.bug_months.join(" + ")}`,
  );
  console.log(`    duplicate fingerprint rows surfaced by HAVING COUNT(*)>1: ${duplicateProofRows}`);

  for (const m of ground.reporting_window) {
    if ((naive[m] ?? -1) === ground.naive_monthly_cents[m])
      pass(`naive ${m}: sqlite ${fmtUsd(naive[m]!)} matches ground_truth ${fmtUsd(ground.naive_monthly_cents[m]!)}`);
    else
      fail(`naive ${m}: sqlite ${fmtUsd(naive[m] ?? 0)} != ground_truth ${fmtUsd(ground.naive_monthly_cents[m] ?? 0)}`);

    if ((corrected[m] ?? -1) === ground.corrected_monthly_cents[m])
      pass(`corrected ${m}: sqlite ${fmtUsd(corrected[m]!)} matches ground_truth ${fmtUsd(ground.corrected_monthly_cents[m]!)}`);
    else
      fail(`corrected ${m}: sqlite ${fmtUsd(corrected[m] ?? 0)} != ground_truth ${fmtUsd(ground.corrected_monthly_cents[m] ?? 0)}`);
  }

  if (duplicateProofRows > 0)
    pass(`SQL fingerprint query found ${duplicateProofRows} duplicate external_payment_id groups`);
  else
    fail("SQL fingerprint query found 0 duplicate groups — bug not observable");
}

// ─── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("verify-fde-db-triage");
  await verifyScenarioRow();
  const { ground } = verifyDeterminism();
  verifySqlQueries(ground);

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
