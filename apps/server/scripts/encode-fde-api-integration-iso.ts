// Encoder for the fde-api-integration-iso ISOMORPH (family 2, P3.1 — DORMANT).
//
// An isomorph reuses the canonical scenario's AUTHORED content verbatim
// (brief, docs, personas, rubric binding incl. the fork anchors, deliverable
// spec, curveballs incl. the native product-sense fork, constraints,
// radical_values) and swaps only the INCIDENTALS: slug, title, dataset_ref
// (→ a different seed with different counts/page size), and the family
// linkage. So instead of a second hand-maintained scenario.json that could
// drift from the canonical one, this reads
// fixtures/fde-api-integration/scenario.json, derives the iso document via
// deriveIsoScenarioDoc() (shared with the 0023 migration regeneration), and
// upserts the row with catalog_visible = FALSE.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/encode-fde-api-integration-iso.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";
import {
  FAMILY2,
  assertGroundTruth,
  deriveIsoScenarioDoc,
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
  // Read the CANONICAL authored content; the isomorph reuses it wholesale.
  const base = JSON.parse(
    readFileSync(resolve(repoRoot, `fixtures/${FAMILY2.canonicalSlug}/scenario.json`), "utf8"),
  ) as Family2ScenarioDoc;
  const doc = deriveIsoScenarioDoc(base);

  const violations = validateFamily2ScenarioDoc(doc, {
    slug: FAMILY2.isoSlug,
    difficulty: "mid", // SAME band as the canonical scenario (matched isomorph)
    isomorphOf: FAMILY2.canonicalSlug,
  });
  if (violations.length > 0) {
    console.error("derived iso document violates the family-2 content contract:");
    for (const v of violations) console.error("  -", v);
    process.exit(1);
  }

  // The iso ground truth must satisfy the harness contract AND actually be a
  // different form (different incidental counts, same radical root cause).
  const gt = JSON.parse(
    readFileSync(resolve(repoRoot, doc.dataset_ref, "ground_truth.json"), "utf8"),
  ) as Record<string, unknown>;
  assertGroundTruth(gt, doc.slug);
  const baseGt = JSON.parse(
    readFileSync(resolve(repoRoot, base.dataset_ref, "ground_truth.json"), "utf8"),
  ) as Record<string, unknown>;
  assertGroundTruth(baseGt, base.slug);
  if (gt.root_cause !== baseGt.root_cause) {
    console.error(`radical drift: iso root_cause '${gt.root_cause}' ≠ canonical '${baseGt.root_cause}'`);
    process.exit(1);
  }
  if (
    gt.provider_record_count === baseGt.provider_record_count &&
    gt.missing_record_count === baseGt.missing_record_count
  ) {
    console.error("iso ground truth identical to canonical — incidentals must differ");
    process.exit(1);
  }
  console.log(
    `[encode-iso] ${doc.slug}: provider=${gt.provider_record_count} synced=${gt.synced_record_count} ` +
      `missing=${gt.missing_record_count} (canonical: ${baseGt.provider_record_count}/${baseGt.missing_record_count})`,
  );

  const { error } = await supabase.from("scenarios").upsert(
    {
      slug: doc.slug,
      title: doc.title,
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
      isomorph_of: FAMILY2.canonicalSlug,
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
  console.log("  isomorph_of:     ", after.isomorph_of);
  console.log("  catalog_visible: ", after.catalog_visible, "(must be false — dormant)");
  if (after.catalog_visible !== false) {
    console.error("FATAL: catalog_visible is not false — dormancy broken");
    process.exit(1);
  }
  console.log("\nOK");
})();
