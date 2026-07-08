// verify-family2-isomorph.ts — P3.4 acceptance (isomorph equivalence for the
// DORMANT second family, fde-api-integration).
//
// Runs the SAME hand-authored STRONG playthrough against the two matched
// mid-band isomorphs (fde-api-integration and fde-api-integration-iso — same
// family, same band, same radical structure incl. the native product-sense
// fork, different incidental values) and checks the resulting scores are
// COMPARABLE. Mirrors verify-isomorph-equivalence.ts (family 1): the only
// per-scenario difference in the playthrough is the record counts in the
// deliverable, read from each scenario's own ground_truth.json. Both runs
// face the fork and both DECLINE the hardcode (held identical), so the fork
// radical is exercised on both forms.
//
// Single strong sample per isomorph (an LLM-eval proxy, not a distribution):
// asserts both land in the strong band and the overall + per-competency gaps
// are small.
//
// SKIPS (exit 0 + message) when env/infra/seed is unavailable, or with
// --dry-run — which prints the complete authored playthrough for review.
// Content lives in scripts/family2-content.ts.
//
// Run:      pnpm --filter @crucible/server exec tsx scripts/verify-family2-isomorph.ts
// Dry run:  pnpm --filter @crucible/server exec tsx scripts/verify-family2-isomorph.ts --dry-run

import { FAMILY2 } from "./family2-content.js";
import {
  guard, isDryRun, skip, sleep,
  describePlaythrough, runPlaythrough, pollEval,
} from "./family2-harness.js";

const COOLDOWN_MS = Number(process.env.FAMILY2_COOLDOWN_MS ?? "60000");

// Equivalence tolerances — same single-sample proxy bars as family 1
// (verify-isomorph-equivalence.ts).
const STRONG_FLOOR = 3.0;      // both matched strong runs clear this overall
const MAX_OVERALL_GAP = 1.0;   // |overall_base − overall_iso|
const MAX_COMPETENCY_GAP = 2;  // per-competency score gap ceiling

let failures = 0;
const fail = (m: string): void => { failures++; console.error("  FAIL:", m); };
const pass = (m: string): void => console.log("  PASS:", m);

(async () => {
  console.log("verify-family2-isomorph — P3.4 (matched strong runs on both mid-band forms)");

  if (isDryRun()) {
    const placeholder = {
      provider_record_count: 12_000, synced_record_count: 11_640,
      missing_record_count: 360, edge_case_record_count: 360,
      root_cause: "cursor_pagination_contract_drift",
    };
    describePlaythrough("strong", placeholder);
    console.log("\n[the identical playthrough runs on BOTH isomorphs; deliverable counts come from each scenario's own ground_truth.json]");
    skip("--dry-run: playthrough content printed, no infra touched");
  }

  const { supabase, scenarios, groundTruths } = await guard([
    FAMILY2.canonicalSlug,
    FAMILY2.isoSlug,
  ]);
  const base = scenarios.get(FAMILY2.canonicalSlug)!;
  const iso = scenarios.get(FAMILY2.isoSlug)!;
  const baseGt = groundTruths.get(FAMILY2.canonicalSlug)!;
  const isoGt = groundTruths.get(FAMILY2.isoSlug)!;

  // ── [a] Pairing: same family, same band, isomorph_of wired, incidentals differ ──
  console.log("\n[a] family pairing");
  if (base.family_id === FAMILY2.familyId && iso.family_id === FAMILY2.familyId)
    pass(`same family (${FAMILY2.familyId})`);
  else fail(`family mismatch: base=${base.family_id} iso=${iso.family_id}`);
  if (base.difficulty === iso.difficulty) pass(`same band (${base.difficulty})`);
  else fail(`band mismatch: base=${base.difficulty} iso=${iso.difficulty}`);
  if (iso.isomorph_of === FAMILY2.canonicalSlug) pass(`iso.isomorph_of → ${FAMILY2.canonicalSlug}`);
  else fail(`iso.isomorph_of = ${iso.isomorph_of}`);
  if (
    baseGt.provider_record_count !== isoGt.provider_record_count ||
    baseGt.missing_record_count !== isoGt.missing_record_count
  ) pass("isomorph has different incidental counts (not a copy)");
  else fail("isomorph ground truth identical to base — incidentals must differ");
  if (baseGt.root_cause === isoGt.root_cause) pass(`same radical root cause (${baseGt.root_cause})`);
  else fail(`radical drift: base root_cause=${baseGt.root_cause} iso=${isoGt.root_cause}`);

  if (failures > 0) {
    console.error("\nFAILED: pairing checks failed — not spending LLM runs on a broken pair");
    process.exit(1);
  }

  // ── [b] Matched strong playthroughs ────────────────────────────────────────
  if (COOLDOWN_MS > 0) { console.log(`\n[setup] cooling ${COOLDOWN_MS / 1000}s for the LLM rate-limit window…`); await sleep(COOLDOWN_MS); }
  console.log(`\n[1/2] strong playthrough — ${FAMILY2.canonicalSlug}`);
  const baseSession = await runPlaythrough("strong", base, baseGt);

  if (COOLDOWN_MS > 0) { console.log(`\n[interlude] cooling ${COOLDOWN_MS / 1000}s…`); await sleep(COOLDOWN_MS); }
  console.log(`\n[2/2] strong playthrough — ${FAMILY2.isoSlug}`);
  const isoSession = await runPlaythrough("strong", iso, isoGt);

  console.log("\n[poll] evaluations…");
  const baseEval = await pollEval(supabase, baseSession, 120_000);
  const isoEval = await pollEval(supabase, isoSession, 120_000);

  // ── [c] Equivalence ────────────────────────────────────────────────────────
  console.log("\n[c] equivalence");
  if (!baseEval || !isoEval) {
    fail(`evals not both complete (base=${baseEval ? "complete" : "missing"}, iso=${isoEval ? "complete" : "missing"})`);
  } else {
    console.log(`  overall: base=${baseEval.overall_score.toFixed(2)}  iso=${isoEval.overall_score.toFixed(2)}`);
    if (baseEval.overall_score >= STRONG_FLOOR && isoEval.overall_score >= STRONG_FLOOR)
      pass(`both strong runs clear the floor (≥ ${STRONG_FLOOR})`);
    else fail(`a strong run fell below ${STRONG_FLOOR}: base=${baseEval.overall_score}, iso=${isoEval.overall_score}`);

    const gap = Math.abs(baseEval.overall_score - isoEval.overall_score);
    if (gap <= MAX_OVERALL_GAP) pass(`overall gap ${gap.toFixed(2)} ≤ ${MAX_OVERALL_GAP} (comparable)`);
    else fail(`overall gap ${gap.toFixed(2)} > ${MAX_OVERALL_GAP} — isomorphs not comparable`);

    const isoBy = new Map(isoEval.items.map((i) => [i.competency, i.score]));
    let worst = 0; let worstKey = "";
    for (const it of baseEval.items) {
      const o = isoBy.get(it.competency);
      // not_assessed on either side can't be compared (RD4).
      if (o === undefined || o === null || it.score === null) continue;
      const d = Math.abs(it.score - o);
      if (d > worst) { worst = d; worstKey = it.competency; }
    }
    console.log(`  largest per-competency gap: ${worstKey || "(none)"} Δ=${worst}`);
    if (worst <= MAX_COMPETENCY_GAP) pass(`largest competency gap ${worst} ≤ ${MAX_COMPETENCY_GAP}`);
    else fail(`competency ${worstKey} gap ${worst} > ${MAX_COMPETENCY_GAP}`);

    // The fork radical held identical (both declined) → the product-sense
    // competency should NOT be the divergence point between forms.
    const basePs = baseEval.items.find((i) => i.competency === FAMILY2.productSenseCompetency)?.score ?? null;
    const isoPs = isoBy.get(FAMILY2.productSenseCompetency) ?? null;
    if (basePs !== null && isoPs !== null && Math.abs(basePs - isoPs) <= 1)
      pass(`${FAMILY2.productSenseCompetency} stable across forms (base=${basePs}, iso=${isoPs}) — fork radical equivalent`);
    else fail(`${FAMILY2.productSenseCompetency} diverges across forms (base=${basePs}, iso=${isoPs}) — fork radical not equivalent`);
  }

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
