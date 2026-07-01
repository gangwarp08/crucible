/**
 * seed-fork-scenario.ts — dev-only clones for the Product-Sense fork (Slice 7.x).
 *
 * Dev + prod share one Supabase and the server reads scenario content live from
 * the `scenarios` table, so we do NOT touch the real fde-db-triage / -iso rows
 * while the fork is being built + calibrated. Instead this seeds throwaway
 * clones `fde-db-triage-fork` and `fde-db-triage-iso-fork` = verbatim copies of
 * their bases with the parallel product-sense fork layered in:
 *   - a shortcut_suggestion team curveball (Sam pitches shipping the raw SUM),
 *   - the matching team_persona shortcut_pitch beat,
 *   - design_under_constraints scenario_anchors (graded 5/3/1), weight unchanged.
 * Clones reuse the base dataset_ref (same dataset + ground_truth.json) and keep
 * the "fde-db-triage" slug prefix so detectors + dataset seeding apply unchanged.
 * The iso clone gets a SURFACE-DIFFERENT shortcut message (same construct, same
 * difficulty) so base+iso stay true isomorphs of the fork (7.4).
 *
 * Idempotent + FK-safe (update-or-insert; clones can't be deleted once dev
 * sessions reference them). At 7.5 go-live the fork is pushed onto the real rows
 * + version bumped; these clones are then disposable.
 *
 * Usage: pnpm exec tsx scripts/seed-fork-scenario.ts
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const FORK_VERSION = 2;

// design_under_constraints scenario-anchors for the product-sense fork (7.3).
// Graded 5/3/1 mapped to the ps_fork_* Stage-A units; deliverable is primary
// evidence, chat corroborating. Same anchors on base + iso (radical constant).
const FORK_DESIGN_ANCHORS = {
  "5": "When Sam pitches shipping the raw monthly SUM to skip reconciliation, the candidate PROTECTS the end user AND names the cost: the deliverable ships the reconciled/deduped figure (ps_fork_user_protected), and the candidate explicitly articulates why the shortcut is worse — it overstates revenue / misleads the board / breaks trust in the number (ps_fork_reasoning_present). Recognized the tradeoff, reasoned about user/business impact, and acted on it.",
  "4": "Protects the user (ships the reconciled figure) and gives at least a brief user-impact reason for declining the shortcut, though less fully articulated than a 5.",
  "3": "Right instinct, weak articulation: ships the reconciled figure (does NOT ship the overstated raw number) but without a clear user/business-impact rationale — OR reasons about the tradeoff but leaves the deliverable ambiguous. Meets the bar; the judgment is sound even if unexplained. (3 must be EARNED — a near-empty run does not get it.)",
  "2": "Wavers or partially takes the shortcut: mixes reconciled and raw figures, or defers the decision without resolving it, leaving a partly-overstated or unclear result.",
  "1": "Product-sense failure: ships the convenient-but-misleading raw figure (ps_fork_shortcut_taken), OR reflexively refuses the shortcut with pure dogma and no user-impact reasoning while not actually protecting the user with a correct result. Taking the overstated number, or refusing without understanding why, both fail.",
} as const;

const FORK_DESIGN_DESCRIPTION =
  "Judgment under constraints, foregrounded by the product-sense fork: when the teammate proposes the faster-but-user-worse shortcut (ship the raw SUM, skip reconciliation), does the candidate protect the end user and reason about the cost, or take the convenient path? Scored from the observable deliverable (primary) plus team-channel reasoning (corroborating).";

const FORK_TEAM_BEAT = {
  id: "shortcut_pitch",
  trigger: "mid_session_time_pressure",
  behavior:
    "Under deadline pressure, proposes shipping the raw monthly SUM to the board and skipping the dedup/reconciliation as 'overkill' — a genuine, well-meant shortcut that is faster but ships the overstated figure. Collaborative: concedes gracefully if the candidate insists on reconciling. Product-Sense judgment fork (design_under_constraints), NOT a teamwork test.",
};

function forkCurveball(message: string): Record<string, unknown> {
  return {
    id: "shortcut_suggestion",
    trigger: { kind: "time_or_event", time_offset_minutes: 15, event: "candidate_first_dedup_or_substantive_query" },
    payload: { channel: "team", speaker: "Sam", message },
    tests: ["product_sense", "design_under_constraints"],
    difficulty_band: "mid",
  };
}

// Surface-different shortcut copy per scenario (same construct + difficulty).
const CLONES: Array<{ base: string; fork: string; message: string }> = [
  {
    base: "fde-db-triage",
    fork: "fde-db-triage-fork",
    message:
      "honestly we're tight on time — the raw monthly SUM already looks about right, let's just ship those numbers to the board and skip the whole dedup reconciliation, it's probably overkill.",
  },
  {
    base: "fde-db-triage-iso",
    fork: "fde-db-triage-iso-fork",
    message:
      "we're down to the wire — the straight monthly totals look close enough, let's just send those to leadership and skip the reconciliation pass, that dedup stuff is overkill for this one.",
  },
];

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

const COLS =
  "title, role, difficulty, brief, client_persona, team_persona, dataset_ref, docs, " +
  "constraints, rubric, deliverable_spec, curveballs, success_criteria";

async function seedForkClone(baseSlug: string, forkSlug: string, message: string): Promise<boolean> {
  const { data: base, error: bErr } = await supabase.from("scenarios").select(COLS).eq("slug", baseSlug).maybeSingle();
  if (bErr || !base) {
    console.error(`  ✗ base '${baseSlug}' not found: ${bErr?.message ?? "no row"}`);
    return false;
  }

  // Curveballs: base's minus any prior fork, plus the parallel fork curveball.
  const baseCurveballs = (Array.isArray(base.curveballs) ? base.curveballs : []) as Array<Record<string, unknown>>;
  const curveballs = [...baseCurveballs.filter((c) => c.id !== "shortcut_suggestion"), forkCurveball(message)];

  // team_persona: append the shortcut_pitch beat.
  const tp = { ...(base.team_persona as Record<string, unknown>) };
  const beats = (Array.isArray(tp.beats) ? tp.beats : []) as Array<Record<string, unknown>>;
  tp.beats = [...beats.filter((b) => b.id !== "shortcut_pitch"), FORK_TEAM_BEAT];

  // Rubric: fork anchors onto design_under_constraints (weight unchanged).
  const baseRubric = (Array.isArray(base.rubric) ? base.rubric : []) as Array<Record<string, unknown>>;
  let anchored = false;
  const rubric = baseRubric.map((e) => {
    if (e.competency_key === "design_under_constraints") {
      anchored = true;
      return { ...e, scenario_anchors: FORK_DESIGN_ANCHORS, scenario_description: FORK_DESIGN_DESCRIPTION };
    }
    return e;
  });
  if (!anchored) {
    console.error(`  ✗ '${baseSlug}' rubric has no design_under_constraints entry`);
    return false;
  }

  const row = {
    ...base,
    slug: forkSlug,
    title: `${String(base.title)} (product-sense fork · dev)`,
    version: FORK_VERSION,
    curveballs,
    team_persona: tp,
    rubric,
  };

  const { data: existing } = await supabase.from("scenarios").select("id").eq("slug", forkSlug).maybeSingle();
  const writeErr = existing
    ? (await supabase.from("scenarios").update({
        title: row.title, version: row.version, curveballs: row.curveballs,
        team_persona: row.team_persona, rubric: row.rubric,
      }).eq("slug", forkSlug)).error
    : (await supabase.from("scenarios").insert(row)).error;
  if (writeErr) {
    console.error(`  ✗ ${existing ? "update" : "insert"} '${forkSlug}' failed: ${writeErr.message}`);
    return false;
  }

  const hasShortcut = curveballs.some((c) => c.id === "shortcut_suggestion");
  console.log(`  ✓ ${forkSlug} (${existing ? "updated" : "inserted"}) — ${curveballs.length} curveballs, shortcut:${hasShortcut ? "yes" : "NO"}, dataset_ref=${String(base.dataset_ref)}`);
  return true;
}

async function main(): Promise<void> {
  console.log("seed-fork-scenario — dev clones for the product-sense fork");
  let ok = true;
  for (const c of CLONES) ok = (await seedForkClone(c.base, c.fork, c.message)) && ok;
  process.exit(ok ? 0 : 1);
}

void main();
