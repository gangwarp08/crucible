// verify-family2-discrimination.ts — P3.4 acceptance (isolated calibration of
// the DORMANT second family, fde-api-integration).
//
// Runs two hand-authored scripted playthroughs of the canonical mid-band
// scenario end to end through the real harness (server → E2B sandbox →
// personas → Stage A/B evaluation) and asserts the judge separates them —
// BEFORE the family ever sees a real candidate. Mirrors
// verify-discrimination.ts (family 1), plus the native product-sense fork
// checks from verify-fork-discrimination.ts, because family 2's fork is
// native from day one.
//
// STRONG: clarifying question, all docs, 5 targeted queries (status
//         distribution → record gap → missing-record characterization →
//         cursor fingerprint → retry fingerprint), quantified pushback on the
//         auth red herring, DECLINES the hardcoded workaround with
//         user-impact reasoning, one verified AI turn, complete + correct
//         deliverable (proper pagination fix, counts from ground truth).
//
// WEAK:   vague client ping, zero docs, ONE naive count, passive ack of the
//         auth theory, ACCEPTS the hardcoded workaround, zero AI turns,
//         deliverable ships the workaround with the wrong cause and no
//         quantification.
//
// The runs differ on every band the family measures AND on the fork, so this
// asserts BOTH overall discrimination (spread ≥ 1.5, no inversions) and that
// the fork concentrates its separation on the product-sense competency
// (design_under_constraints — the shared-model key family 1's fork feeds).
//
// SKIPS (exit 0 + message) when env/infra/seed is unavailable, or with
// --dry-run — which prints the complete authored playthroughs for review
// without touching infra. Content lives in scripts/family2-content.ts.
//
// Run:      pnpm --filter @crucible/server exec tsx scripts/verify-family2-discrimination.ts
// Dry run:  pnpm --filter @crucible/server exec tsx scripts/verify-family2-discrimination.ts --dry-run

import { FAMILY2, CANONICAL_COMPETENCIES, strongDeliverable, weakDeliverable } from "./family2-content.js";
import {
  guard, isDryRun, skip, sleep,
  describePlaythrough, runPlaythrough, pollEval,
  type EvalRow,
} from "./family2-harness.js";

const COOLDOWN_MS = Number(process.env.FAMILY2_COOLDOWN_MS ?? "60000");
const MIN_SPREAD = 1.5;          // overall separation floor (family-1 bar)
const MIN_FORK_SEPARATION = 2;   // product-sense competency: strong − weak

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function printReport(strong: EvalRow, weak: EvalRow): { verdict: string; flags: string[] } {
  console.log("\n═══ FAMILY-2 DISCRIMINATION CHECK (fde-api-integration) ═══\n");
  console.log(`STRONG overall: ${strong.overall_score.toFixed(2)} / 5`);
  console.log(`WEAK   overall: ${weak.overall_score.toFixed(2)} / 5`);

  const flags: string[] = [];
  const spread = strong.overall_score - weak.overall_score;
  console.log(`SPREAD: ${spread >= 0 ? "+" : ""}${spread.toFixed(2)} (≥ ${MIN_SPREAD}: ${spread >= MIN_SPREAD ? "PASS" : "FAIL"})`);
  if (spread < MIN_SPREAD) flags.push(`no-separation: overall spread ${spread.toFixed(2)} < ${MIN_SPREAD}`);

  const sBy = new Map(strong.items.map((i) => [i.competency, i]));
  const wBy = new Map(weak.items.map((i) => [i.competency, i]));

  console.log(`\nCOMPETENCY${" ".repeat(18)}w     STRONG   WEAK    Δ     FLAGS`);
  const seps: Array<{ key: string; sep: number }> = [];
  for (const key of CANONICAL_COMPETENCIES) {
    const s = sBy.get(key);
    const w = wBy.get(key);
    if (!s || !w) { console.log(`  ${pad(key, 26)} MISSING (s=${!!s} w=${!!w})`); continue; }
    // RD4: not_assessed (null) can't be compared — skip, don't fabricate flags.
    if (s.score === null || w.score === null) {
      console.log(`  ${pad(key, 26)} not_assessed (S=${s.score ?? "null"} W=${w.score ?? "null"}) — skipped`);
      continue;
    }
    const delta = s.score - w.score;
    seps.push({ key, sep: delta });
    const rowFlags: string[] = [];
    if (s.score <= 2) { rowFlags.push("strictness"); flags.push(`strictness on STRONG.${key}: ${s.score}/5`); }
    if (w.score >= 3) { rowFlags.push("leniency");   flags.push(`leniency on WEAK.${key}: ${w.score}/5`); }
    if (delta <= 0)   { rowFlags.push("INVERSION");  flags.push(`INVERSION on ${key}: STRONG=${s.score}, WEAK=${w.score}`); }
    console.log(`  ${pad(key, 26)} ${pad(s.weight.toFixed(2), 5)} ${pad(`${s.score}/5`, 8)} ${pad(`${w.score}/5`, 7)} ${pad(`${delta >= 0 ? "+" : ""}${delta}`, 5)} ${rowFlags.join(", ")}`);
  }

  // Native fork: the product-sense competency must (a) separate ≥ 2 and
  // (b) carry the LARGEST separation — the fork's signal concentrates there.
  const ps = seps.find((x) => x.key === FAMILY2.productSenseCompetency);
  if (!ps) {
    flags.push(`${FAMILY2.productSenseCompetency} not assessed in one/both runs — fork signal unmeasured`);
  } else {
    const maxSep = Math.max(...seps.map((x) => x.sep));
    console.log(`\nFORK: ${FAMILY2.productSenseCompetency} separation +${ps.sep} (need ≥ ${MIN_FORK_SEPARATION}; largest overall = +${maxSep})`);
    if (ps.sep < MIN_FORK_SEPARATION) flags.push(`fork separation +${ps.sep} < ${MIN_FORK_SEPARATION} on ${FAMILY2.productSenseCompetency}`);
    if (ps.sep < maxSep) flags.push(`fork signal does not concentrate: another competency separates more (+${maxSep}) than ${FAMILY2.productSenseCompetency} (+${ps.sep})`);
  }

  console.log("\nFLAGS:");
  if (flags.length === 0) console.log("  (none)");
  else for (const f of flags) console.log(`  - ${f}`);
  console.log("\nJUDGE SUMMARIES:");
  console.log(`  STRONG: ${strong.summary ?? "<missing>"}`);
  console.log(`  WEAK:   ${weak.summary ?? "<missing>"}`);

  let verdict: string;
  const hasInversion = flags.some((f) => f.startsWith("INVERSION"));
  if (hasInversion) verdict = "DOES NOT DISCRIMINATE — inversion(s) present";
  else if (spread < MIN_SPREAD) verdict = `INSUFFICIENT SEPARATION — spread ${spread.toFixed(2)} < ${MIN_SPREAD}`;
  else if (flags.length > 0) verdict = "DISCRIMINATES BUT MISCALIBRATED — flags present";
  else verdict = `DISCRIMINATES CLEANLY — spread ${spread.toFixed(2)}, fork concentrated on ${FAMILY2.productSenseCompetency}, no inversions`;
  console.log(`\nVERDICT: ${verdict}`);
  return { verdict, flags };
}

(async () => {
  console.log("verify-family2-discrimination — P3.4 (dormant family, isolated calibration)");

  if (isDryRun()) {
    // Content review without infra: print both complete playthroughs using
    // placeholder ground-truth figures.
    const placeholder = {
      provider_record_count: 12_000, synced_record_count: 11_640,
      missing_record_count: 360, edge_case_record_count: 360,
      root_cause: "cursor_pagination_contract_drift",
    };
    describePlaythrough("strong", placeholder);
    describePlaythrough("weak", placeholder);
    console.log("\n[deliverable preview uses placeholder ground truth — live runs read fixtures/<slug>/ground_truth.json]");
    void strongDeliverable; void weakDeliverable; // content exercised above
    skip("--dry-run: playthrough content printed, no infra touched");
  }

  const { supabase, scenarios, groundTruths } = await guard([FAMILY2.canonicalSlug]);
  const scenario = scenarios.get(FAMILY2.canonicalSlug)!;
  const gt = groundTruths.get(FAMILY2.canonicalSlug)!;

  if (COOLDOWN_MS > 0) { console.log(`\n[setup] cooling ${COOLDOWN_MS / 1000}s for the LLM rate-limit window…`); await sleep(COOLDOWN_MS); }
  console.log("\n[1/2] STRONG playthrough");
  const strongSession = await runPlaythrough("strong", scenario, gt);

  if (COOLDOWN_MS > 0) { console.log(`\n[interlude] cooling ${COOLDOWN_MS / 1000}s…`); await sleep(COOLDOWN_MS); }
  console.log("\n[2/2] WEAK playthrough");
  const weakSession = await runPlaythrough("weak", scenario, gt);

  console.log("\n[poll] evaluations…");
  const strong = await pollEval(supabase, strongSession, 120_000);
  const weak = await pollEval(supabase, weakSession, 120_000);
  if (!strong || !weak) {
    console.error(`FATAL: evaluation missing — STRONG=${strong ? "complete" : "missing"}, WEAK=${weak ? "complete" : "missing"}`);
    process.exit(1);
  }

  const { verdict } = printReport(strong, weak);
  process.exit(verdict.startsWith("DISCRIMINATES CLEANLY") ? 0 : 1);
})();
