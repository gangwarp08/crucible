// verify-ps-binding.ts — Slice 7.3 acceptance.
//
// (A) Binding: the fork scenario's design_under_constraints entry carries the
//     graded fork scenario_anchors (bands 1-5) at UNCHANGED weight, so Product
//     Sense is scored via the fork anchors. Teamwork carries NO fork anchors.
// (B) Dissociability (deterministic): with the SAME team conversation but a
//     DIFFERENT product decision (protected vs shortcut deliverable), the
//     Teamwork evidence (team_engaged_count) is IDENTICAL while the ps_fork
//     units flip — proving Teamwork never reads the fork's decision, and every
//     ps_fork_* unit feeds design_under_constraints only.
//
// Run: pnpm exec tsx scripts/verify-ps-binding.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";
import { runDetectors, type EventRow } from "../src/services/evidence-extractor.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const SLUG = "fde-db-triage-fork";
const url = process.env.SUPABASE_URL ?? (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failures = 0;
function fail(m: string): void { failures++; console.error("  FAIL:", m); }
function pass(m: string): void { console.log("  PASS:", m); }

const gt = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/ground_truth.json"), "utf8")) as {
  naive_monthly_cents: Record<string, number>; corrected_monthly_cents: Record<string, number>;
};
const d = (c: number): string => `$${(c / 100).toFixed(2)}`;
const C = gt.corrected_monthly_cents, N = gt.naive_monthly_cents;
const correctedText = `March ${d(C["2026-03"]!)}, April ${d(C["2026-04"]!)}, May ${d(C["2026-05"]!)}`;
const naiveText = `March ${d(N["2026-03"]!)}, April ${d(N["2026-04"]!)}, May ${d(N["2026-05"]!)}`;

function ev(seq: number, type: string, payload: Record<string, unknown>, actor = "candidate"): EventRow {
  return { seq, type, actor, payload };
}

async function main(): Promise<void> {
  console.log("verify-ps-binding — Slice 7.3 (fork anchors + dissociability)");

  // ── A) Binding config ─────────────────────────────────────────────────────
  console.log("\n[A] rubric binding");
  if (!url || !key) {
    console.log("  ⚠ SKIP (config) — Supabase creds absent");
  } else {
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      realtime: { transport: WebSocket as any },
    });
    const { data, error } = await supabase.from("scenarios").select("rubric").eq("slug", SLUG).maybeSingle();
    if (error || !data) {
      console.log(`  ⚠ SKIP — scenario '${SLUG}' not seeded (${error?.message ?? ""})`);
    } else {
      const rubric = (data.rubric ?? []) as Array<Record<string, unknown>>;
      const dc = rubric.find((r) => r.competency_key === "design_under_constraints");
      const tw = rubric.find((r) => r.competency_key === "teamwork");
      const anchors = dc?.scenario_anchors as Record<string, string> | undefined;
      if (anchors && ["1", "2", "3", "4", "5"].every((b) => typeof anchors[b] === "string" && anchors[b]!.length > 0))
        pass("design_under_constraints carries fork scenario_anchors for all 5 bands");
      else fail(`design_under_constraints anchors incomplete: ${JSON.stringify(Object.keys(anchors ?? {}))}`);
      if (dc?.weight === 0.1) pass("design_under_constraints weight unchanged (0.10 — anchors-only, no reweight)");
      else fail(`design_under_constraints weight = ${JSON.stringify(dc?.weight)}, expected 0.10`);
      if (/shortcut|reconcil|overstat|raw|user/i.test(String(anchors?.["1"] ?? "")))
        pass("band-1 anchor references the shortcut/overstated failure");
      else fail(`band-1 anchor doesn't reference the fork: "${String(anchors?.["1"] ?? "").slice(0, 60)}"`);
      if (!tw?.scenario_anchors) pass("teamwork carries NO fork anchors (unaffected)");
      else fail("teamwork unexpectedly carries scenario_anchors");
    }
  }

  // ── B) Dissociability (deterministic detector-level) ──────────────────────
  console.log("\n[B] dissociability — same teamwork, different product decision");
  // Identical team conversation in both; only the DELIVERABLE differs.
  const teamMsgs = [
    ev(1, "curveball.fired", { curveball_id: "shortcut_suggestion" }, "system"),
    ev(2, "message.team.candidate", { text: "hey Sam, hear you on the deadline — let me sanity-check the numbers first" }),
    ev(3, "message.team.candidate", { text: "the raw sum double-counts retried webhooks and overstates revenue, so I'll reconcile before we send the board number" }),
  ];
  const protectedStream = [...teamMsgs, ev(4, "deliverable.submit", { data: { corrected_monthly_revenue: correctedText } })];
  const shortcutStream = [...teamMsgs, ev(4, "deliverable.submit", { data: { corrected_monthly_revenue: naiveText } })];

  const pu = runDetectors(SLUG, protectedStream, gt);
  const su = runDetectors(SLUG, shortcutStream, gt);
  const teamworkVal = (units: typeof pu) => units.find((u) => u.competency_key === "teamwork" && u.kind === "team_engaged_count")?.value;
  const protectedVal = (units: typeof pu) => (units.find((u) => u.kind === "ps_fork_user_protected")?.value as { protected?: boolean })?.protected;

  if (teamworkVal(pu) === teamworkVal(su) && teamworkVal(pu) === 2)
    pass(`teamwork (team_engaged_count=${teamworkVal(pu)}) IDENTICAL across protected vs shortcut — does not read the fork decision`);
  else fail(`teamwork differs across product decision: protected=${teamworkVal(pu)} shortcut=${teamworkVal(su)}`);

  if (protectedVal(pu) === true && protectedVal(su) === false)
    pass("ps_fork_user_protected flips with the deliverable (protected=true vs shortcut=false)");
  else fail(`ps_fork_user_protected did not flip: protected=${protectedVal(pu)} shortcut=${protectedVal(su)}`);

  // Every ps_fork unit feeds design_under_constraints — none leak to teamwork.
  const leaks = [...pu, ...su].filter((u) => u.kind.startsWith("ps_fork_") && u.competency_key !== "design_under_constraints");
  if (leaks.length === 0) pass("no ps_fork_* unit leaks to a non-design competency");
  else fail(`ps_fork leakage: ${leaks.map((l) => `${l.kind}→${l.competency_key}`).join(", ")}`);

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
}

void main();
