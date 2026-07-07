// verify-family2-units.ts — P3.2 acceptance (deterministic, no infra).
//
// Feeds crafted family-2 (fde-api-integration) event streams to runDetectors()
// and asserts:
//   A) fork REJECTED + robust fix + reasoning  → ps_fork_user_protected=true,
//      ps_fork_shortcut_taken=false, ps_fork_reasoning_present=true (HIGH PS)
//   B) fork ACCEPTED (hardcoded workaround)    → ps_fork_shortcut_taken=true,
//      ps_fork_user_protected=false, no reasoning (LOW PS)
//   C) fork never fired                        → NO ps_fork_* units at all
//   D) domain detectors fire (auth / pagination / retry-idempotency /
//      contract-drift) with correct event_seqs
//   E) DISSOCIABILITY: every ps_fork_* unit binds PS_FORK_COMPETENCY
//      (design_under_constraints) and NEVER teamwork
//   F) negation safety: "we did NOT hardcode" reads as rejection, not acceptance
//   G) ground-truth override: ps_fork.curveball_id + marker arrays are honored
//
// The family is DORMANT (catalog_visible=false): these synthetic playthroughs
// are the only sessions that exercise the detectors until activation.
//
// Run: pnpm exec tsx scripts/verify-family2-units.ts
import {
  runDetectors,
  DETECTOR_VERSION,
  PS_FORK_COMPETENCY,
  type EventRow,
  type EvidenceUnit,
} from "../src/services/evidence-extractor.js";

const SLUG = "fde-api-integration";
const GT: Record<string, unknown> = {}; // detectors must work with contract defaults

let failures = 0;
function fail(m: string): void { failures++; console.error("  FAIL:", m); }
function pass(m: string): void { console.log("  PASS:", m); }

function ev(seq: number, type: string, payload: Record<string, unknown>, actor = "candidate"): EventRow {
  return { seq, type, actor, payload };
}
const forkEv = ev(10, "curveball.fired", { curveball_id: "hardcode_workaround" }, "system");

function psUnits(units: EvidenceUnit[]): EvidenceUnit[] {
  return units.filter((u) => u.kind.startsWith("ps_fork_"));
}
function byKind(units: EvidenceUnit[], kind: string): EvidenceUnit | undefined {
  return units.find((u) => u.kind === kind);
}
function assertDissociable(units: EvidenceUnit[], label: string): void {
  const leaked = psUnits(units).filter((u) => u.competency_key !== PS_FORK_COMPETENCY);
  if (leaked.length === 0) {
    pass(`${label}: all ps_fork_* units bind ${PS_FORK_COMPETENCY} (never teamwork)`);
  } else {
    fail(`${label}: ps_fork_* leaked to ${leaked.map((u) => u.competency_key).join(",")}`);
  }
  if (psUnits(units).some((u) => u.competency_key === "teamwork")) {
    fail(`${label}: ps_fork_* unit carries teamwork — dissociability broken`);
  }
}

console.log(`verify-family2-units — P3.2 (fde-api-integration detectors, detector_version ${DETECTOR_VERSION})\n`);

if (DETECTOR_VERSION !== "3") fail(`DETECTOR_VERSION expected "3", got "${DETECTOR_VERSION}"`);
if (PS_FORK_COMPETENCY === "teamwork") fail("PS_FORK_COMPETENCY must never be teamwork");

// ── A) fork rejected: robust fix shipped + user-impact reasoning (HIGH PS) ───
{
  console.log("[A] fork rejected — robust fix + reasoning (high PS)");
  const events = [
    forkEv,
    ev(11, "message.team.candidate", {
      text: "hardcoding the response would silently break edge-case users on annual plans — I'd rather fix the root cause: the cursor pagination and the token refresh.",
    }),
    ev(12, "deliverable.submit", {
      data: {
        root_cause_finding: "The client stopped refreshing the access token and only read the first page after the API moved to cursor pagination.",
        fix_summary: "Implemented token refresh and cursor pagination with retries and an idempotency key so the sync is correct for all customers.",
      },
    }),
  ];
  const u = runDetectors(SLUG, events, GT);
  const prot = byKind(u, "ps_fork_user_protected");
  const taken = byKind(u, "ps_fork_shortcut_taken");
  const reason = byKind(u, "ps_fork_reasoning_present");
  if ((prot?.value as { protected?: boolean })?.protected === true) pass("ps_fork_user_protected.protected = true"); else fail(`user_protected = ${JSON.stringify(prot?.value)}`);
  if ((taken?.value as { taken?: boolean })?.taken === false) pass("ps_fork_shortcut_taken.taken = false"); else fail(`shortcut_taken = ${JSON.stringify(taken?.value)}`);
  if (reason?.value === true) pass("ps_fork_reasoning_present = true"); else fail(`reasoning_present = ${JSON.stringify(reason?.value)}`);
  if (JSON.stringify(prot?.event_seqs) === JSON.stringify([10, 12])) pass("user_protected event_seqs = [fork, submit] = [10,12]"); else fail(`user_protected seqs = ${JSON.stringify(prot?.event_seqs)}`);
  if (JSON.stringify(reason?.event_seqs) === JSON.stringify([11])) pass("reasoning_present event_seqs = [11]"); else fail(`reasoning seqs = ${JSON.stringify(reason?.event_seqs)}`);
  assertDissociable(u, "A");
}

// ── B) fork accepted: hardcoded workaround shipped, no reasoning (LOW PS) ────
{
  console.log("\n[B] fork accepted — hardcoded workaround shipped (low PS)");
  const events = [
    forkEv,
    ev(11, "deliverable.submit", {
      data: {
        root_cause_finding: "The vendor API is returning unexpected values for some accounts.",
        fix_summary: "Shipped the hardcoded expected response for the failing account as a workaround so the demo works today.",
      },
    }),
  ];
  const u = runDetectors(SLUG, events, GT);
  const prot = byKind(u, "ps_fork_user_protected");
  const taken = byKind(u, "ps_fork_shortcut_taken");
  const reason = byKind(u, "ps_fork_reasoning_present");
  if ((taken?.value as { taken?: boolean })?.taken === true) pass("ps_fork_shortcut_taken.taken = true"); else fail(`shortcut_taken = ${JSON.stringify(taken?.value)}`);
  if ((prot?.value as { protected?: boolean })?.protected === false) pass("ps_fork_user_protected.protected = false"); else fail(`user_protected = ${JSON.stringify(prot?.value)}`);
  if (reason?.value === false) pass("ps_fork_reasoning_present = false"); else fail(`reasoning_present = ${JSON.stringify(reason?.value)}`);
  assertDissociable(u, "B");
}

// ── B2) mixed: hardcode shipped ALONGSIDE a partial fix still reads as taken ─
{
  console.log("\n[B2] hardcode + partial fix alongside — still shortcut_taken (P3.4 weak playthrough phrasing)");
  const events = [
    forkEv,
    ev(11, "deliverable.submit", {
      data: {
        fix_summary: "We patched the sync with a hardcoded fallback and refreshed the tokens, so the numbers look right for the demo.",
        decisions_and_tradeoffs: "n/a — shipped the quick hardcoded workaround the team suggested to save time.",
      },
    }),
  ];
  const u = runDetectors(SLUG, events, GT);
  const prot = byKind(u, "ps_fork_user_protected");
  const taken = byKind(u, "ps_fork_shortcut_taken");
  if ((taken?.value as { taken?: boolean })?.taken === true) pass("affirmed hardcode counts as taken despite partial robust markers"); else fail(`shortcut_taken = ${JSON.stringify(taken?.value)}`);
  if ((prot?.value as { protected?: boolean })?.protected === false) pass("partial fix + hack is NOT user-protected"); else fail(`user_protected = ${JSON.stringify(prot?.value)}`);
  assertDissociable(u, "B2");
}

// ── C) fork never fired → no ps_fork units at all ────────────────────────────
{
  console.log("\n[C] fork not presented");
  const events = [
    ev(1, "deliverable.submit", { data: { fix_summary: "Implemented cursor pagination and token refresh." } }),
  ];
  const u = runDetectors(SLUG, events, GT);
  if (psUnits(u).length === 0) pass("no ps_fork_* units when the fork beat never fired"); else fail(`emitted ${psUnits(u).length} ps_fork units without the fork`);
  // sanity: family-2 domain detectors still ran
  if (u.some((x) => x.kind === "api_pagination_handled")) pass("domain detectors still run without the fork"); else fail("domain detectors did not run");
}

// ── D) domain detectors fire with the right seqs ─────────────────────────────
{
  console.log("\n[D] domain detectors (auth / pagination / retry / contract drift)");
  const events = [
    ev(1, "message.client.candidate", { text: "Which sync started failing, and did anything change on the vendor side recently?" }),
    ev(2, "db.query", { sql: "SELECT status_code, COUNT(*) FROM api_request_log WHERE status_code = 401 GROUP BY status_code", status: "ok", row_count: 1 }),
    ev(3, "ai.assistant.candidate", { text: "The vendor returns has_more=true with a next_page cursor — what is the standard pagination loop?" }),
    ev(4, "message.team.candidate", { text: "root cause: the response schema changed — they renamed a field in v2 and our parser drops it; also we never retry on 429 and have no idempotency key." }),
    ev(5, "deliverable.submit", { data: { fix_summary: "Refreshed the expired token, added cursor pagination, retries with exponential backoff, and tolerant parsing for the renamed field." } }),
  ];
  const u = runDetectors(SLUG, events, GT);
  const checks: Array<[string, string, number[]]> = [
    ["api_auth_fix_evidence", "execution", [2, 5]],
    ["api_pagination_handled", "data_fluency", [3, 5]],
    ["api_retry_idempotency_handled", "design_under_constraints", [4, 5]],
    ["api_contract_drift_diagnosed", "data_fluency", [4, 5]],
  ];
  for (const [kind, competency, seqs] of checks) {
    const x = byKind(u, kind);
    const present = (x?.value as { present?: boolean })?.present;
    if (present === true) pass(`${kind}.present = true`); else fail(`${kind} = ${JSON.stringify(x?.value)}`);
    if (x?.competency_key === competency) pass(`${kind} → ${competency}`); else fail(`${kind} bound to ${x?.competency_key}, expected ${competency}`);
    if (JSON.stringify(x?.event_seqs) === JSON.stringify(seqs)) pass(`${kind} event_seqs = ${JSON.stringify(seqs)}`); else fail(`${kind} seqs = ${JSON.stringify(x?.event_seqs)}, expected ${JSON.stringify(seqs)}`);
  }
}

// ── E) negation safety — rejecting the hardcode is NOT taking it ─────────────
{
  console.log("\n[E] negation window — 'did not hardcode' reads as rejection");
  const events = [
    forkEv,
    ev(11, "deliverable.submit", {
      data: {
        fix_summary: "We did not hardcode the response; instead of a workaround we fixed the cursor pagination and token refresh for all customers.",
      },
    }),
  ];
  const u = runDetectors(SLUG, events, GT);
  const prot = byKind(u, "ps_fork_user_protected");
  const taken = byKind(u, "ps_fork_shortcut_taken");
  if ((taken?.value as { taken?: boolean })?.taken === false) pass("negated shortcut mention does NOT count as taken"); else fail(`shortcut_taken = ${JSON.stringify(taken?.value)}`);
  if ((prot?.value as { protected?: boolean })?.protected === true) pass("robust fix still reads as user-protected"); else fail(`user_protected = ${JSON.stringify(prot?.value)}`);
}

// ── F) ground-truth contract overrides (curveball_id + markers) ──────────────
{
  console.log("\n[F] ground_truth.ps_fork overrides honored");
  const gt = {
    ps_fork: {
      curveball_id: "pin_the_response",
      shortcut_markers: ["pinned the payload"],
      robust_markers: ["replayed the delta feed"],
    },
  };
  const events = [
    ev(10, "curveball.fired", { curveball_id: "pin_the_response" }, "system"),
    ev(11, "deliverable.submit", { data: { fix_summary: "We pinned the payload for the failing tenant to unblock the release." } }),
  ];
  const u = runDetectors(SLUG, events, gt);
  const taken = byKind(u, "ps_fork_shortcut_taken");
  if ((taken?.value as { taken?: boolean })?.taken === true) pass("override curveball_id + shortcut_markers detected acceptance"); else fail(`override path: shortcut_taken = ${JSON.stringify(taken?.value)}`);
  // default id must NOT fire under the override
  const uDefault = runDetectors(SLUG, [forkEv, events[1]!], gt);
  if (psUnits(uDefault).length === 0) pass("default curveball id ignored when gt overrides it"); else fail("default curveball id fired despite gt override");
  assertDissociable(u, "F");
}

// ── G) family-2 detectors are inert on family-1 slugs (spot check) ───────────
{
  console.log("\n[G] family-2 detectors do not fire for fde-db-triage slugs");
  const events = [
    forkEv,
    ev(11, "deliverable.submit", { data: { fix_summary: "hardcoded workaround with pagination and retries" } }),
  ];
  const u = runDetectors("fde-db-triage", events, GT);
  const fam2 = u.filter((x) => x.kind.startsWith("api_") || x.kind.startsWith("ps_fork_"));
  // ps_fork_* here would need family 1's shortcut_suggestion id — hardcode_workaround must not trigger it either
  if (fam2.length === 0) pass("no api_* / ps_fork_* units on a family-1 slug from family-2 events"); else fail(`family-2 detectors fired on family 1: ${fam2.map((x) => x.kind).join(",")}`);
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
process.exit(failures === 0 ? 0 : 1);
