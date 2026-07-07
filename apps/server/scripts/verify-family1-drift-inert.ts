// verify-family1-drift-inert.ts — P3.2 drift-boundary assertion (no infra).
//
// The v3 detector bump adds family-2 (fde-api-integration) detectors that MUST
// be inert on family 1: re-scoring any fde-db-triage* session yields units
// byte-identical to v2 behavior modulo the detector_version stamp.
//
// Method: fixtures/family1-drift/ holds a frozen synthetic family-1 event
// stream (exercising every detector tier — agnostic, verification,
// fde-db-triage-specific, ps-fork, plus an integrity.* event that must stay
// filtered) and the unit list CAPTURED FROM THE v2 CODE before the v3 edits
// landed. This script re-runs the FULL v3 pipeline (runDetectors — the single
// entry point every extraction path flows through) over the same stream and
// asserts deep equality after normalizing detector_version. Any family-2
// detector firing on a family-1 slug shows up as an extra/changed unit and
// fails the byte-diff.
//
// Also spot-checks a family-2-bait stream under a family-1 slug: events full of
// API-integration vocabulary + the family-2 fork curveball must produce ZERO
// api_* / family-2 ps_fork_* units when the slug is fde-db-triage*.
//
// Run: pnpm exec tsx scripts/verify-family1-drift-inert.ts
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import {
  runDetectors,
  DETECTOR_VERSION,
  type EventRow,
  type EvidenceUnit,
} from "../src/services/evidence-extractor.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

let failures = 0;
function fail(m: string): void { failures++; console.error("  FAIL:", m); }
function pass(m: string): void { console.log("  PASS:", m); }

const fixture = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures/family1-drift/events.json"), "utf8"),
) as { slug: string; events: EventRow[] };
const baseline = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures/family1-drift/baseline-units-v2.json"), "utf8"),
) as { detector_version: string; units: EvidenceUnit[] };
const gt = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures/fde-db-triage/ground_truth.json"), "utf8"),
) as Record<string, unknown>;

console.log(`verify-family1-drift-inert — P3.2 (v${baseline.detector_version} → v${DETECTOR_VERSION} drift boundary)\n`);

// ── A) full-pipeline byte-diff modulo the detector_version stamp ─────────────
{
  console.log(`[A] family-1 re-score identical modulo detector_version (slug=${fixture.slug})`);
  if (baseline.detector_version !== "2") {
    fail(`baseline fixture captured at v${baseline.detector_version}, expected v2 — regenerate invalidates the assertion`);
  }
  const current = runDetectors(fixture.slug, fixture.events, gt);

  // Normalize ONLY the detector_version stamp; everything else must be byte-equal.
  const strip = (units: EvidenceUnit[]): string =>
    JSON.stringify(units.map((u) => ({ ...u, detector_version: "<stamp>" })));
  const expected = strip(baseline.units);
  const actual = strip(current);

  if (actual === expected) {
    pass(`v${DETECTOR_VERSION} units byte-identical to v2 baseline modulo stamp (${current.length} units)`);
  } else {
    fail("unit drift on family 1 — v3 output differs from the v2 baseline beyond the version stamp");
    const baseKinds = baseline.units.map((u) => `${u.competency_key}/${u.kind}`);
    const currKinds = current.map((u) => `${u.competency_key}/${u.kind}`);
    const added = currKinds.filter((k) => !baseKinds.includes(k));
    const removed = baseKinds.filter((k) => !currKinds.includes(k));
    if (added.length) console.error("    added units:  ", added.join(", "));
    if (removed.length) console.error("    removed units:", removed.join(", "));
    if (!added.length && !removed.length) {
      for (let i = 0; i < Math.max(baseline.units.length, current.length); i++) {
        const b = JSON.stringify({ ...baseline.units[i], detector_version: "<stamp>" });
        const c = JSON.stringify({ ...current[i], detector_version: "<stamp>" });
        if (b !== c) console.error(`    first diff at unit ${i}:\n      v2: ${b}\n      v3: ${c}`);
      }
    }
  }

  // Every emitted unit carries the NEW stamp (re-score is a clean v3 pass).
  if (current.every((u) => u.detector_version === DETECTOR_VERSION)) {
    pass(`all units stamped detector_version=${DETECTOR_VERSION}`);
  } else {
    fail("mixed detector_version stamps in a single pass");
  }

  // Belt-and-braces: no family-2 unit kind on a family-1 slug.
  const fam2 = current.filter((u) => u.kind.startsWith("api_"));
  if (fam2.length === 0) pass("no api_* units on the family-1 stream"); else fail(`family-2 units on family 1: ${fam2.map((u) => u.kind).join(",")}`);
}

// ── B) family-2 bait under a family-1 slug stays inert ───────────────────────
{
  console.log("\n[B] family-2 vocabulary + family-2 fork curveball on a family-1 slug");
  const bait: EventRow[] = [
    { seq: 1, type: "curveball.fired", actor: "system", payload: { curveball_id: "hardcode_workaround" } },
    { seq: 2, type: "message.team.candidate", actor: "candidate", payload: { text: "expired token, 401s, cursor pagination, retries with backoff, idempotency key, the response schema changed" } },
    { seq: 3, type: "deliverable.submit", actor: "candidate", payload: { data: { fix_summary: "hardcoded workaround pinned the response; also pagination and token refresh" } } },
  ];
  for (const slug of ["fde-db-triage", "fde-db-triage-iso", "fde-db-triage-pro", "fde-db-triage-fork"]) {
    const u = runDetectors(slug, bait, gt);
    const fam2 = u.filter((x) => x.kind.startsWith("api_") || x.kind.startsWith("ps_fork_"));
    // family 1's own ps_fork detectors gate on curveball_id=shortcut_suggestion,
    // so even ps_fork_* must be absent here.
    if (fam2.length === 0) pass(`${slug}: inert (no api_* / ps_fork_* units)`); else fail(`${slug}: fired ${fam2.map((x) => x.kind).join(",")}`);
  }
}

// ── C) family-2 slug DOES fire on the same bait (gate works both ways) ───────
{
  console.log("\n[C] positive control — same bait under fde-api-integration fires");
  const bait: EventRow[] = [
    { seq: 1, type: "curveball.fired", actor: "system", payload: { curveball_id: "hardcode_workaround" } },
    { seq: 2, type: "deliverable.submit", actor: "candidate", payload: { data: { fix_summary: "shipped the hardcoded workaround for the failing account" } } },
  ];
  const u = runDetectors("fde-api-integration-pro", bait, {});
  if (u.some((x) => x.kind === "ps_fork_shortcut_taken")) pass("family-2 fork detector fires under its own slug prefix"); else fail("family-2 detectors did not fire under fde-api-integration-* — gate too tight");
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
process.exit(failures === 0 ? 0 : 1);
