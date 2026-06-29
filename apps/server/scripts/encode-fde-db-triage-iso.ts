// Encoder for the fde-db-triage-iso ISOMORPH (Slice 5.6).
//
// An isomorph reuses the canonical scenario's AUTHORED content verbatim (brief,
// docs, personas, rubric binding, deliverable spec, curveballs, constraints) and
// swaps only the INCIDENTAL values: a distinct slug, a different dataset_ref
// (→ different seeded numbers), and the family linkage. So instead of a second
// hand-maintained scenario.json that could drift from the canonical one, this
// reads fixtures/fde-db-triage/scenario.json and overrides the incidentals, then
// upserts the row. Same band (mid) + same family + same radical_values as the
// canonical scenario ⇒ a matched isomorph that should score comparably.
//
// Run: pnpm exec tsx apps/server/scripts/encode-fde-db-triage-iso.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";

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

const ISO_SLUG = "fde-db-triage-iso";
const ISO_DATASET_REF = "fixtures/fde-db-triage-iso";

interface ScenarioDoc {
  slug: string;
  title?: string;
  role?: string;
  difficulty: string;
  dataset_ref: string;
  brief: string;
  docs: unknown[];
  client_persona: Record<string, unknown>;
  team_persona: Record<string, unknown>;
  constraints: Record<string, number>;
  curveballs: unknown[];
  deliverable_spec: Record<string, unknown>;
  rubric: Array<{ competency_key: string; weight: number } & Record<string, unknown>>;
  success_criteria: Record<string, unknown>;
}

(async () => {
  // Read the CANONICAL authored content; the isomorph reuses it wholesale.
  const base = JSON.parse(
    readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/scenario.json"), "utf8"),
  ) as ScenarioDoc;

  if (base.difficulty !== "mid") {
    console.error(`expected canonical difficulty 'mid', got ${base.difficulty}`);
    process.exit(1);
  }
  const weightCents = base.rubric.reduce((s, r) => s + Math.round(r.weight * 100), 0);
  if (weightCents !== 100) {
    console.error(`rubric weights sum to ${weightCents / 100}, expected 1.00`);
    process.exit(1);
  }

  // Read the isomorph's ground truth just to surface its (different) figures.
  const gt = JSON.parse(
    readFileSync(resolve(repoRoot, ISO_DATASET_REF, "ground_truth.json"), "utf8"),
  ) as { corrected_monthly_cents: Record<string, number> };
  console.log("[encode-iso] isomorph corrected figures (cents):", gt.corrected_monthly_cents);

  const row = {
    slug: ISO_SLUG,
    title: "Revenue dashboard triage (isomorph B)",
    role: base.role ?? "fde",
    difficulty: "mid", // SAME band as the canonical scenario
    dataset_ref: ISO_DATASET_REF,
    brief: base.brief,
    docs: base.docs,
    client_persona: base.client_persona,
    team_persona: base.team_persona,
    constraints: base.constraints,
    curveballs: base.curveballs,
    deliverable_spec: base.deliverable_spec,
    rubric: base.rubric,
    success_criteria: base.success_criteria,
    // Family linkage (Slice 5.6).
    family_id: "fde-db-triage",
    isomorph_of: "fde-db-triage",
    radical_values: {
      bug_class: "webhook_retry_duplicate",
      dedup_key: "external_payment_id",
      requires_status_filter: "succeeded",
      red_herrings: ["refunds", "utc_month_boundary"],
      reporting_window: ["2026-03", "2026-04", "2026-05"],
      bug_months: ["2026-04", "2026-05"],
    },
    incidental_values: {
      seed_label: "fde-db-triage-iso-v1",
      company: "Meridian",
      reference_date: "2026-05-31T23:59:59Z",
    },
  };

  console.log(`\n=== UPSERT ${ISO_SLUG} ===`);
  const { error } = await supabase.from("scenarios").upsert(row, { onConflict: "slug" });
  if (error) {
    console.error("upsert failed:", error.message);
    process.exit(1);
  }

  const { data: after, error: rErr } = await supabase
    .from("scenarios")
    .select("slug, title, difficulty, dataset_ref, family_id, isomorph_of, radical_values")
    .eq("slug", ISO_SLUG)
    .single();
  if (rErr || !after) {
    console.error("read-back failed:", rErr?.message);
    process.exit(1);
  }
  console.log("  slug:        ", after.slug);
  console.log("  title:       ", after.title);
  console.log("  difficulty:  ", after.difficulty);
  console.log("  dataset_ref: ", after.dataset_ref);
  console.log("  family_id:   ", after.family_id);
  console.log("  isomorph_of: ", after.isomorph_of);
  console.log("\nOK");
})();
