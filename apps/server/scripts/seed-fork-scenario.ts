/**
 * seed-fork-scenario.ts — dev-only clone for the Product-Sense fork (Slice 7.x).
 *
 * Dev + prod share one Supabase and the server reads scenario content live from
 * the `scenarios` table, so we do NOT touch the real `fde-db-triage` row while
 * the fork is being built + calibrated. Instead this seeds a throwaway
 * `fde-db-triage-fork` scenario = a verbatim copy of `fde-db-triage` with the
 * fork's curveball + team-persona beat layered in (from the fixture). It reuses
 * `dataset_ref` (same dataset + ground_truth.json on disk) and the slug prefix
 * "fde-db-triage" so the existing detectors + dataset seeding apply unchanged.
 *
 * Idempotent: deletes any prior fde-db-triage-fork row first, re-inserts.
 * At 7.5 go-live the fork is pushed onto the real fde-db-triage row + version
 * bumped; this clone is then disposable.
 *
 * Usage: pnpm exec tsx scripts/seed-fork-scenario.ts
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const FORK_SLUG = "fde-db-triage-fork";
const BASE_SLUG = "fde-db-triage";
const FORK_VERSION = 2;

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
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

async function main(): Promise<void> {
  // Fork-augmented content (curveballs + team_persona with the shortcut beat).
  const fork = JSON.parse(
    readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/scenario.json"), "utf8"),
  ) as { curveballs: unknown[]; team_persona: Record<string, unknown> };

  // Copy the live base row verbatim for everything else.
  const { data: base, error: bErr } = await supabase
    .from("scenarios")
    .select(
      "title, role, difficulty, brief, client_persona, team_persona, dataset_ref, docs, " +
        "constraints, rubric, deliverable_spec, curveballs, success_criteria",
    )
    .eq("slug", BASE_SLUG)
    .maybeSingle();
  if (bErr || !base) {
    console.error(`could not read base scenario '${BASE_SLUG}':`, bErr?.message ?? "not found");
    process.exit(1);
  }

  // Fresh insert — drop any prior clone first (idempotent).
  await supabase.from("scenarios").delete().eq("slug", FORK_SLUG);

  const row = {
    ...base,
    slug: FORK_SLUG,
    title: `${String(base.title)} (product-sense fork · dev)`,
    version: FORK_VERSION,
    // Layer the fork in — curveballs + team_persona come from the fixture; the
    // rubric stays the base's for now (7.3 adds the design_under_constraints
    // fork anchors to this clone's rubric).
    curveballs: fork.curveballs,
    team_persona: fork.team_persona,
  };

  const { error: iErr } = await supabase.from("scenarios").insert(row);
  if (iErr) {
    console.error("insert failed:", iErr.message);
    process.exit(1);
  }

  const { data: check } = await supabase
    .from("scenarios")
    .select("id, slug, version, dataset_ref")
    .eq("slug", FORK_SLUG)
    .maybeSingle();
  const cbCount = (fork.curveballs ?? []).length;
  console.log(
    `seeded ${FORK_SLUG}: id=${check?.id} version=${check?.version} dataset_ref=${check?.dataset_ref} curveballs=${cbCount}`,
  );
  const hasShortcut = (fork.curveballs as Array<{ id?: string }>).some((c) => c.id === "shortcut_suggestion");
  console.log(`  shortcut_suggestion curveball present: ${hasShortcut ? "yes ✓" : "NO ✗"}`);
}

void main();
