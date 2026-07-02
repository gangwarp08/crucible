// verify-ps-fork-units.ts — Slice 7.2 acceptance (deterministic, no infra).
//
// Feeds crafted event streams to runDetectors() and asserts the product-sense
// fork detectors emit the expected units with correct event_seqs:
//   - user-protected playthrough  → ps_fork_user_protected.protected = true
//   - shortcut-taken playthrough  → ps_fork_shortcut_taken.taken = true
//   - reasoning playthrough       → ps_fork_reasoning_present = true (right seqs)
//   - fork-not-fired              → NO ps_fork_* units at all
// Also confirms every ps_fork_* unit feeds design_under_constraints (never
// teamwork) — the dissociability guarantee.
//
// Run: pnpm exec tsx scripts/verify-ps-fork-units.ts
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { runDetectors, type EventRow, type EvidenceUnit } from "../src/services/evidence-extractor.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const SLUG = "fde-db-triage-fork";
const gt = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/ground_truth.json"), "utf8")) as {
  naive_monthly_cents: Record<string, number>;
  corrected_monthly_cents: Record<string, number>;
};

let failures = 0;
function fail(m: string): void { failures++; console.error("  FAIL:", m); }
function pass(m: string): void { console.log("  PASS:", m); }

const d = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const CORR = gt.corrected_monthly_cents;
const NAIVE = gt.naive_monthly_cents;
const correctedText = `March ${d(CORR["2026-03"]!)}, April ${d(CORR["2026-04"]!)}, May ${d(CORR["2026-05"]!)}`;
const naiveText = `March ${d(NAIVE["2026-03"]!)}, April ${d(NAIVE["2026-04"]!)}, May ${d(NAIVE["2026-05"]!)}`;

function ev(seq: number, type: string, payload: Record<string, unknown>, actor = "candidate"): EventRow {
  return { seq, type, actor, payload };
}
const forkEv = ev(1, "curveball.fired", { curveball_id: "shortcut_suggestion" }, "system");

function psUnits(units: EvidenceUnit[]): EvidenceUnit[] {
  return units.filter((u) => u.kind.startsWith("ps_fork_"));
}
function byKind(units: EvidenceUnit[], kind: string): EvidenceUnit | undefined {
  return units.find((u) => u.kind === kind);
}

console.log("verify-ps-fork-units — Slice 7.2 (product-sense fork detectors)\n");

// ── A) user-protected + reasoning ────────────────────────────────────────────
{
  console.log("[A] user-protected + reasoning");
  const events = [
    forkEv,
    ev(2, "message.team.candidate", { text: "can't just ship the raw sum — it double-counts the webhook retries and overstates revenue; the board needs the reconciled number." }),
    ev(3, "deliverable.submit", { data: { corrected_monthly_revenue: correctedText } }),
  ];
  const u = runDetectors(SLUG, events, gt);
  const prot = byKind(u, "ps_fork_user_protected");
  const taken = byKind(u, "ps_fork_shortcut_taken");
  const reason = byKind(u, "ps_fork_reasoning_present");
  if ((prot?.value as { protected?: boolean })?.protected === true) pass("ps_fork_user_protected.protected = true"); else fail(`user_protected = ${JSON.stringify(prot?.value)}`);
  if ((taken?.value as { taken?: boolean })?.taken === false) pass("ps_fork_shortcut_taken.taken = false"); else fail(`shortcut_taken = ${JSON.stringify(taken?.value)}`);
  if (reason?.value === true) pass("ps_fork_reasoning_present = true"); else fail(`reasoning_present = ${JSON.stringify(reason?.value)}`);
  // event_seqs
  if (JSON.stringify(prot?.event_seqs) === JSON.stringify([1, 3])) pass("user_protected event_seqs = [fork, submit] = [1,3]"); else fail(`user_protected seqs = ${JSON.stringify(prot?.event_seqs)}`);
  if (JSON.stringify(reason?.event_seqs) === JSON.stringify([2])) pass("reasoning_present event_seqs = [2]"); else fail(`reasoning seqs = ${JSON.stringify(reason?.event_seqs)}`);
  // dissociability
  if (psUnits(u).every((x) => x.competency_key === "design_under_constraints")) pass("all ps_fork units feed design_under_constraints (not teamwork)"); else fail(`ps_fork units leaked to: ${psUnits(u).map((x) => x.competency_key).join(",")}`);
}

// ── B) shortcut-taken, no reasoning ──────────────────────────────────────────
{
  console.log("\n[B] shortcut-taken, no reasoning");
  const events = [
    forkEv,
    ev(2, "deliverable.submit", { data: { corrected_monthly_revenue: naiveText } }),
  ];
  const u = runDetectors(SLUG, events, gt);
  const prot = byKind(u, "ps_fork_user_protected");
  const taken = byKind(u, "ps_fork_shortcut_taken");
  const reason = byKind(u, "ps_fork_reasoning_present");
  if ((taken?.value as { taken?: boolean })?.taken === true) pass("ps_fork_shortcut_taken.taken = true"); else fail(`shortcut_taken = ${JSON.stringify(taken?.value)}`);
  if ((prot?.value as { protected?: boolean })?.protected === false) pass("ps_fork_user_protected.protected = false"); else fail(`user_protected = ${JSON.stringify(prot?.value)}`);
  if (reason?.value === false) pass("ps_fork_reasoning_present = false (no team reasoning)"); else fail(`reasoning_present = ${JSON.stringify(reason?.value)}`);
}

// ── C) fork not fired → no ps_fork units ─────────────────────────────────────
{
  console.log("\n[C] fork not presented");
  const events = [ev(1, "deliverable.submit", { data: { corrected_monthly_revenue: correctedText } })];
  const u = runDetectors(SLUG, events, gt);
  if (psUnits(u).length === 0) pass("no ps_fork_* units when the shortcut beat never fired"); else fail(`emitted ${psUnits(u).length} ps_fork units without the fork`);
  // sanity: the base fde-db-triage execution detector still ran
  if (u.some((x) => x.kind === "figures_match_truth")) pass("base fde detectors still run (figures_match_truth present)"); else fail("base detectors did not run");
}

// ── D) reasoning BEFORE the fork does not count ──────────────────────────────
{
  console.log("\n[D] reasoning must be AFTER the fork beat");
  const events = [
    ev(1, "message.team.candidate", { text: "the figures look inflated / overstated, might be duplicates" }),
    ev(2, "curveball.fired", { curveball_id: "shortcut_suggestion" }, "system"),
    ev(3, "deliverable.submit", { data: { corrected_monthly_revenue: correctedText } }),
  ];
  const u = runDetectors(SLUG, events, gt);
  const reason = byKind(u, "ps_fork_reasoning_present");
  if (reason?.value === false) pass("pre-fork reasoning message does NOT count toward the fork"); else fail(`reasoning_present = ${JSON.stringify(reason?.value)} (pre-fork msg should not count)`);
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
process.exit(failures === 0 ? 0 : 1);
