/**
 * verify-typing-drift.ts — verification slice (detector v5) acceptance.
 *
 * Deterministic, infra-light: exercises the pure drift decision core in
 * src/services/typing-drift.ts (observeWindow over synthetic window series).
 *
 * Acceptance:
 *   - no baseline → never fires (first BASELINE_WINDOWS qualifying windows);
 *   - stable rhythm → never fires;
 *   - handoff step change (sustained new mean IKI) → fires EXACTLY once;
 *   - return to baseline re-arms → a second handoff fires again;
 *   - single-window blip (< DRIFT_CONSECUTIVE) → never fires;
 *   - thin windows (n < MIN_WINDOW_KEYS) are ignored entirely.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-typing-drift.ts
 */
import {
  observeWindow,
  newDriftState,
  BASELINE_WINDOWS,
  MIN_WINDOW_KEYS,
  DRIFT_CONSECUTIVE,
} from "../src/services/typing-drift.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

function run(series: Array<{ n: number; mean_iki_ms: number }>): number[] {
  const state = newDriftState();
  const fires: number[] = [];
  series.forEach((w, i) => {
    if (observeWindow(state, w)) fires.push(i);
  });
  return fires;
}

const W = (mean: number, n = 120) => ({ n, mean_iki_ms: mean });

console.log("verify-typing-drift — verification slice (detector v5)");
console.log(
  `baseline=${BASELINE_WINDOWS} windows, min keys=${MIN_WINDOW_KEYS}, consecutive=${DRIFT_CONSECUTIVE}\n`,
);

// [a] stable rhythm — never fires
{
  console.log("[a] stable rhythm");
  const fires = run(Array.from({ length: 20 }, () => W(180)));
  check("no drift on a stable session", fires.length === 0, `fires=${fires.join(",")}`);
}

// [b] baseline phase — never fires even on wild values
{
  console.log("\n[b] baseline phase");
  const fires = run([W(100), W(400), W(100), W(400), W(100)]); // exactly BASELINE_WINDOWS
  check("nothing fires while the baseline is forming", fires.length === 0);
}

// [c] handoff — sustained step change fires exactly once
{
  console.log("\n[c] proxy handoff (step change)");
  const series = [
    ...Array.from({ length: BASELINE_WINDOWS }, () => W(180)), // baseline = 180
    ...Array.from({ length: 10 }, () => W(330)),               // new typist (>35% off)
  ];
  const fires = run(series);
  check("fires exactly once", fires.length === 1, `fires=${fires.join(",")}`);
  check(
    `fires on the ${DRIFT_CONSECUTIVE}th drifted window`,
    fires[0] === BASELINE_WINDOWS + DRIFT_CONSECUTIVE - 1,
    `fired at window ${fires[0]}`,
  );
}

// [d] re-arm — return to baseline then a second handoff fires again
{
  console.log("\n[d] re-arm after recovery");
  const series = [
    ...Array.from({ length: BASELINE_WINDOWS }, () => W(180)),
    W(330), W(330), W(330),       // handoff 1 → fires once
    W(180), W(180),               // original typist back → re-arm
    W(90), W(90), W(90),          // handoff 2 (fast typist) → fires again
  ];
  const fires = run(series);
  check("fires twice across two handoffs", fires.length === 2, `fires=${fires.join(",")}`);
}

// [e] single-window blip — never fires
{
  console.log("\n[e] blip tolerance");
  const series = [
    ...Array.from({ length: BASELINE_WINDOWS }, () => W(180)),
    W(330),         // one drifted window (< DRIFT_CONSECUTIVE)
    ...Array.from({ length: 5 }, () => W(180)),
  ];
  const fires = run(series);
  check("one-window blip does not fire", fires.length === 0, `fires=${fires.join(",")}`);
}

// [f] thin windows ignored
{
  console.log("\n[f] thin windows");
  const series = [
    ...Array.from({ length: BASELINE_WINDOWS }, () => W(180)),
    W(330, MIN_WINDOW_KEYS - 1), // thin — ignored, not a drift streak member
    W(330, MIN_WINDOW_KEYS - 1),
    W(330, MIN_WINDOW_KEYS - 1),
  ];
  const fires = run(series);
  check("thin windows never fire", fires.length === 0, `fires=${fires.join(",")}`);

  // And thin windows don't poison the baseline: only qualifying windows count.
  const series2 = [
    W(999, 5), // thin — must not enter baseline
    ...Array.from({ length: BASELINE_WINDOWS }, () => W(180)),
    W(330), W(330),
  ];
  const fires2 = run(series2);
  check("thin windows excluded from baseline", fires2.length === 1, `fires=${fires2.join(",")}`);
}

// [g] relative band scales with slow typists
{
  console.log("\n[g] relative band");
  // baseline 400ms → band = max(40, 140) = 140; 500ms is inside, no fire.
  const inside = run([
    ...Array.from({ length: BASELINE_WINDOWS }, () => W(400)),
    W(500), W(500), W(500),
  ]);
  check("within relative band → no fire", inside.length === 0, `fires=${inside.join(",")}`);
  // 560ms is outside (delta 160 > 140) → fires.
  const outside = run([
    ...Array.from({ length: BASELINE_WINDOWS }, () => W(400)),
    W(560), W(560),
  ]);
  check("outside relative band → fires", outside.length === 1, `fires=${outside.join(",")}`);
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
