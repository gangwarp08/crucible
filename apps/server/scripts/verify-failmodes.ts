/**
 * verify-failmodes.ts — H6 (Slice 6.8d) acceptance.
 *
 * Fail clean + fail attributable. Deterministic invariants over the shared
 * decision logic that the live teardown paths apply:
 *   - an orphan / budget / error terminal → excluded_infra (charged to us,
 *     never a silent zero against the candidate) — the same rule finalizeSession
 *     (db.ts) stamps up-front and computeScorability re-derives;
 *   - a verifier timeout during defense → not_reached, NEVER a cap (RD2);
 *   - clean terminals (manual / timeout) are NOT auto-excluded — scorability
 *     judges them from the full signal.
 *
 * Exit 0 on PASS, non-zero on FAIL.
 */
import { computeScorability, type ScorabilityInput } from "../src/services/scorability.js";
import { computeDefenseOutcome, capStatusFor } from "../src/services/defense.js";
import type { CondensedVerification } from "../src/services/analysis-input.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

// A clean, engaged, well-evidenced baseline; each case overrides end_reason.
function scInput(over: Partial<ScorabilityInput>): ScorabilityInput {
  return {
    endReason: "manual",
    deliverableNonEmpty: true,
    activeDurationMin: 25,
    meaningfulEventCount: 30,
    loadBearingAssessedCount: 5,
    defenseOutcome: "coherent",
    ...over,
  };
}

console.log("verify-failmodes — H6 (Slice 6.8d)\n");

// ── dirty terminals → excluded_infra (fail attributable to us) ──
for (const er of ["orphaned", "budget", "error", null]) {
  const r = computeScorability(scInput({ endReason: er }));
  check(
    `end_reason=${String(er)} → excluded_infra (not scored against candidate)`,
    !r.scorable && r.exclusionReason === "excluded_infra",
    r.exclusionReason ?? "scorable",
  );
}

// ── clean terminals are NOT auto-excluded (scorability judges the full run) ──
for (const er of ["manual", "timeout"]) {
  const r = computeScorability(scInput({ endReason: er }));
  check(`end_reason=${er} → NOT auto-excluded (scorable)`, r.scorable && r.exclusionReason === null);
}

// ── verifier timeout during defense → not_reached, never a cap ──
{
  // prompted but the candidate never answered (model/UI/deadline) = timeout.
  const timedOut: CondensedVerification = {
    prompted: true,
    turns: [{ seq: 1, role: "verifier", text: "Defend your dedup choice?" }],
  };
  const outcome = computeDefenseOutcome(timedOut);
  check("verifier timeout (prompted, 0 answers) → not_reached", outcome === "not_reached");
  check("not_reached → cap status none (NEVER a cap)", capStatusFor(outcome, true) === "none");
  check("not_reached → cap status none even in auto mode", capStatusFor(outcome, false) === "none");
}

// ── a not_reached defense also feeds RD3: defense-unreachable exclusion, not a
//    penalty — a session whose defense never reached the candidate is excluded,
//    not scored low. ──
{
  const r = computeScorability(scInput({ defenseOutcome: "not_reached" }));
  check("not_reached defense → excluded_defense_unreachable (not a low score)", r.exclusionReason === "excluded_defense_unreachable");
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed} check(s))`}`);
process.exit(failed === 0 ? 0 : 1);
