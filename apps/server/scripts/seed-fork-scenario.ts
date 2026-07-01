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

// 7.3 — design_under_constraints scenario-anchors for the product-sense fork.
// Per-scenario anchors override canonical defaults in the judge prompt. Weight
// is unchanged (0.10) — the fork strengthens MEASUREMENT, not weight. The
// graded 5/3/1 map to the ps_fork_* Stage-A units (protected / shortcut /
// reasoning), with the deliverable outcome as primary evidence, chat as
// corroboration — you cannot pass by only saying the right thing.
const FORK_DESIGN_ANCHORS = {
  "5": "When Sam pitches shipping the raw monthly SUM to skip reconciliation, the candidate PROTECTS the end user AND names the cost: the deliverable ships the reconciled/deduped figure (ps_fork_user_protected), and the candidate explicitly articulates why the shortcut is worse — it overstates revenue / misleads the board / breaks trust in the number (ps_fork_reasoning_present). Recognized the tradeoff, reasoned about user/business impact, and acted on it.",
  "4": "Protects the user (ships the reconciled figure) and gives at least a brief user-impact reason for declining the shortcut, though less fully articulated than a 5.",
  "3": "Right instinct, weak articulation: ships the reconciled figure (does NOT ship the overstated raw number) but without a clear user/business-impact rationale — OR reasons about the tradeoff but leaves the deliverable ambiguous. Meets the bar; the judgment is sound even if unexplained. (3 must be EARNED — a near-empty run does not get it.)",
  "2": "Wavers or partially takes the shortcut: mixes reconciled and raw figures, or defers the decision without resolving it, leaving a partly-overstated or unclear result.",
  "1": "Product-sense failure: ships the convenient-but-misleading raw figure (ps_fork_shortcut_taken), OR reflexively refuses the shortcut with pure dogma and no user-impact reasoning while not actually protecting the user with a correct result. Taking the overstated number, or refusing without understanding why, both fail.",
} as const;

const FORK_DESIGN_DESCRIPTION =
  "Judgment under constraints, foregrounded by the product-sense fork: when the teammate proposes the faster-but-user-worse shortcut (ship the raw SUM, skip reconciliation), does the candidate protect the end user and reason about the cost, or take the convenient path? Scored from the observable deliverable (primary) plus team-channel reasoning (corroborating).";

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

  // 7.3 — inject the fork anchors onto the design_under_constraints binding
  // entry (weight untouched). The rubric is the post-rebind binding array.
  const baseRubric = Array.isArray(base.rubric) ? (base.rubric as Array<Record<string, unknown>>) : [];
  let anchoredDesign = false;
  const forkRubric = baseRubric.map((entry) => {
    if (entry.competency_key === "design_under_constraints") {
      anchoredDesign = true;
      return { ...entry, scenario_anchors: FORK_DESIGN_ANCHORS, scenario_description: FORK_DESIGN_DESCRIPTION };
    }
    return entry;
  });
  if (!anchoredDesign) {
    console.error("base rubric has no design_under_constraints entry — cannot bind fork anchors");
    process.exit(1);
  }

  const row = {
    ...base,
    slug: FORK_SLUG,
    title: `${String(base.title)} (product-sense fork · dev)`,
    version: FORK_VERSION,
    // Layer the fork in — curveballs + team_persona from the fixture; rubric =
    // base binding with fork anchors on design_under_constraints.
    curveballs: fork.curveballs,
    team_persona: fork.team_persona,
    rubric: forkRubric,
  };

  // Update-or-insert (idempotent + FK-safe: the clone can't be deleted once dev
  // sessions reference it). Update the fork-relevant fields if the row exists,
  // else insert a fresh clone.
  const { data: existing } = await supabase.from("scenarios").select("id").eq("slug", FORK_SLUG).maybeSingle();
  const writeErr = existing
    ? (
        await supabase
          .from("scenarios")
          .update({
            title: row.title,
            version: row.version,
            curveballs: row.curveballs,
            team_persona: row.team_persona,
            rubric: row.rubric,
          })
          .eq("slug", FORK_SLUG)
      ).error
    : (await supabase.from("scenarios").insert(row)).error;
  if (writeErr) {
    console.error(`${existing ? "update" : "insert"} failed:`, writeErr.message);
    process.exit(1);
  }
  console.log(existing ? "updated existing clone" : "inserted new clone");

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
