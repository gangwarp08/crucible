// Encoder for the fde-api-integration CANONICAL scenario (family 2, P3.1 —
// DORMANT). Reads fixtures/fde-api-integration/scenario.json (the source of
// truth), validates it against the P3 content contract
// (scripts/family2-content.ts), and upserts:
//   1. the scenario_families row 'fde-api-integration' — competency_targets
//      mirror the canonical rubric weights (asserted by
//      verify-cross-family-scale.ts [f]), and
//   2. the scenario row itself, with catalog_visible = FALSE (dormancy: the
//      family is never listable/assignable until the deliberate activation
//      flip after cohort 1 — see verify-family2-dormant.ts).
//
// Paired with migration 0023_family2_api_integration.sql, which was generated
// from the same scenario.json files — either path produces the same row state.
// This script is the apply path for environments without the Supabase CLI.
// REQUIRES migration 0023's `catalog_visible` column (it fails loudly, not
// silently, on a pre-0023 database).
//
// Run: pnpm --filter @crucible/server exec tsx scripts/encode-fde-api-integration.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";
import {
  FAMILY2,
  FAMILY2_REGISTRY,
  assertGroundTruth,
  validateFamily2ScenarioDoc,
  type Family2ScenarioDoc,
} from "./family2-content.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF
    ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`
    : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

(async () => {
  const doc = JSON.parse(
    readFileSync(resolve(repoRoot, `fixtures/${FAMILY2.canonicalSlug}/scenario.json`), "utf8"),
  ) as Family2ScenarioDoc;

  const violations = validateFamily2ScenarioDoc(doc, {
    slug: FAMILY2.canonicalSlug,
    difficulty: "mid",
    isomorphOf: null,
  });
  if (violations.length > 0) {
    console.error("scenario.json violates the family-2 content contract:");
    for (const v of violations) console.error("  -", v);
    process.exit(1);
  }

  // The fixture's ground truth must satisfy the calibration-harness contract
  // BEFORE the row points at it (guard() in family2-harness.ts hard-fails on
  // a seeded-but-drifted fixture).
  const gt = JSON.parse(
    readFileSync(resolve(repoRoot, doc.dataset_ref, "ground_truth.json"), "utf8"),
  ) as Record<string, unknown>;
  assertGroundTruth(gt, doc.slug);
  console.log(
    `[encode] ${doc.slug}: provider=${gt.provider_record_count} synced=${gt.synced_record_count} ` +
      `missing=${gt.missing_record_count} root_cause=${gt.root_cause}`,
  );

  // ── 1. Family registry (competency_targets mirror the canonical rubric) ──
  const targets = Object.fromEntries(doc.rubric.map((r) => [r.competency_key, r.weight]));
  const { error: famErr } = await supabase.from("scenario_families").upsert(
    { ...FAMILY2_REGISTRY, competency_targets: targets },
    { onConflict: "family_id" },
  );
  if (famErr) {
    console.error("scenario_families upsert failed:", famErr.message);
    process.exit(1);
  }
  console.log(`[encode] scenario_families '${FAMILY2.familyId}' upserted`);

  // ── 2. Scenario row — DORMANT (catalog_visible = false) ──
  const { error } = await supabase.from("scenarios").upsert(
    {
      slug: doc.slug,
      title: doc.title ?? "Contact sync triage (API integration)",
      role: doc.role ?? "fde",
      difficulty: doc.difficulty,
      dataset_ref: doc.dataset_ref,
      brief: doc.brief,
      docs: doc.docs,
      client_persona: doc.client_persona,
      team_persona: doc.team_persona,
      constraints: doc.constraints,
      curveballs: doc.curveballs,
      deliverable_spec: doc.deliverable_spec,
      rubric: doc.rubric,
      success_criteria: doc.success_criteria,
      family_id: FAMILY2.familyId,
      isomorph_of: null,
      radical_values: doc.radical_values,
      incidental_values: doc.incidental_values,
      catalog_visible: false, // DORMANT until the post-cohort-1 activation flip
    },
    { onConflict: "slug" },
  );
  if (error) {
    console.error(
      "scenarios upsert failed:",
      error.message,
      /catalog_visible/i.test(error.message) ? "\n  → apply migration 0023 first" : "",
    );
    process.exit(1);
  }

  const { data: after, error: rErr } = await supabase
    .from("scenarios")
    .select("slug, title, difficulty, dataset_ref, family_id, isomorph_of, catalog_visible")
    .eq("slug", doc.slug)
    .single();
  if (rErr || !after) {
    console.error("read-back failed:", rErr?.message);
    process.exit(1);
  }
  console.log("  slug:            ", after.slug);
  console.log("  title:           ", after.title);
  console.log("  difficulty:      ", after.difficulty);
  console.log("  dataset_ref:     ", after.dataset_ref);
  console.log("  family_id:       ", after.family_id);
  console.log("  isomorph_of:     ", after.isomorph_of);
  console.log("  catalog_visible: ", after.catalog_visible, "(must be false — dormant)");
  if (after.catalog_visible !== false) {
    console.error("FATAL: catalog_visible is not false — dormancy broken");
    process.exit(1);
  }
  console.log("\nOK");
})();
