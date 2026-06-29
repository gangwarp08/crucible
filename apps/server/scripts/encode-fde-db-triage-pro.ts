// One-off encoder: reads fixtures/fde-db-triage-pro/scenario.json and UPSERTs
// the fde-db-triage-pro row in the `scenarios` table via the service-role
// client. Mirrors encode-fde-db-triage.ts. The companion migration
// supabase/migrations/0006_fde_db_triage_pro_content.sql carries the same
// content for environments using the Supabase CLI; this script is the apply
// path for environments without it (and the path the workflow specified —
// never via the read-only MCP).
//
// Run: pnpm exec tsx apps/server/scripts/encode-fde-db-triage-pro.ts
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
  title: string;
  role?: string;
  difficulty: string;
  dataset_ref: string;
  brief: string;
  docs: Array<{ id: string; title: string; body: string }>;
  client_persona: Record<string, unknown>;
  team_persona: Record<string, unknown>;
  constraints: Record<string, number>;
  curveballs: unknown[];
  deliverable_spec: Record<string, unknown>;
  // Rubric BINDING array (Slice 5.1): references canonical competency keys.
  rubric: Array<{ competency_key: string; weight: number } & Record<string, unknown>>;
  success_criteria: Record<string, unknown>;
}

const TARGET_SLUG = "fde-db-triage-pro";

(async () => {
  const docPath = resolve(repoRoot, "fixtures/fde-db-triage-pro/scenario.json");
  const doc = JSON.parse(readFileSync(docPath, "utf8")) as ScenarioDoc;

  if (doc.slug !== TARGET_SLUG) {
    console.error(`scenario.json slug mismatch — expected ${TARGET_SLUG}, got ${doc.slug}`);
    process.exit(1);
  }

  // Local sanity check: binding weights sum to 1.00 (integer cents to dodge float).
  const weightCents = doc.rubric.reduce((sum, r) => sum + Math.round(r.weight * 100), 0);
  if (weightCents !== 100) {
    console.error(`rubric weights sum to ${weightCents / 100}, expected 1.00`);
    process.exit(1);
  }

  console.log("=== BEFORE ===");
  const { data: before, error: beforeErr } = await supabase
    .from("scenarios")
    .select(
      "slug, title, difficulty, dataset_ref, brief, docs, client_persona, team_persona, " +
        "constraints, curveballs, deliverable_spec, rubric, success_criteria",
    )
    .eq("slug", TARGET_SLUG)
    .maybeSingle();
  if (beforeErr) {
    console.error("read failed:", beforeErr.message);
    process.exit(1);
  }
  if (!before) {
    console.log("  (no existing row — will INSERT)");
  } else {
    printSummary(before);
  }

  console.log("\n=== APPLY ===");
  const { error: upsertErr } = await supabase
    .from("scenarios")
    .upsert(
      {
        slug: doc.slug,
        title: doc.title,
        role: doc.role ?? "fde",
        difficulty: doc.difficulty,
        brief: doc.brief,
        dataset_ref: doc.dataset_ref,
        docs: doc.docs,
        client_persona: doc.client_persona,
        team_persona: doc.team_persona,
        constraints: doc.constraints,
        curveballs: doc.curveballs,
        deliverable_spec: doc.deliverable_spec,
        rubric: doc.rubric,
        success_criteria: doc.success_criteria,
      },
      { onConflict: "slug" },
    );

  if (upsertErr) {
    console.error("upsert failed:", upsertErr.message);
    process.exit(1);
  }
  console.log("upsert succeeded");

  console.log("\n=== AFTER ===");
  const { data: after, error: afterErr } = await supabase
    .from("scenarios")
    .select(
      "slug, title, difficulty, dataset_ref, brief, docs, client_persona, team_persona, " +
        "constraints, curveballs, deliverable_spec, rubric, success_criteria",
    )
    .eq("slug", TARGET_SLUG)
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
  const docs = (row.docs ?? []) as unknown[];
  const curveballs = (row.curveballs ?? []) as unknown[];
  const deliverable = row.deliverable_spec as { components?: unknown[] } | null;
  const rubric = (row.rubric ?? {}) as Record<string, { weight?: number }>;
  const success = row.success_criteria as { must?: unknown[]; bonus?: unknown[] } | null;
  const weightTotal =
    Object.values(rubric).reduce((s, r) => s + (typeof r?.weight === "number" ? r.weight : 0), 0) ||
    0;
  console.log("  slug:               ", row.slug);
  console.log("  title:              ", row.title);
  console.log("  difficulty:         ", row.difficulty);
  console.log("  dataset_ref:        ", row.dataset_ref);
  console.log("  brief (chars):      ", typeof row.brief === "string" ? row.brief.length : 0);
  console.log("  docs:               ", docs.length);
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
