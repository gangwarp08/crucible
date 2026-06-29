// Acceptance verifier for Slice 5.7 — fairness/DIF SEAM (deterministic, no LLM).
//
// The DIF estimator is stubbed until v2 (needs a subgroup attribute + volume).
// What 5.7 ships is the GATE: DIF must only activate once every compared
// subgroup clears min_n, and must explicitly report "insufficient" otherwise
// rather than emit a noisy estimate. This verifies that gate.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-fairness.ts
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const { difGate, DEFAULT_MIN_SUBGROUP_N } = await import("../src/services/fairness.js");

let failures = 0;
function fail(msg: string): void { failures += 1; console.error("  FAIL:", msg); }
function pass(msg: string): void { console.log("  PASS:", msg); }

(async () => {
  console.log("verify-fairness");
  console.log(`  (default min subgroup N = ${DEFAULT_MIN_SUBGROUP_N})`);

  // [a] under-powered subgroup → gate closed, names the offender, no estimate.
  console.log("\n[a] insufficient N");
  const low = difGate({ groupA: 40, groupB: 5 }, 30);
  if (!low.activated) pass("gate closed when a subgroup is under min_n");
  else fail("gate activated despite an under-powered subgroup");
  if (low.insufficient.includes("groupB")) pass("names the under-powered subgroup (groupB)");
  else fail(`insufficient = ${JSON.stringify(low.insufficient)}`);
  if (low.dif_estimate === null) pass("no DIF estimate emitted below the gate (stub)");
  else fail("emitted a DIF estimate below the gate");

  // [b] all subgroups sufficient → gate opens (estimator still stubbed).
  console.log("\n[b] sufficient N");
  const ok = difGate({ groupA: 40, groupB: 35 }, 30);
  if (ok.activated) pass("gate opens when all subgroups ≥ min_n");
  else fail(`gate stayed closed: ${ok.reason}`);
  if (ok.dif_estimate === null) pass("estimator stubbed (null) — seam only, as intended");
  else fail("stub unexpectedly returned an estimate");

  // [c] single subgroup → nothing to compare.
  console.log("\n[c] single subgroup");
  const one = difGate({ groupA: 100 }, 30);
  if (!one.activated && /≥2 subgroups/.test(one.reason)) pass("gate closed with only one subgroup");
  else fail(`single-subgroup reason = ${one.reason}`);

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
