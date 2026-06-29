// Acceptance verifier for Slice 5.7 — drift detection (deterministic, no LLM).
//
// Exercises services/drift.ts on synthetic baseline-vs-rescored anchor scores +
// version stamps: stable re-scores must NOT flag drift, a competency moving
// beyond the band MUST, and version-stamp changes are detected (with 1 vs "1"
// treated as equal). This is the calibration tripwire that fires when a model /
// detector / prompt / scenario version bump silently changes how candidates are
// judged.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-drift.ts
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const { detectDrift, changedStamps } = await import("../src/services/drift.js");

let failures = 0;
function fail(msg: string): void { failures += 1; console.error("  FAIL:", msg); }
function pass(msg: string): void { console.log("  PASS:", msg); }

const anchor = [
  { competency: "execution", score: 4 },
  { competency: "data_fluency", score: 4 },
  { competency: "teamwork", score: 3 },
];

(async () => {
  console.log("verify-drift");

  // [a] identical re-score → no drift.
  console.log("\n[a] stable re-score");
  const stable = detectDrift(anchor, anchor.map((i) => ({ ...i })), { band: 1.0 });
  if (!stable.drifted) pass(`no drift on identical scores (max_abs_delta=${stable.max_abs_delta})`);
  else fail(`stable re-score flagged drift: ${JSON.stringify(stable.per_competency)}`);

  // [b] a competency moves beyond the band → drift.
  console.log("\n[b] real drift");
  const moved = [
    { competency: "execution", score: 2 },     // -2 from baseline
    { competency: "data_fluency", score: 4 },
    { competency: "teamwork", score: 3 },
  ];
  const drift = detectDrift(anchor, moved, { band: 1.0 });
  if (drift.drifted) pass(`drift flagged (max_abs_delta=${drift.max_abs_delta} on ${drift.per_competency[0]!.competency})`);
  else fail("score moved by 2 but drift not flagged");
  if (drift.per_competency[0]!.competency === "execution" && drift.per_competency[0]!.delta === -2)
    pass("largest delta correctly attributed to execution (-2)");
  else fail(`top delta = ${JSON.stringify(drift.per_competency[0])}`);

  // [c] within-band wobble → no drift.
  console.log("\n[c] within-band wobble");
  const wobble = anchor.map((i) => ({ ...i, score: i.score - 1 })); // -1 each, == band
  const wob = detectDrift(anchor, wobble, { band: 1.0 });
  if (!wob.drifted) pass("a uniform -1 shift stays within band (not > 1.0)");
  else fail(`uniform -1 flagged drift (max_abs_delta=${wob.max_abs_delta})`);

  // [d] version-stamp change detection (1 vs "1" is NOT a change).
  console.log("\n[d] version stamps");
  const baseV = { competency_model_version: 1, detector_version: "1", judge_prompt_version: "1", scenario_version: 1 };
  const sameV = { competency_model_version: "1", detector_version: "1", judge_prompt_version: "1", scenario_version: "1" };
  if (changedStamps(baseV, sameV).length === 0) pass("1 vs \"1\" not treated as a version change");
  else fail(`spurious version change: ${changedStamps(baseV, sameV).join(", ")}`);

  const bumpV = { ...baseV, judge_prompt_version: "2" };
  const changed = changedStamps(baseV, bumpV);
  if (changed.length === 1 && changed[0] === "judge_prompt_version")
    pass("judge_prompt_version bump detected");
  else fail(`expected [judge_prompt_version], got ${JSON.stringify(changed)}`);

  // [e] report carries versions_changed when stamps differ.
  const withVers = detectDrift(anchor, moved, { band: 1.0, baselineVersions: baseV, rescoredVersions: bumpV });
  if (withVers.versions_changed.includes("judge_prompt_version"))
    pass("drift report surfaces the changed stamp");
  else fail(`versions_changed = ${JSON.stringify(withVers.versions_changed)}`);

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
