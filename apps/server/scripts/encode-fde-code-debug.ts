// Encoder for the fde-code-debug CANONICAL scenario (family 3 — inherited-
// codebase debugging). Reads fixtures/fde-code-debug/scenario.json (the source
// of truth), validates it inline against the family-3 content expectations,
// and upserts:
//   1. the scenario_families row 'fde-code-debug' — competency_targets mirror
//      the canonical rubric weights, and
//   2. the scenario row itself, with catalog_visible = FALSE (dormant, same
//      posture family 2 shipped with: never listable/assignable until a
//      deliberate activation flip after calibration runs).
//
// Unlike families 1-2 this family has no SQL dataset: fixtures/fde-code-debug/
// dataset.json declares kind=git_repo and the seeder ships the committed tree
// under repo/ into the sandbox (services/dataset-seed.ts).
//
// Run: pnpm --filter @crucible/server exec tsx scripts/encode-fde-code-debug.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const SLUG = "fde-code-debug";
const FAMILY_ID = "fde-code-debug";

const COMPETENCY_KEYS = [
  "problem_framing", "data_fluency", "design_under_constraints", "execution",
  "ai_orchestration", "teamwork", "customer_engagement", "outcome_communication",
];

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

interface ScenarioDoc {
  slug: string;
  title: string;
  role: string;
  difficulty: string;
  dataset_ref: string;
  docs: unknown[];
  brief: string;
  constraints: Record<string, unknown>;
  client_persona: Record<string, unknown>;
  team_persona: Record<string, unknown>;
  curveballs: { id: string }[];
  deliverable_spec: { components: { key: string }[] };
  rubric: { competency_key: string; weight: number }[];
  success_criteria: Record<string, unknown>;
  radical_values: Record<string, unknown>;
  incidental_values: Record<string, unknown>;
}

function validate(doc: ScenarioDoc, gt: Record<string, unknown>): string[] {
  const v: string[] = [];
  if (doc.slug !== SLUG) v.push(`slug must be "${SLUG}", got "${doc.slug}"`);
  if (doc.dataset_ref !== `fixtures/${SLUG}`) v.push(`dataset_ref must be fixtures/${SLUG}`);

  const weightSum = doc.rubric.reduce((s, r) => s + r.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-6) v.push(`rubric weights sum to ${weightSum}, expected 1.0`);
  const keys = doc.rubric.map((r) => r.competency_key).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...COMPETENCY_KEYS].sort())) {
    v.push(`rubric must bind exactly the shared 8 competencies; got ${keys.join(", ")}`);
  }

  // The ps_fork contract that lets the evidence extractor reuse the family-2
  // stance machinery: curveball ids must line up across scenario + gt, and the
  // gt must carry the marker overrides (family-2 defaults must never apply).
  const forkId = (doc.radical_values?.ps_fork as Record<string, unknown> | undefined)?.curveball_id;
  const gtFork = (gt.ps_fork ?? {}) as Record<string, unknown>;
  if (typeof forkId !== "string") v.push("radical_values.ps_fork.curveball_id missing");
  if (gtFork.curveball_id !== forkId) {
    v.push(`ground_truth.ps_fork.curveball_id (${String(gtFork.curveball_id)}) != radical_values (${String(forkId)})`);
  }
  if (!doc.curveballs.some((c) => c.id === forkId)) v.push(`no curveball with id ${String(forkId)}`);
  for (const markerKey of ["shortcut_markers", "naming_markers", "robust_markers"]) {
    const m = gtFork[markerKey];
    if (!Array.isArray(m) || m.length === 0) v.push(`ground_truth.ps_fork.${markerKey} missing/empty`);
  }

  // Deliverable components must match the required-fields list the agnostic
  // detector reads (v4 contract) — a drift here silently mis-scores execution.
  const componentKeys = doc.deliverable_spec.components.map((c) => c.key);
  const required = gt.deliverable_required_fields;
  if (
    !Array.isArray(required) ||
    JSON.stringify([...required].sort()) !== JSON.stringify([...componentKeys].sort())
  ) {
    v.push("ground_truth.deliverable_required_fields must equal deliverable_spec component keys");
  }

  for (const k of [
    "root_cause", "duplicate_notification_count", "affected_customer_count",
    "total_events", "total_deliveries", "root_cause_narrative",
  ]) {
    if (!(k in gt)) v.push(`ground_truth missing ${k}`);
  }
  return v;
}

(async () => {
  const doc = JSON.parse(
    readFileSync(resolve(repoRoot, `fixtures/${SLUG}/scenario.json`), "utf8"),
  ) as ScenarioDoc;
  const gt = JSON.parse(
    readFileSync(resolve(repoRoot, doc.dataset_ref, "ground_truth.json"), "utf8"),
  ) as Record<string, unknown>;
  // The manifest is what routes seeding away from the sqlite path — a missing
  // manifest would provision this scenario as a broken sqlite dataset.
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, doc.dataset_ref, "dataset.json"), "utf8"),
  ) as { kind?: string };
  if (manifest.kind !== "git_repo") {
    console.error(`fixtures/${SLUG}/dataset.json must declare kind=git_repo`);
    process.exit(1);
  }

  const violations = validate(doc, gt);
  if (violations.length > 0) {
    console.error("scenario.json violates the family-3 content contract:");
    for (const v of violations) console.error("  -", v);
    process.exit(1);
  }
  console.log(
    `[encode] ${doc.slug}: events=${gt.total_events} deliveries=${gt.total_deliveries} ` +
      `duplicates=${gt.duplicate_notification_count} affected=${gt.affected_customer_count} ` +
      `root_cause=${gt.root_cause}`,
  );

  // ── 1. Family registry (competency_targets mirror the canonical rubric) ──
  const targets = Object.fromEntries(doc.rubric.map((r) => [r.competency_key, r.weight]));
  const { error: famErr } = await supabase.from("scenario_families").upsert(
    {
      family_id: FAMILY_ID,
      title: "Inherited-codebase debugging (duplicate notifications)",
      difficulty_band: "mid",
      radical_spec: {
        task:
          "Debug an inherited notification service whose green test suite hides a cross-file " +
          "bug: quantify the duplicate notifications from the outbox, falsify the send-retry " +
          "red herring against the log, trace the idempotency key to the per-attempt delivery " +
          "id, fix the keying with a regression test, and deliver a plain-English member note.",
        ...doc.radical_values,
      },
      competency_targets: targets,
    },
    { onConflict: "family_id" },
  );
  if (famErr) {
    console.error("scenario_families upsert failed:", famErr.message);
    process.exit(1);
  }
  console.log(`[encode] scenario_families '${FAMILY_ID}' upserted`);

  // ── 2. Scenario row — DORMANT (catalog_visible = false) ──
  const { error } = await supabase.from("scenarios").upsert(
    {
      slug: doc.slug,
      title: doc.title,
      role: doc.role,
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
      family_id: FAMILY_ID,
      isomorph_of: null,
      radical_values: doc.radical_values,
      incidental_values: doc.incidental_values,
      catalog_visible: false, // DORMANT until the deliberate activation flip
    },
    { onConflict: "slug" },
  );
  if (error) {
    console.error("scenarios upsert failed:", error.message);
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
