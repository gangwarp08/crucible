// verify-family2-content.ts — P3.1 acceptance (authored content of the DORMANT
// second family, fde-api-integration).
//
// Two phases:
//
//   PHASE A — LOCAL (always runs, no env/infra): validates the authored
//   sources of truth — fixtures/fde-api-integration{,-pro}/scenario.json (the
//   iso document is DERIVED from the canonical one, exactly as encode/0023
//   do) — against the P3 content contract in scripts/family2-content.ts:
//     · binding-array rubric on the SAME 8 canonical competencies, weights
//       summing to 1.00; fork graded 5/3/1 on design_under_constraints via
//       scenario_anchors; teamwork carries NO fork anchors (dissociability);
//     · the native product-sense fork beat present in curveballs with
//       family-1's fork JSON shape and the detector-default id
//       ('hardcode_workaround'), pitched on the team channel;
//     · deliverable_spec exposes the four contract component keys;
//     · fixtures complete (schema/seed/ground_truth) and INTERNALLY
//       consistent: seeded row counts match ground_truth.json;
//     · isomorphs share radicals (radical_values + root_cause) and differ on
//       incidentals (seed/counts);
//     · FORK FIRES deterministically: runDetectors() over a synthetic
//       curveball.fired + the authored strong/weak deliverables (built from
//       each fixture's REAL ground truth) yields ps_fork_user_protected /
//       ps_fork_shortcut_taken bound to design_under_constraints only;
//     · migration 0023 exists and carries the dormant seed.
//   Violations here are HARD FAILURES (exit 1) — drifted content must be
//   reconciled, never skipped past.
//
//   PHASE B — DATABASE (skip-gracefully pre-migration): when Supabase env is
//   present AND migration 0023 is applied, asserts the seed landed dormant —
//   all three rows catalog_visible = false, listScenarios() (the catalog the
//   browser sees) hides every family-2 slug while family 1 still lists, and
//   the scenario_families registry mirrors the canonical rubric weights.
//   Missing env / missing column / unseeded rows → SKIP (exit 0) with a
//   message, so pre-0023 environments pass the suite untouched.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-family2-content.ts

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync, readFileSync } from "fs";
import {
  FAMILY2,
  FORK_CURVEBALL_ID,
  CANONICAL_COMPETENCIES,
  DELIVERABLE_KEYS,
  assertGroundTruth,
  deriveIsoScenarioDoc,
  findForkCurveballId,
  strongDeliverable,
  weakDeliverable,
  validateFamily2ScenarioDoc,
  type Family2GroundTruth,
  type Family2ScenarioDoc,
} from "./family2-content.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

let failures = 0;
const fail = (m: string): void => { failures++; console.error("  FAIL:", m); };
const pass = (m: string): void => console.log("  PASS:", m);
function skip(m: string): never {
  console.log(`⚠ SKIP — ${m}`);
  process.exit(failures === 0 ? 0 : 1);
}

interface Member {
  doc: Family2ScenarioDoc;
  gt: Family2GroundTruth & Record<string, unknown>;
  expected: { slug: string; difficulty: string; isomorphOf: string | null };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

(async () => {
  console.log("verify-family2-content — P3.1 (fork beat + dormant seed + isomorph radicals)\n");

  // ── PHASE A: local authored content ────────────────────────────────────────

  console.log("[a] authored scenario documents (contract in scripts/family2-content.ts)");
  const canonical = readJson<Family2ScenarioDoc>(
    resolve(repoRoot, `fixtures/${FAMILY2.canonicalSlug}/scenario.json`));
  const pro = readJson<Family2ScenarioDoc>(
    resolve(repoRoot, `fixtures/${FAMILY2.proSlug}/scenario.json`));
  const iso = deriveIsoScenarioDoc(canonical);

  const members: Member[] = [
    { doc: canonical, gt: null as never, expected: { slug: FAMILY2.canonicalSlug, difficulty: "mid", isomorphOf: null } },
    { doc: iso, gt: null as never, expected: { slug: FAMILY2.isoSlug, difficulty: "mid", isomorphOf: FAMILY2.canonicalSlug } },
    { doc: pro, gt: null as never, expected: { slug: FAMILY2.proSlug, difficulty: "hard", isomorphOf: null } },
  ];
  for (const m of members) {
    const violations = validateFamily2ScenarioDoc(m.doc, m.expected);
    if (violations.length === 0) {
      pass(`${m.expected.slug}: contract-valid (8-competency binding, fork beat, 4 deliverable keys, dissociable anchors)`);
    } else {
      for (const v of violations) fail(v);
    }
  }

  console.log("\n[b] fork beat authored per the family-1 fork JSON shape");
  for (const m of members) {
    const forkId = findForkCurveballId(m.doc.curveballs ?? []);
    if (forkId === FORK_CURVEBALL_ID) {
      pass(`${m.doc.slug}: fork curveball '${forkId}' present (detector default — no gt override needed)`);
    } else {
      fail(`${m.doc.slug}: fork curveball id '${forkId}' ≠ '${FORK_CURVEBALL_ID}'`);
    }
  }

  console.log("\n[c] fixtures complete + internally consistent");
  for (const m of members) {
    const dir = resolve(repoRoot, m.doc.dataset_ref);
    const missing = ["schema.sql", "seed.sql", "ground_truth.json", "generate.ts"]
      .filter((f) => !existsSync(resolve(dir, f)));
    if (missing.length > 0) {
      fail(`${m.doc.slug}: fixture files missing under ${m.doc.dataset_ref}: ${missing.join(", ")}`);
      continue;
    }
    const gt = readJson<Record<string, unknown>>(resolve(dir, "ground_truth.json"));
    assertGroundTruth(gt, m.doc.slug); // throws (exit 1) on contract violation
    m.gt = gt;
    pass(`${m.doc.slug}: fixture layout complete, ground_truth carries the contract keys`);

    // Seeded rows must MATCH the ground truth (cheap line-level census of the
    // generated seed.sql — catches a regenerated seed with a stale gt).
    const seed = readFileSync(resolve(dir, "seed.sql"), "utf8");
    const providerRows = (seed.match(/^INSERT INTO provider_contacts /gm) ?? []).length;
    const localRows = (seed.match(/^INSERT INTO local_contacts /gm) ?? []).length;
    if (providerRows === gt.provider_record_count) {
      pass(`${m.doc.slug}: seed provider_contacts rows = ${providerRows} = ground truth`);
    } else {
      fail(`${m.doc.slug}: seed has ${providerRows} provider rows but ground truth says ${gt.provider_record_count}`);
    }
    if (localRows === gt.synced_record_count) {
      pass(`${m.doc.slug}: seed local_contacts rows = ${localRows} = ground truth (gap = ${gt.missing_record_count})`);
    } else {
      fail(`${m.doc.slug}: seed has ${localRows} local rows but ground truth says ${gt.synced_record_count}`);
    }
  }
  if (failures > 0) {
    console.error(`\nFAILED: ${failures} content violation(s) — fix the authored sources before seeding`);
    process.exit(1);
  }

  console.log("\n[d] isomorphs share radicals, differ on incidentals");
  const canonicalGt = members[0]!.gt;
  const isoGt = members[1]!.gt;
  if (JSON.stringify(canonical.radical_values) === JSON.stringify(iso.radical_values)) {
    pass("iso radical_values identical to canonical (same construct + fork radical)");
  } else {
    fail("iso radical_values drift from canonical — not an isomorph");
  }
  if (JSON.stringify(canonical.incidental_values) !== JSON.stringify(iso.incidental_values)) {
    pass("iso incidental_values differ from canonical (different skin/seed)");
  } else {
    fail("iso incidental_values identical to canonical — nothing varies between forms");
  }
  if (canonicalGt.root_cause === isoGt.root_cause) {
    pass(`same radical root cause across forms (${canonicalGt.root_cause})`);
  } else {
    fail(`radical drift: canonical root_cause=${canonicalGt.root_cause} iso=${isoGt.root_cause}`);
  }
  if (
    canonicalGt.provider_record_count !== isoGt.provider_record_count ||
    canonicalGt.missing_record_count !== isoGt.missing_record_count
  ) {
    pass(`incidental counts differ across forms (${canonicalGt.provider_record_count}/${canonicalGt.missing_record_count} vs ${isoGt.provider_record_count}/${isoGt.missing_record_count})`);
  } else {
    fail("iso ground truth counts identical to canonical — incidentals must differ");
  }
  const proDoc = members[2]!.doc;
  if ((proDoc.radical_values["bug_class"] ?? null) === (canonical.radical_values["bug_class"] ?? null)) {
    pass(`pro shares the family bug_class (${String(canonical.radical_values["bug_class"])}) — same family, harder band`);
  } else {
    fail("pro bug_class differs from the family radical");
  }

  // ── Fork fires (deterministic): the authored deliverables + the detector ──
  console.log("\n[e] fork fires — runDetectors over the authored playthrough deliverables");
  const { runDetectors, PS_FORK_COMPETENCY } = await import("../src/services/evidence-extractor.js");
  for (const m of [members[0]!, members[1]!]) {
    const mk = (blocks: string[]) => [
      { seq: 10, type: "curveball.fired", actor: "system", payload: { curveball_id: FORK_CURVEBALL_ID } },
      {
        seq: 11, type: "deliverable.submit", actor: "candidate",
        payload: { data: Object.fromEntries(DELIVERABLE_KEYS.map((k, i) => [k, blocks[i]!])) },
      },
    ];
    const strong = runDetectors(m.doc.slug, mk(strongDeliverable(m.gt)), m.gt);
    const weak = runDetectors(m.doc.slug, mk(weakDeliverable(m.gt)), m.gt);
    const sProt = strong.find((u) => u.kind === "ps_fork_user_protected");
    const wTaken = weak.find((u) => u.kind === "ps_fork_shortcut_taken");
    if ((sProt?.value as { protected?: boolean })?.protected === true) {
      pass(`${m.doc.slug}: STRONG deliverable → ps_fork_user_protected (fork fires + decline detected)`);
    } else {
      fail(`${m.doc.slug}: strong deliverable not detected as user-protected: ${JSON.stringify(sProt?.value)}`);
    }
    if ((wTaken?.value as { taken?: boolean })?.taken === true) {
      pass(`${m.doc.slug}: WEAK deliverable → ps_fork_shortcut_taken (acceptance detected)`);
    } else {
      fail(`${m.doc.slug}: weak deliverable not detected as shortcut-taken: ${JSON.stringify(wTaken?.value)}`);
    }
    const leaked = [...strong, ...weak].filter(
      (u) => u.kind.startsWith("ps_fork_") && u.competency_key !== PS_FORK_COMPETENCY,
    );
    if (leaked.length === 0) {
      pass(`${m.doc.slug}: every ps_fork_* unit binds ${PS_FORK_COMPETENCY} (never teamwork)`);
    } else {
      fail(`${m.doc.slug}: ps_fork_* leaked to ${leaked.map((u) => u.competency_key).join(",")}`);
    }
  }

  console.log("\n[f] migration 0023 carries the dormant seed");
  const migPath = resolve(repoRoot, "supabase/migrations/0023_family2_api_integration.sql");
  if (!existsSync(migPath)) {
    fail("supabase/migrations/0023_family2_api_integration.sql missing");
  } else {
    const mig = readFileSync(migPath, "utf8");
    if (/ADD COLUMN IF NOT EXISTS catalog_visible BOOLEAN NOT NULL DEFAULT true/.test(mig)) {
      pass("0023 adds scenarios.catalog_visible (default TRUE — family 1 unaffected)");
    } else {
      fail("0023 does not add the catalog_visible column as specified");
    }
    for (const slugName of [FAMILY2.canonicalSlug, FAMILY2.isoSlug, FAMILY2.proSlug]) {
      if (mig.includes(`'${slugName}'`)) pass(`0023 seeds ${slugName}`);
      else fail(`0023 missing the ${slugName} seed`);
    }
    const dormantSeeds = (mig.match(/false {2}-- DORMANT/g) ?? []).length;
    if (dormantSeeds === 3) pass("all 3 scenario inserts seed catalog_visible = false (dormant)");
    else fail(`expected 3 dormant inserts in 0023, found ${dormantSeeds}`);
  }

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} local content check(s)`);
    process.exit(1);
  }

  // ── PHASE B: database dormancy (skip-gracefully pre-migration) ────────────

  console.log("\n[g] database seed + dormancy (skips cleanly pre-0023)");
  if (
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    (!process.env.SUPABASE_URL && !process.env.SUPABASE_PROJECT_REF)
  ) skip("SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY not set — local content checks all passed");

  // Dynamic imports AFTER dotenv so services/supabase.js sees the env.
  const { supabase } = await import("../src/services/supabase.js");
  const { listScenarios } = await import("../src/services/scenarios.js");
  if (!supabase) skip("Supabase service-role client unavailable — local content checks all passed");

  const { data, error } = await supabase
    .from("scenarios")
    .select("slug, difficulty, family_id, isomorph_of, dataset_ref, curveballs, rubric, catalog_visible")
    .eq("family_id", FAMILY2.familyId);
  if (error) {
    if (/catalog_visible/i.test(error.message)) {
      skip("scenarios.catalog_visible column missing — migration 0023 not applied yet (local content checks all passed)");
    }
    skip(`scenarios read failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{
    slug: string; difficulty: string | null; family_id: string | null;
    isomorph_of: string | null; dataset_ref: string | null;
    curveballs: unknown[]; rubric: Array<{ competency_key: string; weight: number }>;
    catalog_visible: boolean | null;
  }>;
  if (rows.length === 0) {
    skip("family 2 not seeded — apply migration 0023 (or run the encode scripts) first (local content checks all passed)");
  }

  for (const m of members) {
    const row = rows.find((r) => r.slug === m.expected.slug);
    if (!row) { fail(`${m.expected.slug}: row missing from the seeded family`); continue; }
    if (row.difficulty === m.expected.difficulty) pass(`${row.slug}: band '${row.difficulty}'`);
    else fail(`${row.slug}: band '${row.difficulty}' ≠ '${m.expected.difficulty}'`);
    if ((row.isomorph_of ?? null) === m.expected.isomorphOf) pass(`${row.slug}: isomorph_of = ${row.isomorph_of ?? "null"}`);
    else fail(`${row.slug}: isomorph_of '${row.isomorph_of}' ≠ '${m.expected.isomorphOf}'`);
    if (row.catalog_visible === false) pass(`${row.slug}: catalog_visible = false (dormant)`);
    else fail(`${row.slug}: catalog_visible = ${row.catalog_visible} — VISIBLE BEFORE ACTIVATION`);
    if (findForkCurveballId(row.curveballs ?? []) === FORK_CURVEBALL_ID) {
      pass(`${row.slug}: seeded fork beat present`);
    } else {
      fail(`${row.slug}: seeded row lost the fork curveball`);
    }
  }

  console.log("\n[h] catalog hides the family (listScenarios — what GET /api/scenarios serves)");
  const catalog = await listScenarios();
  const leakedRows = catalog.filter((c) => c.slug.startsWith(FAMILY2.familyId));
  if (leakedRows.length === 0) pass("no family-2 slug appears in the catalog");
  else fail(`family-2 leaked into the catalog: ${leakedRows.map((c) => c.slug).join(", ")}`);
  if (catalog.some((c) => c.slug === "fde-db-triage")) pass("family 1 (fde-db-triage) still lists — filter doesn't over-hide");
  else fail("family 1 missing from the catalog — the dormancy filter over-hides");

  console.log("\n[i] family registry mirrors the canonical rubric");
  const { data: famRow } = await supabase
    .from("scenario_families")
    .select("family_id, competency_targets, difficulty_band, radical_spec")
    .eq("family_id", FAMILY2.familyId)
    .maybeSingle();
  if (!famRow) fail(`scenario_families row missing for ${FAMILY2.familyId}`);
  else {
    const fam = famRow as { competency_targets: Record<string, number>; difficulty_band: string | null; radical_spec: Record<string, unknown> };
    const mismatches = canonical.rubric.filter(
      (r) => Math.round((fam.competency_targets?.[r.competency_key] ?? -1) * 100) !== Math.round(r.weight * 100),
    ).map((r) => r.competency_key);
    if (mismatches.length === 0) pass("competency_targets mirror the canonical rubric weights");
    else fail(`competency_targets drift on: ${mismatches.join(", ")}`);
    if (fam.difficulty_band) pass(`difficulty_band = ${fam.difficulty_band}`);
    else fail("difficulty_band unset");
    const keys = Object.keys(fam.competency_targets ?? {}).sort().join(",");
    if (keys === [...CANONICAL_COMPETENCIES].sort().join(",")) pass("registry targets cover exactly the 8 canonical competencies");
    else fail(`registry targets keys: ${keys}`);
  }

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
