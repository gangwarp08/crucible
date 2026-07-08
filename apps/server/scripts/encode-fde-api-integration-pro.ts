// Encoder for the fde-api-integration-pro scenario (family 2 HARD-band
// variant, P3.1 — DORMANT). Reads fixtures/fde-api-integration-pro/
// scenario.json, validates it against the P3 content contract
// (scripts/family2-content.ts), and upserts the row with
// catalog_visible = FALSE.
//
// The family registry row is owned by encode-fde-api-integration.ts (the
// canonical member — competency_targets mirror ITS rubric weights), so this
// script only touches the scenario row. Paired with migration
// 0023_family2_api_integration.sql; either path produces the same row state.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/encode-fde-api-integration-pro.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";
import {
  FAMILY2,
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
    readFileSync(resolve(repoRoot, `fixtures/${FAMILY2.proSlug}/scenario.json`), "utf8"),
  ) as Family2ScenarioDoc;

  const violations = validateFamily2ScenarioDoc(doc, {
    slug: FAMILY2.proSlug,
    difficulty: "hard",
    isomorphOf: null,
  });
  if (violations.length > 0) {
    console.error("scenario.json violates the family-2 content contract:");
    for (const v of violations) console.error("  -", v);
    process.exit(1);
  }

  const gt = JSON.parse(
    readFileSync(resolve(repoRoot, doc.dataset_ref, "ground_truth.json"), "utf8"),
  ) as Record<string, unknown>;
  assertGroundTruth(gt, doc.slug);
  console.log(
    `[encode] ${doc.slug}: provider=${gt.provider_record_count} synced=${gt.synced_record_count} ` +
      `missing=${gt.missing_record_count} (cursor-skipped=${gt.cursor_skipped_record_count}, ` +
      `auth-dropped=${gt.auth_dropped_record_count}) root_cause=${gt.root_cause}`,
  );

  const { error } = await supabase.from("scenarios").upsert(
    {
      slug: doc.slug,
      title: doc.title ?? "Contact sync triage (Tier 1.5)",
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
      isomorph_of: null, // hard-band variant, not an isomorph of the mid scenario
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
  console.log("  difficulty:      ", after.difficulty);
  console.log("  family_id:       ", after.family_id);
  console.log("  isomorph_of:     ", after.isomorph_of);
  console.log("  catalog_visible: ", after.catalog_visible, "(must be false — dormant)");
  if (after.catalog_visible !== false) {
    console.error("FATAL: catalog_visible is not false — dormancy broken");
    process.exit(1);
  }
  console.log("\nOK");
})();
