/**
 * verify-suspicion-v5.ts — verification slice (detector v5) acceptance.
 *
 * Deterministic, infra-light (no server, no sandbox, no LLM): exercises the
 * v5 additions to computeSuspicionScore():
 *   - paste provenance: ONLY provenance:"external" bursts score; internal /
 *     unknown / absent (pre-v5 clients) contribute 0;
 *   - display_change: counts transitions INTO extended state only;
 *   - virtual_camera: capped at one firing's worth of points;
 *   - face_mismatch / typing_drift: reserved factors count their events;
 *   - isolation: v5 event types never produce evidence units.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-suspicion-v5.ts
 */
import {
  computeSuspicionScore,
  SUSPICION_DETECTOR_VERSION,
  SUSPICION_WEIGHTS,
  type SuspicionEventInput,
} from "../src/services/suspicion-score.js";
import { runDetectors, type EventRow } from "../src/services/evidence-extractor.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

const T0 = Date.parse("2026-10-11T10:00:00.000Z");
let seq = 0;
function ev(
  type: string,
  offsetMs: number,
  payload: Record<string, unknown> = {},
): SuspicionEventInput {
  return { seq: seq++, type, ts: new Date(T0 + offsetMs).toISOString(), payload };
}

console.log("verify-suspicion-v5 — verification slice");
console.log(`suspicion detector version: ${SUSPICION_DETECTOR_VERSION}\n`);

check("detector version is 5", SUSPICION_DETECTOR_VERSION === "5");
check(
  "v5 factors present in the weight table",
  "display_change" in SUSPICION_WEIGHTS &&
    "virtual_camera" in SUSPICION_WEIGHTS &&
    "paste_external" in SUSPICION_WEIGHTS &&
    "face_mismatch" in SUSPICION_WEIGHTS &&
    "typing_drift" in SUSPICION_WEIGHTS,
);

// ── [a] paste provenance ─────────────────────────────────────────────────────
{
  console.log("\n[a] paste provenance");
  const events = [
    ev("integrity.paste_burst", 1_000, { chars: 900, target: "editor", provenance: "internal" }),
    ev("integrity.paste_burst", 2_000, { chars: 900, target: "editor", provenance: "unknown" }),
    ev("integrity.paste_burst", 3_000, { chars: 900, target: "editor" }), // pre-v5 client
    ev("integrity.paste_burst", 4_000, { chars: 900, target: "chat", provenance: "external" }),
    ev("integrity.paste_burst", 5_000, { chars: 500, target: "editor", provenance: "external" }),
  ];
  const r = computeSuspicionScore(events);
  const pf = r.factors.find((f) => f.kind === "paste_external");
  check("external pastes counted", pf?.count === 2, `count=${pf?.count}`);
  check(
    "score = 2 × paste_external weight",
    r.score === 2 * SUSPICION_WEIGHTS.paste_external.weight,
    `score=${r.score}`,
  );
  check(
    "internal/unknown/absent provenance contribute nothing",
    r.factors.every((f) => f.kind === "paste_external"),
    `factors=${r.factors.map((f) => f.kind).join(",")}`,
  );

  // Cap: a storm of external pastes can't exceed the factor cap.
  const storm = Array.from({ length: 20 }, (_, i) =>
    ev("integrity.paste_burst", 10_000 + i * 1000, {
      chars: 900, target: "editor", provenance: "external",
    }),
  );
  const rs = computeSuspicionScore(storm);
  check(
    "external paste storm capped",
    rs.score === SUSPICION_WEIGHTS.paste_external.cap,
    `score=${rs.score}`,
  );
}

// ── [b] display_change ───────────────────────────────────────────────────────
{
  console.log("\n[b] display_change");
  const events = [
    ev("integrity.display_change", 1_000, { extended: true }),   // counts
    ev("integrity.display_change", 60_000, { extended: false }), // collapse — no signal
    ev("integrity.display_change", 120_000, { extended: true }), // counts
  ];
  const r = computeSuspicionScore(events);
  const f = r.factors.find((x) => x.kind === "display_change");
  check("only extended=true transitions count", f?.count === 2, `count=${f?.count}`);
  check(
    "contribution respects cap",
    (f?.contribution ?? 0) === Math.min(2 * SUSPICION_WEIGHTS.display_change.weight, SUSPICION_WEIGHTS.display_change.cap),
  );
}

// ── [c] virtual_camera / face_mismatch / typing_drift ───────────────────────
{
  console.log("\n[c] virtual_camera + reserved continuity factors");
  const events = [
    ev("integrity.virtual_camera", 1_000, { label_class: "obs" }),
    ev("integrity.face_mismatch", 60_000),
    ev("integrity.face_mismatch", 120_000),
    ev("integrity.typing_drift", 180_000),
  ];
  const r = computeSuspicionScore(events);
  const vc = r.factors.find((x) => x.kind === "virtual_camera");
  const fm = r.factors.find((x) => x.kind === "face_mismatch");
  const td = r.factors.find((x) => x.kind === "typing_drift");
  check("virtual_camera counted", vc?.count === 1 && vc.contribution === SUSPICION_WEIGHTS.virtual_camera.weight);
  check("face_mismatch counted", fm?.count === 2, `count=${fm?.count}`);
  check("typing_drift counted", td?.count === 1, `count=${td?.count}`);
  const expected =
    SUSPICION_WEIGHTS.virtual_camera.weight +
    Math.min(2 * SUSPICION_WEIGHTS.face_mismatch.weight, SUSPICION_WEIGHTS.face_mismatch.cap) +
    SUSPICION_WEIGHTS.typing_drift.weight;
  check("contributions sum to score", r.score === Math.min(100, expected), `score=${r.score}`);
}

// ── [d] isolation — v5 events never become evidence ─────────────────────────
{
  console.log("\n[d] isolation from competency evidence");
  const rows: EventRow[] = [
    { seq: 1, type: "integrity.paste_burst", actor: "candidate", ts: new Date(T0).toISOString(), payload: { chars: 900, target: "editor", provenance: "external" } },
    { seq: 2, type: "integrity.display_change", actor: "candidate", ts: new Date(T0 + 1000).toISOString(), payload: { extended: true } },
    { seq: 3, type: "integrity.virtual_camera", actor: "candidate", ts: new Date(T0 + 2000).toISOString(), payload: { label_class: "obs" } },
    { seq: 4, type: "integrity.face_mismatch", actor: "candidate", ts: new Date(T0 + 3000).toISOString(), payload: {} },
    { seq: 5, type: "integrity.typing_drift", actor: "system", ts: new Date(T0 + 4000).toISOString(), payload: {} },
  ];
  // Mirror verify-suspicion-score.ts's isolation contract: agnostic detectors
  // may emit zero-count/absence units on any stream — the invariant is that no
  // unit CITES a v5 integrity seq and the unit set is identical with/without
  // the proctoring events (measurement-neutral).
  const v5Seqs = rows.map((r) => r.seq);
  const unitsClean = runDetectors("fde-db-triage", [], {});
  const unitsMixed = runDetectors("fde-db-triage", rows, {});
  check(
    "zero evidence units cite v5 integrity seqs",
    !unitsMixed.some((u) => u.event_seqs.some((s) => v5Seqs.includes(s))),
  );
  check(
    "units identical with/without v5 events (measurement-neutral)",
    JSON.stringify(unitsClean) === JSON.stringify(unitsMixed),
  );
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
