// Acceptance verifier for Slice 5.5 — L6 outcome capture.
//
// Fully deterministic, no server + no LLM: it seeds synthetic sessions +
// completed evaluations (overall scores 1..5, with an execution item score to
// match), inserts outcomes correlated to those scores, then exercises the REAL
// services/outcomes code path:
//   - insertOutcome backfills scenario_id from the linked session,
//   - correlateOutcomes joins outcomes → sessions → evaluations and returns a
//     sane Pearson r against both overall_score and a named competency.
//
// Assumes the outcomes table is dedicated to assessment data (the only writers
// are this slice's paths). It cleans up its own rows (candidate_ref prefix
// 'vo-') and synthetic sessions at start AND end, so re-runs are isolated.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-outcomes.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF
    ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`
    : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// dotenv is loaded — safe to pull in the service (→ services/supabase reads env).
const { correlateOutcomes, insertOutcome, OutcomeInputSchema } = await import(
  "../src/services/outcomes.js"
);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
function fail(msg: string): void { failures += 1; console.error("  FAIL:", msg); }
function pass(msg: string): void { console.log("  PASS:", msg); }
function near(actual: number | null, target: number, tol: number, why: string): void {
  if (actual !== null && Math.abs(actual - target) <= tol) pass(`${why} (r=${actual})`);
  else fail(`${why} — expected ~${target}±${tol}, got ${actual}`);
}

const CAND_PREFIX = "vo-";
const SANDBOX_MARK = "verify-outcomes-synthetic";
const N = 5; // synthetic sessions with overall scores 1..5

// Deterministic uuids for the synthetic sessions so cleanup is exact.
const sessionIds = Array.from({ length: N }, (_, i) =>
  `00000000-0000-4000-8000-0000000000${(i + 10).toString().padStart(2, "0")}`,
);

async function cleanup(): Promise<void> {
  // Delete outcomes first (FK SET NULL won't remove them), then evaluations
  // (cascades items), then sessions.
  await supabase.from("outcomes").delete().like("candidate_ref", `${CAND_PREFIX}%`);
  await supabase.from("evaluations").delete().in("session_id", sessionIds);
  await supabase.from("sessions").delete().in("id", sessionIds);
}

(async () => {
  console.log("verify-outcomes");

  const { data: scenarioRow, error: scenErr } = await supabase
    .from("scenarios").select("id").eq("slug", "fde-db-triage").single();
  if (scenErr || !scenarioRow) {
    console.error("scenario lookup failed:", scenErr?.message);
    process.exit(1);
  }
  const scenarioId = scenarioRow.id as string;

  console.log("\n[setup] cleaning any prior synthetic rows…");
  await cleanup();

  // ── Seed synthetic sessions + completed evaluations ─────────────────────
  console.log("[setup] seeding synthetic sessions + evaluations…");
  const deadline = "2030-01-01T00:00:00.000Z";
  for (let i = 0; i < N; i++) {
    const overall = i + 1; // 1..5
    const sid = sessionIds[i]!;
    const { error: sErr } = await supabase.from("sessions").insert({
      id: sid,
      status: "completed",
      sandbox_id: `${SANDBOX_MARK}-${i}`,
      template: "crucible-dev",
      litellm_key_alias: `vo-${i}`,
      model: "gemini-flash",
      budget_usd: 1.0,
      timeout_min: 60,
      deadline,
      scenario_id: scenarioId,
    });
    if (sErr) { fail(`session insert ${i}: ${sErr.message}`); continue; }

    const { data: evalRow, error: eErr } = await supabase.from("evaluations").insert({
      session_id: sid,
      scenario_id: scenarioId,
      overall_score: overall,
      summary: "synthetic",
      model: "gemini-flash",
      status: "complete",
    }).select("id").single();
    if (eErr || !evalRow) { fail(`evaluation insert ${i}: ${eErr?.message}`); continue; }

    const { error: iErr } = await supabase.from("evaluation_items").insert({
      evaluation_id: (evalRow as { id: string }).id,
      competency: "execution",
      score: overall, // execution item mirrors overall for the competency test
      weight: 0.2,
      rationale: "synthetic",
    });
    if (iErr) fail(`evaluation_item insert ${i}: ${iErr.message}`);
  }

  // ── [a] insertOutcome links + backfills scenario_id ─────────────────────
  console.log("\n[a] insertOutcome — link + scenario backfill");
  for (let i = 0; i < N; i++) {
    const overall = i + 1;
    const sid = sessionIds[i]!;
    // manager_rating mirrors overall (→ r≈+1); ramp_weeks is inverse (→ r≈-1);
    // hired is overall>=3 (→ positive). scenario_id intentionally omitted to
    // exercise backfill from the session.
    const mr = await insertOutcome(
      { candidate_ref: `${CAND_PREFIX}${i}`, session_id: sid, outcome_type: "manager_rating_90d", value: overall },
      "manual",
    );
    if (i === 0) {
      if (mr.scenario_id === scenarioId) pass("scenario_id backfilled from session");
      else fail(`scenario_id backfill = ${mr.scenario_id}, expected ${scenarioId}`);
      if (mr.session_id === sid) pass("outcome linked to session_id");
      else fail(`session_id = ${mr.session_id}, expected ${sid}`);
    }
    await insertOutcome(
      { candidate_ref: `${CAND_PREFIX}${i}`, session_id: sid, outcome_type: "ramp_weeks", value: 12 - 2 * overall },
      "manual",
    );
    await insertOutcome(
      { candidate_ref: `${CAND_PREFIX}${i}`, session_id: sid, outcome_type: "hired", value: overall >= 3 },
      "manual",
    );
  }
  pass(`inserted ${N * 3} outcomes across ${N} sessions`);

  // ── [b] Zod boundary rejects malformed values ───────────────────────────
  // insertOutcome trusts validated input; validation is the route/CSV boundary
  // (OutcomeInputSchema). Assert the schema rejects bad values — no insert, so
  // the correlation dataset below stays clean.
  console.log("\n[b] schema validation at the boundary");
  const badRating = OutcomeInputSchema.safeParse({
    candidate_ref: "vo-bad", outcome_type: "manager_rating_90d", value: 9, // must be 1-5
  });
  if (!badRating.success) pass("out-of-range manager_rating_90d rejected by schema");
  else fail("out-of-range manager_rating_90d accepted by schema");

  const badBool = OutcomeInputSchema.safeParse({
    candidate_ref: "vo-bad", outcome_type: "hired", value: 3, // must be boolean
  });
  if (!badBool.success) pass("non-boolean hired rejected by schema");
  else fail("non-boolean hired accepted by schema");

  const goodOne = OutcomeInputSchema.safeParse({
    candidate_ref: "vo-ok", outcome_type: "ramp_weeks", value: 6,
  });
  if (goodOne.success) pass("valid outcome accepted by schema");
  else fail(`valid outcome rejected: ${JSON.stringify(goodOne.error.flatten().fieldErrors)}`);

  // ── [c] correlation runs end-to-end ─────────────────────────────────────
  console.log("\n[c] correlateOutcomes (outcome ↔ overall / competency)");
  const mrCorr = await correlateOutcomes("manager_rating_90d");
  if (mrCorr.n === N) pass(`manager_rating_90d: n=${N} pairs linked`);
  else fail(`manager_rating_90d: n=${mrCorr.n}, expected ${N}`);
  near(mrCorr.pearson_r, 1, 0.05, "manager_rating_90d ↔ overall is strongly positive");

  const rampCorr = await correlateOutcomes("ramp_weeks");
  near(rampCorr.pearson_r, -1, 0.05, "ramp_weeks ↔ overall is strongly negative");

  const hiredCorr = await correlateOutcomes("hired");
  if (hiredCorr.pearson_r !== null && hiredCorr.pearson_r > 0)
    pass(`hired ↔ overall is positive (r=${hiredCorr.pearson_r})`);
  else fail(`hired ↔ overall expected positive, got ${hiredCorr.pearson_r}`);

  const compCorr = await correlateOutcomes("manager_rating_90d", "execution");
  if (compCorr.n === N) pass(`competency correlation linked n=${N}`);
  else fail(`competency correlation n=${compCorr.n}, expected ${N}`);
  near(compCorr.pearson_r, 1, 0.05, "manager_rating_90d ↔ execution is strongly positive");

  // pairs trace back to our synthetic sessions
  const allOurs = mrCorr.pairs.every((p) => sessionIds.includes(p.session_id));
  if (allOurs) pass("all correlation pairs link to seeded sessions");
  else fail("a correlation pair references an unexpected session");

  console.log("\n[cleanup] removing synthetic rows…");
  await cleanup();

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
