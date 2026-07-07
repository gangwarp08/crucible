// verify-cross-family-scale.ts — P3.5 acceptance (structural cross-family
// comparability between family 1 (fde-db-triage) and the DORMANT family 2
// (fde-api-integration)).
//
// INFRA-LIGHT: Supabase reads only (seeded rows + the canonical competency
// model) — no server, no sandbox, no LLM. Asserts the structure that makes
// cross-family comparison meaningful is in place NOW, so that when family 2
// activates, a matched-strength profile scores on the SAME scale:
//
//   [a] SHARED MODEL — both families' rubrics resolve against the same active
//       competency model version, with no unknown keys (no redefinition).
//   [b] SAME KEYS — both families bind exactly the 8 canonical competency
//       keys (family 2 must not add/drop constructs).
//   [c] WEIGHTS — every member's binding weights sum to 1.00 (integer cents).
//   [d] ANCHORS — every bound competency resolves to anchors covering at
//       least bands 1/3/5 (scenario override or canonical default).
//   [e] FORK SCALE — family 2's native product-sense fork grades onto the
//       SAME 1–5 scale via scenario_anchors on the product-sense competency
//       (design_under_constraints — the key family 1's fork feeds), with the
//       signed-off 5/3/1 grading present and anchor text that references the
//       hardcode/workaround decision. Teamwork carries NO fork anchors.
//   [f] FAMILY REGISTRY — scenario_families rows exist for both families and
//       competency_targets mirror the canonical member's rubric weights.
//   [g] MATCHED-PROFILE (PLACEHOLDER) — for synthetic per-competency score
//       profiles, the weighted overall under family-1 vs family-2 weights
//       stays within a small structural tolerance. This is a placeholder for
//       the real matched-N comparison that can only run after activation.
//
// SKIPS (exit 0 + message) when Supabase env is missing or the family-2 seed
// (migration 0023) is not applied. FAILS on structural violations.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-cross-family-scale.ts

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { FAMILY2, CANONICAL_COMPETENCIES } from "./family2-content.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const FAMILY1_ID = "fde-db-triage";
const FAMILY1_CANONICAL = "fde-db-triage";
/** Placeholder tolerance for the matched-profile weighted-overall delta —
 *  bounds how much the two families' legitimate weight differences can move
 *  the SAME profile's overall. Real cross-family validation needs matched
 *  candidates (post-activation). */
const MAX_PROFILE_DELTA = 0.5;

let failures = 0;
const fail = (m: string): void => { failures++; console.error("  FAIL:", m); };
const pass = (m: string): void => console.log("  PASS:", m);
function skip(m: string): never { console.log(`⚠ SKIP — ${m}`); process.exit(0); }

interface BindingEntry {
  competency_key: string;
  weight: number;
  scenario_anchors?: Record<string, string>;
  [k: string]: unknown;
}
interface ScenarioRow {
  slug: string;
  family_id: string | null;
  difficulty: string | null;
  rubric: BindingEntry[];
}
interface FamilyRow {
  family_id: string;
  competency_targets: Record<string, number>;
  difficulty_band: string | null;
  radical_spec: Record<string, unknown>;
}

const weightCents = (rubric: BindingEntry[]): number =>
  rubric.reduce((s, r) => s + Math.round((r.weight ?? 0) * 100), 0);

(async () => {
  console.log("verify-cross-family-scale — P3.5 (same model, same scale, structural comparability)");

  if (
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    (!process.env.SUPABASE_URL && !process.env.SUPABASE_PROJECT_REF)
  ) skip("SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY not set");

  // Dynamic imports AFTER dotenv so services/supabase.js sees the env
  // (static imports would hoist above loadEnv).
  const { supabase } = await import("../src/services/supabase.js");
  const { loadActiveModelVersion, loadModel, resolveBinding } =
    await import("../src/services/competencies.js");
  if (!supabase) skip("Supabase service-role client unavailable");

  // ── Load rows ───────────────────────────────────────────────────────────────
  const { data: scenData, error: scenErr } = await supabase
    .from("scenarios")
    .select("slug, family_id, difficulty, rubric")
    .in("family_id", [FAMILY1_ID, FAMILY2.familyId]);
  if (scenErr) skip(`scenarios read failed: ${scenErr.message}`);
  const scenarios = (scenData ?? []) as unknown as ScenarioRow[];

  const fam1 = scenarios.filter((s) => s.family_id === FAMILY1_ID);
  const fam2 = scenarios.filter((s) => s.family_id === FAMILY2.familyId);
  if (fam1.length === 0) skip(`family 1 (${FAMILY1_ID}) not seeded — wrong database?`);
  if (fam2.length === 0) skip(`family 2 (${FAMILY2.familyId}) not seeded — apply migration 0023 first`);
  const f1Canonical = fam1.find((s) => s.slug === FAMILY1_CANONICAL);
  const f2Canonical = fam2.find((s) => s.slug === FAMILY2.canonicalSlug);
  if (!f1Canonical) skip(`canonical ${FAMILY1_CANONICAL} row missing`);
  if (!f2Canonical) { fail(`canonical ${FAMILY2.canonicalSlug} row missing from seeded family 2`); }

  const { data: famData, error: famErr } = await supabase
    .from("scenario_families")
    .select("family_id, competency_targets, difficulty_band, radical_spec")
    .in("family_id", [FAMILY1_ID, FAMILY2.familyId]);
  if (famErr) skip(`scenario_families read failed: ${famErr.message}`);
  const families = new Map(((famData ?? []) as unknown as FamilyRow[]).map((f) => [f.family_id, f]));

  // ── [a] Shared model: one active version, both families resolve cleanly ────
  console.log("\n[a] shared competency model");
  const version = await loadActiveModelVersion();
  const model = await loadModel(version);
  console.log(`  active model version: ${version} (${model.competencies.size} competencies)`);
  for (const s of [...fam1, ...fam2]) {
    try {
      resolveBinding(s.rubric, model);
      pass(`${s.slug} resolves against model v${version} (no redefined/unknown keys)`);
    } catch (err) {
      fail(`${s.slug} does not resolve against model v${version}: ${(err as Error).message}`);
    }
  }

  // ── [b] Same competency key set ─────────────────────────────────────────────
  console.log("\n[b] same bound keys");
  const canonicalSet = [...CANONICAL_COMPETENCIES].sort().join(",");
  for (const s of [f1Canonical!, ...fam2]) {
    const keys = (s.rubric ?? []).map((r) => r.competency_key).sort().join(",");
    if (keys === canonicalSet) pass(`${s.slug} binds exactly the 8 canonical competencies`);
    else fail(`${s.slug} key set differs from canonical: ${keys || "(empty)"}`);
  }

  // ── [c] Weights sum to 1.00 ─────────────────────────────────────────────────
  console.log("\n[c] weights");
  for (const s of [...fam1, ...fam2]) {
    const cents = weightCents(s.rubric ?? []);
    if (cents === 100) pass(`${s.slug} weights sum to 1.00`);
    else fail(`${s.slug} weights sum to ${cents / 100} (expected 1.00)`);
  }

  // ── [d] Anchors present for every bound competency ─────────────────────────
  console.log("\n[d] anchors (resolved: scenario override ?? canonical default)");
  for (const s of [f1Canonical!, ...fam2]) {
    try {
      const { rubric } = resolveBinding(s.rubric, model);
      const bad = Object.entries(rubric).filter(([, item]) =>
        !["1", "3", "5"].every((b) => typeof item.anchors?.[b] === "string" && item.anchors[b]!.length > 0),
      ).map(([k]) => k);
      if (bad.length === 0) pass(`${s.slug}: all bound competencies resolve anchors for bands 1/3/5`);
      else fail(`${s.slug}: anchors incomplete for ${bad.join(", ")}`);
    } catch { /* already failed in [a] */ }
  }

  // ── [e] Fork grades onto the same 1–5 scale ────────────────────────────────
  console.log("\n[e] product-sense fork scale");
  for (const s of fam2) {
    const ps = (s.rubric ?? []).find((r) => r.competency_key === FAMILY2.productSenseCompetency);
    const tw = (s.rubric ?? []).find((r) => r.competency_key === "teamwork");
    const anchors = ps?.scenario_anchors;
    if (!anchors) { fail(`${s.slug}: ${FAMILY2.productSenseCompetency} carries no scenario_anchors — fork not graded`); continue; }
    const bands = Object.keys(anchors).sort();
    if (bands.every((b) => /^[1-5]$/.test(b))) pass(`${s.slug}: fork anchors use only integer bands 1–5 (${bands.join(",")}) — same scale as family 1`);
    else fail(`${s.slug}: fork anchor bands off the 1–5 scale: ${bands.join(",")}`);
    if (["5", "3", "1"].every((b) => typeof anchors[b] === "string" && anchors[b]!.length > 0))
      pass(`${s.slug}: signed-off 5/3/1 grading present`);
    else fail(`${s.slug}: fork anchors missing one of bands 5/3/1: ${bands.join(",")}`);
    if (/hardcode|workaround|shortcut|edge.?case/i.test(JSON.stringify(anchors)))
      pass(`${s.slug}: fork anchors reference the hardcode/workaround decision`);
    else fail(`${s.slug}: fork anchors don't reference the fork decision`);
    if (!tw?.scenario_anchors) pass(`${s.slug}: teamwork carries NO fork anchors (dissociability)`);
    else fail(`${s.slug}: teamwork unexpectedly carries scenario_anchors — check for fork leakage`);
  }

  // ── [f] Family registry mirrors the canonical member ───────────────────────
  console.log("\n[f] family registry");
  for (const [familyId, canonical] of [
    [FAMILY1_ID, f1Canonical] as const,
    [FAMILY2.familyId, f2Canonical] as const,
  ]) {
    const fam = families.get(familyId);
    if (!fam) { fail(`scenario_families row missing for ${familyId}`); continue; }
    if (fam.difficulty_band) pass(`${familyId}: difficulty_band = ${fam.difficulty_band}`);
    else fail(`${familyId}: difficulty_band unset`);
    if (Object.keys(fam.radical_spec ?? {}).length > 0) pass(`${familyId}: radical_spec present`);
    else fail(`${familyId}: radical_spec empty`);
    if (!canonical) continue;
    const targets = fam.competency_targets ?? {};
    const mismatches = (canonical.rubric ?? []).filter(
      (r) => Math.round((targets[r.competency_key] ?? -1) * 100) !== Math.round(r.weight * 100),
    ).map((r) => r.competency_key);
    if (mismatches.length === 0) pass(`${familyId}: competency_targets mirror the canonical rubric weights`);
    else fail(`${familyId}: competency_targets drift from canonical rubric on: ${mismatches.join(", ")}`);
  }

  // ── [g] Matched-profile placeholder ────────────────────────────────────────
  console.log("\n[g] matched-profile scale check (PLACEHOLDER — real matched N post-activation)");
  if (f2Canonical) {
    const w1 = new Map((f1Canonical!.rubric ?? []).map((r) => [r.competency_key, r.weight]));
    const w2 = new Map((f2Canonical.rubric ?? []).map((r) => [r.competency_key, r.weight]));
    const overall = (w: Map<string, number>, profile: Record<string, number>): number =>
      [...CANONICAL_COMPETENCIES].reduce((s, k) => s + (w.get(k) ?? 0) * (profile[k] ?? 0), 0);
    const profiles: Record<string, Record<string, number>> = {
      "uniform strong (all 4s)": Object.fromEntries(CANONICAL_COMPETENCIES.map((k) => [k, 4])),
      "uniform weak (all 2s)":   Object.fromEntries(CANONICAL_COMPETENCIES.map((k) => [k, 2])),
      "technical-lean mixed": {
        problem_framing: 4, data_fluency: 5, design_under_constraints: 4, execution: 5,
        ai_orchestration: 4, teamwork: 2, customer_engagement: 2, outcome_communication: 3,
      },
      "communicator-lean mixed": {
        problem_framing: 4, data_fluency: 2, design_under_constraints: 3, execution: 2,
        ai_orchestration: 3, teamwork: 5, customer_engagement: 5, outcome_communication: 5,
      },
    };
    let worst = 0;
    for (const [label, profile] of Object.entries(profiles)) {
      const o1 = overall(w1, profile);
      const o2 = overall(w2, profile);
      const delta = Math.abs(o1 - o2);
      worst = Math.max(worst, delta);
      console.log(`  ${label}: family1=${o1.toFixed(2)}  family2=${o2.toFixed(2)}  Δ=${delta.toFixed(2)}`);
    }
    if (worst <= MAX_PROFILE_DELTA)
      pass(`matched profiles score comparably across families (max Δ ${worst.toFixed(2)} ≤ ${MAX_PROFILE_DELTA})`);
    else
      fail(`matched profile diverges across families (max Δ ${worst.toFixed(2)} > ${MAX_PROFILE_DELTA}) — reweight family 2 or revisit`);
  }

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
