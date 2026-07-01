/**
 * verify-scorability.ts — RD3 (Slice 6.4) acceptance.
 *
 * Deterministic (no infra): exercises the pure computeScorability() decision
 * table in src/services/scorability.ts. Covers the spec acceptance cases —
 * orphaned/error → excluded_infra; <10-min quit → excluded_abandoned; clean
 * strong run → scorable=true — plus every reason code and the precedence order.
 *
 * Exit 0 on PASS, non-zero on FAIL.
 */
import {
  computeScorability,
  SCORABILITY_THRESHOLDS as T,
  type ScorabilityInput,
} from "../src/services/scorability.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

// A clean, strong, scorable baseline; each case overrides one axis.
function base(): ScorabilityInput {
  return {
    endReason: "manual",
    deliverableNonEmpty: true,
    activeDurationMin: 25,
    meaningfulEventCount: 30,
    loadBearingAssessedCount: 5,
    defenseOutcome: "coherent",
  };
}
function withInput(over: Partial<ScorabilityInput>): ScorabilityInput {
  return { ...base(), ...over };
}

console.log("verify-scorability — RD3 (Slice 6.4)");
console.log(
  `thresholds: ${T.minActiveMinutes}min / ${T.minMeaningfulEvents} events / ${T.minLoadBearingAssessed} load-bearing\n`,
);

// ── scorable baseline ──
{
  const r = computeScorability(base());
  check("clean strong run → scorable, no reason", r.scorable && r.exclusionReason === null);
}

// ── excluded_infra: dirty terminals ──
for (const er of ["error", "budget", "orphaned", null]) {
  const r = computeScorability(withInput({ endReason: er }));
  check(
    `end_reason=${String(er)} → excluded_infra`,
    !r.scorable && r.exclusionReason === "excluded_infra",
    r.exclusionReason ?? "scorable",
  );
}
// clean terminals pass the infra gate
for (const er of ["manual", "timeout"]) {
  const r = computeScorability(withInput({ endReason: er }));
  check(`end_reason=${er} → passes infra gate (scorable)`, r.scorable);
}

// ── excluded_abandoned: low engagement (both time AND events under floor) ──
{
  const r = computeScorability(withInput({ activeDurationMin: 3, meaningfulEventCount: 2 }));
  check("3-min, 2-event quit → excluded_abandoned", !r.scorable && r.exclusionReason === "excluded_abandoned");
}
// engagement satisfied by EITHER floor
{
  const byTime = computeScorability(withInput({ activeDurationMin: 12, meaningfulEventCount: 1 }));
  check("12-min but few events → still scorable (time floor)", byTime.scorable);
  const byEvents = computeScorability(withInput({ activeDurationMin: 2, meaningfulEventCount: 20 }));
  check("2-min but many events → still scorable (event floor)", byEvents.scorable);
}
// abandoned takes precedence over an empty deliverable (a quick quit is abandoned, not no-deliverable)
{
  const r = computeScorability(withInput({ activeDurationMin: 2, meaningfulEventCount: 1, deliverableNonEmpty: false }));
  check("quit + empty deliverable → excluded_abandoned (precedence)", r.exclusionReason === "excluded_abandoned");
}

// ── excluded_no_deliverable: engaged but submitted nothing ──
{
  const r = computeScorability(withInput({ deliverableNonEmpty: false }));
  check("engaged + empty deliverable → excluded_no_deliverable", !r.scorable && r.exclusionReason === "excluded_no_deliverable");
}

// ── excluded_defense_unreachable: RD2 not_reached ──
{
  const r = computeScorability(withInput({ defenseOutcome: "not_reached" }));
  check("defense not_reached → excluded_defense_unreachable", !r.scorable && r.exclusionReason === "excluded_defense_unreachable");
}
// verification never fired (null) is NOT a gate
{
  const r = computeScorability(withInput({ defenseOutcome: null }));
  check("defense null (never fired) → not a gate (scorable)", r.scorable);
}
// weak/coherent/declined defenses don't fail scorability here (RD2 handles caps)
for (const o of ["weak", "coherent", "declined"]) {
  const r = computeScorability(withInput({ defenseOutcome: o }));
  check(`defense=${o} → scorable (cap is RD2's job, not exclusion)`, r.scorable);
}

// ── excluded_insufficient_evidence: too few load-bearing competencies ──
{
  const r = computeScorability(withInput({ loadBearingAssessedCount: 2 }));
  check("2 load-bearing competencies → excluded_insufficient_evidence", !r.scorable && r.exclusionReason === "excluded_insufficient_evidence");
  const ok = computeScorability(withInput({ loadBearingAssessedCount: T.minLoadBearingAssessed }));
  check(`exactly ${T.minLoadBearingAssessed} load-bearing → scorable`, ok.scorable);
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed} check(s))`}`);
process.exit(failed === 0 ? 0 : 1);
