/**
 * verify-competency-gating.ts — RD4 (Slice 6.5) acceptance.
 *
 * Deterministic (no infra): exercises parseAndValidate() + weightedOverall()
 * from analysis-agent.ts. Asserts:
 *   1. a competency NOT in the scenario binding is absent (not scored/shown);
 *   2. a load-bearing competency with ZERO evidence units → not_assessed
 *      (assessed=false, score=null), NOT 1;
 *   3. the overall reweights over ASSESSED competencies only.
 *
 * Exit 0 on PASS, non-zero on FAIL.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import type { EvaluationItem } from "../src/services/analysis-agent.js";
import type { AnalysisInput } from "../src/services/analysis-input.js";

// analysis-agent.ts validates env on import — load the root .env first, then
// dynamic-import the module so the validation has its required vars.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });
const { parseAndValidate, weightedOverall } = await import("../src/services/analysis-agent.js");

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

type Rubric = AnalysisInput["scenario"]["rubric"];
// parseAndValidate only reads `.weight` off each rubric item — cast minimal
// stubs to the resolved-rubric type.
function rubric(weights: Record<string, number>): Rubric {
  const r: Record<string, unknown> = {};
  for (const [k, w] of Object.entries(weights)) r[k] = { weight: w };
  return r as Rubric;
}

console.log("verify-competency-gating — RD4 (Slice 6.5)\n");

// 4 competencies in the binding; the judge ALSO returns one outside the binding.
const RUBRIC = rubric({
  execution: 0.4,
  data_fluency: 0.3,
  outcome_communication: 0.2,
  collaboration: 0.1,
});

const judgeJson = JSON.stringify({
  overall_summary: "test",
  items: {
    execution: { score: 5, rationale: "strong", evidence: [] },
    data_fluency: { score: 4, rationale: "good", evidence: [] },
    outcome_communication: { score: 3, rationale: "ok", evidence: [] },
    collaboration: { score: 5, rationale: "n/a", evidence: [] },
    // OUTSIDE the binding — must be ignored entirely.
    telepathy: { score: 5, rationale: "should be dropped", evidence: [] },
  },
});

// Only execution + data_fluency + outcome_communication were surfaced.
// collaboration has NO evidence → must be not_assessed.
const assessedKeys = new Set(["execution", "data_fluency", "outcome_communication"]);
const { items } = parseAndValidate(judgeJson, RUBRIC, new Set<number>(), assessedKeys);

const byKey = new Map(items.map((it) => [it.competency, it]));

// Rule 1 — competency outside the binding is absent.
check("competency outside binding (telepathy) absent", !byKey.has("telepathy"));
check("only the 4 bound competencies present", items.length === 4);

// Rule 2 — zero-evidence load-bearing competency → not_assessed, score null (not 1).
const collab = byKey.get("collaboration")!;
check("collaboration assessed=false", collab.assessed === false);
check("collaboration score=null (NOT 1)", collab.score === null, `got ${String(collab.score)}`);

// Assessed competencies keep their real scores.
check("execution assessed=true, score 5", byKey.get("execution")!.assessed === true && byKey.get("execution")!.score === 5);
check("data_fluency score 4", byKey.get("data_fluency")!.score === 4);

// A missing judge item for a surfaced competency is also not_assessed (no trusted score).
{
  const missingJson = JSON.stringify({ overall_summary: "x", items: { execution: { score: 4, rationale: "", evidence: [] } } });
  const r = parseAndValidate(missingJson, rubric({ execution: 0.5, data_fluency: 0.5 }), new Set<number>(), new Set(["execution", "data_fluency"]));
  const df = r.items.find((i) => i.competency === "data_fluency")!;
  check("surfaced competency but no judge item → not_assessed null", df.assessed === false && df.score === null);
}

// Rule 3 — overall reweights over ASSESSED only.
// assessed: execution 5 (w .4), data_fluency 4 (w .3), outcome_communication 3 (w .2)
// collaboration is NOT assessed → excluded from numerator AND denominator.
// expected = (5*.4 + 4*.3 + 3*.2) / (.4+.3+.2) = (2.0+1.2+0.6)/0.9 = 3.8/0.9 = 4.222… → 4.22
const overall = weightedOverall(items);
check("overall reweights over assessed only → 4.22", overall === 4.22, `got ${overall}`);

// Sanity: if collaboration were naively scored 1 and included at full weight,
// the overall would be 3.8 — assert we are NOT doing that.
check("overall is NOT the un-gated 3.8", overall !== 3.8, `got ${overall}`);

// All-unassessed → 0 (RD3 excludes such a session anyway).
{
  const allNull: EvaluationItem[] = [
    { competency: "execution", score: null, assessed: false, weight: 0.5, rationale: "", evidence: [] },
    { competency: "data_fluency", score: null, assessed: false, weight: 0.5, rationale: "", evidence: [] },
  ];
  check("all-unassessed overall → 0", weightedOverall(allNull) === 0);
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed} check(s))`}`);
process.exit(failed === 0 ? 0 : 1);
