// One-off encoder: reads fixtures/fde-db-triage/scenario.json and UPDATEs the
// existing fde-db-triage row in the `scenarios` table via the service-role
// client. The placeholder row was INSERTed by migration 0003_fde_scenarios.sql
// with ON CONFLICT DO NOTHING, so a fresh `supabase db reset` will re-seed the
// placeholder; the committed migration 0004_fde_db_triage_content.sql carries
// the same UPDATE so reset reproduces the live state. This script is the apply
// path for environments without the Supabase CLI.
//
// Run: pnpm exec tsx apps/server/scripts/encode-fde-db-triage.ts
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

interface ScenarioDoc {
  slug: string;
  title?: string;
  role?: string;
  difficulty: string;
  dataset_ref: string;
  brief: string;
  client_persona: Record<string, unknown>;
  team_persona: Record<string, unknown>;
  constraints: Record<string, number>;
  curveballs: unknown[];
  deliverable_spec: Record<string, unknown>;
  rubric: Record<string, { weight: number; description: string; signals: string[] }>;
  success_criteria: Record<string, unknown>;
}

(async () => {
  const docPath = resolve(repoRoot, "fixtures/fde-db-triage/scenario.json");
  const doc = JSON.parse(readFileSync(docPath, "utf8")) as ScenarioDoc;

  if (doc.slug !== "fde-db-triage") {
    console.error(`scenario.json slug mismatch — expected fde-db-triage, got ${doc.slug}`);
    process.exit(1);
  }

  // Local sanity check: rubric weights sum to 1.00 (integer cents to dodge float).
  const weightCents = Object.values(doc.rubric).reduce(
    (sum, r) => sum + Math.round(r.weight * 100),
    0,
  );
  if (weightCents !== 100) {
    console.error(`rubric weights sum to ${weightCents / 100}, expected 1.00`);
    process.exit(1);
  }

  console.log("=== BEFORE ===");
  const { data: before, error: beforeErr } = await supabase
    .from("scenarios")
    .select(
      "slug, difficulty, dataset_ref, brief, client_persona, team_persona, " +
        "constraints, curveballs, deliverable_spec, rubric, success_criteria",
    )
    .eq("slug", "fde-db-triage")
    .maybeSingle();
  if (beforeErr) {
    console.error("read failed:", beforeErr.message);
    process.exit(1);
  }
  if (!before) {
    console.error("no row with slug='fde-db-triage' — was migration 0003 applied?");
    process.exit(1);
  }
  printSummary(before);

  console.log("\n=== APPLY ===");
  const { error: updErr } = await supabase
    .from("scenarios")
    .update({
      difficulty: doc.difficulty,
      brief: doc.brief,
      dataset_ref: doc.dataset_ref,
      client_persona: doc.client_persona,
      team_persona: doc.team_persona,
      constraints: doc.constraints,
      curveballs: doc.curveballs,
      deliverable_spec: doc.deliverable_spec,
      rubric: doc.rubric,
      success_criteria: doc.success_criteria,
    })
    .eq("slug", "fde-db-triage");

  if (updErr) {
    console.error("update failed:", updErr.message);
    process.exit(1);
  }
  console.log("update succeeded");

  console.log("\n=== AFTER ===");
  const { data: after, error: afterErr } = await supabase
    .from("scenarios")
    .select(
      "slug, difficulty, dataset_ref, brief, client_persona, team_persona, " +
        "constraints, curveballs, deliverable_spec, rubric, success_criteria",
    )
    .eq("slug", "fde-db-triage")
    .single();
  if (afterErr) {
    console.error("read-back failed:", afterErr.message);
    process.exit(1);
  }
  printSummary(after);

  console.log("\nOK");
})();

function printSummary(row: Record<string, unknown>): void {
  const persona = row.client_persona as { beats?: unknown[] } | null;
  const team = row.team_persona as { beats?: unknown[] } | null;
  const curveballs = (row.curveballs ?? []) as unknown[];
  const deliverable = row.deliverable_spec as { components?: unknown[] } | null;
  const rubric = (row.rubric ?? {}) as Record<string, { weight?: number }>;
  const success = row.success_criteria as { must?: unknown[]; bonus?: unknown[] } | null;
  const weightTotal =
    Object.values(rubric).reduce((s, r) => s + (typeof r?.weight === "number" ? r.weight : 0), 0) ||
    0;
  console.log("  slug:               ", row.slug);
  console.log("  difficulty:         ", row.difficulty);
  console.log("  dataset_ref:        ", row.dataset_ref);
  console.log("  brief (chars):      ", typeof row.brief === "string" ? row.brief.length : 0);
  console.log("  client_persona beats:", persona?.beats?.length ?? 0);
  console.log("  team_persona beats: ", team?.beats?.length ?? 0);
  console.log("  curveballs:         ", curveballs.length);
  console.log("  deliverable items:  ", deliverable?.components?.length ?? 0);
  console.log(
    "  rubric keys:        ",
    Object.keys(rubric).sort().join(", ") || "(empty)",
  );
  console.log(
    "  rubric weight sum:  ",
    weightTotal.toFixed(4),
    `(int cents = ${Math.round(weightTotal * 100)})`,
  );
  console.log("  success must:       ", success?.must?.length ?? 0);
  console.log("  success bonus:      ", success?.bonus?.length ?? 0);
  console.log("  constraints keys:   ", Object.keys((row.constraints ?? {}) as object).sort().join(", "));
}
