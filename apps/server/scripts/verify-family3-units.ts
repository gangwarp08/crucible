// Family-3 (fde-code-debug) detector verification — pure, no network.
//
// Feeds runDetectors a synthetic event stream against the REAL fixture ground
// truth and asserts:
//   1. the domain detectors fire (root cause engaged, red herring engaged,
//      tests run, batch re-run, figures match ground truth);
//   2. the ps_fork units emit, bind to design_under_constraints ONLY (the
//      dissociability guard), and read the gt marker overrides (a decline
//      stance is classified as decline);
//   3. drift boundary: the same stream under a family-1 slug emits ZERO
//      family-3 units (slug gating), and family-1's own agnostic
//      required-fields output still uses the legacy field list (the v4
//      gt-override is inert when gt lacks deliverable_required_fields).
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-family3-units.ts
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  runDetectors,
  PS_FORK_COMPETENCY,
  type EventRow,
} from "../src/services/evidence-extractor.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const gt = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures/fde-code-debug/ground_truth.json"), "utf8"),
) as Record<string, unknown>;

const dup = gt.duplicate_notification_count as number;
const affected = gt.affected_customer_count as number;

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

let seq = 0;
const ev = (type: string, actor: string, payload: Record<string, unknown>): EventRow => ({
  seq: (seq += 1),
  type,
  actor,
  payload,
});

const events: EventRow[] = [
  ev("message.client.candidate", "candidate", {
    text: "Before I dig in — how many members complained, and since when?",
  }),
  ev("pty.input", "candidate", { data: b64("npm test\n") }),
  ev("pty.input", "candidate", { data: b64("sort data/outbox.jsonl | uniq -c\n") }),
  ev("message.team.candidate", "candidate", {
    text: "send.log has zero send_error and zero status=failed lines — the retry wrapper never re-sent anything.",
  }),
  ev("ai.assistant.candidate", "candidate", {
    text: "Trace how makeIdempotencyKey in src/lib/keys.js is built — delivery_id vs event.id?",
  }),
  ev("curveball.fired", "system", { curveball_id: gt.ps_fork && (gt.ps_fork as Record<string, unknown>).curveball_id }),
  ev("message.team.candidate", "candidate", {
    text: "A suppression cache would silently drop legitimate failed-payment warnings — can't ship that to members.",
  }),
  ev("pty.input", "candidate", { data: b64("node src/cli.js data/events.jsonl\n") }),
  ev("pty.input", "candidate", { data: b64("npm test\n") }),
  ev("deliverable.submit", "candidate", {
    data: {
      impact_quantification: `${dup} duplicate notifications reached ${affected} members; counted by grouping outbox lines on event_id.`,
      root_cause_finding:
        "makeIdempotencyKey (src/lib/keys.js) keys on delivery_id instead of event.id, so at-least-once redeliveries pass dedupe. Retry theory rejected: zero send_error lines.",
      client_facing_summary:
        "Some members received the same message more than once. Nobody was double-charged and no messages were missed. Fixed; repeats can't recur.",
      decisions_and_tradeoffs:
        "Declined the suppression-cache workaround — it would silently mute legitimate warnings. Fixed the keying on event.id and added a regression test for a redelivered event.",
    },
  }),
];

const units = runDetectors("fde-code-debug", events, gt);
const byKind = new Map(units.map((u) => [u.kind, u]));

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

console.log("[family3] domain detectors");
assert((byKind.get("code_root_cause_engaged")?.value as { present: boolean })?.present === true, "code_root_cause_engaged present");
assert((byKind.get("retry_theory_engaged")?.value as { present: boolean })?.present === true, "retry_theory_engaged present");
assert((byKind.get("tests_run")?.value as { count: number })?.count === 2, "tests_run count=2");
assert((byKind.get("batch_rerun")?.value as { count: number })?.count === 1, "batch_rerun count=1");
assert((byKind.get("figures_match_truth")?.value as { matched: boolean })?.matched === true, "figures_match_truth matched");

console.log("[family3] ps_fork (family-2 machinery, family-3 gt overrides)");
const forkUnits = units.filter((u) => u.kind.startsWith("ps_fork_"));
assert(forkUnits.length >= 2, `ps_fork units emitted (${forkUnits.length})`);
assert(forkUnits.every((u) => u.competency_key === PS_FORK_COMPETENCY), "ps_fork binds design_under_constraints only");
assert((byKind.get("ps_fork_user_protected")?.value as { protected: boolean })?.protected === true, "decline stance → user_protected");
assert((byKind.get("ps_fork_shortcut_taken")?.value as { taken: boolean })?.taken === false, "decline stance → shortcut not taken");

console.log("[family3] agnostic required-fields honors gt override");
const rf = byKind.get("required_fields_present")?.value as { complete: boolean; missing: string[] };
assert(rf?.complete === true, "required_fields_present complete under family-3 field keys");

console.log("[drift] family-1 slug on the same stream");
const f1units = runDetectors("fde-db-triage", events, {});
assert(!f1units.some((u) => ["code_root_cause_engaged", "retry_theory_engaged", "tests_run", "batch_rerun"].includes(u.kind)), "no family-3 units under fde-db-triage");
const f1rf = f1units.find((u) => u.kind === "required_fields_present")?.value as { missing: string[] } | undefined;
assert(
  f1rf !== undefined && f1rf.missing.includes("corrected_monthly_revenue"),
  "family-1 required-fields fallback = legacy list (v4 inert without gt key)",
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nOK");
