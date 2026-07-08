/**
 * verify-suspicion-score.ts — P1.2 acceptance.
 *
 * Deterministic, infra-light (no server, no sandbox, no LLM): exercises the
 * pure computeSuspicionScore() aggregation in src/services/suspicion-score.ts
 * plus the CRITICAL isolation rule — integrity.* events must never reach the
 * evidence detectors (evidence-extractor.runDetectors hard-filters them).
 *
 * Acceptance (spec P1.2): noisy run scores high (>60); clean run scores 0;
 * factor contributions sum to the score; zero evidence units reference
 * integrity events.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-suspicion-score.ts
 */
import {
  computeSuspicionScore,
  SUSPICION_DETECTOR_VERSION,
  SUSPICION_WEIGHTS,
  PASTE_CHARS_THRESHOLD,
  IDLE_MS_THRESHOLD,
  type SuspicionEventInput,
} from "../src/services/suspicion-score.js";
import { runDetectors, type EventRow } from "../src/services/evidence-extractor.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

const T0 = Date.parse("2026-07-07T10:00:00.000Z");
let seq = 0;
function ev(
  type: string,
  offsetMs: number,
  payload: Record<string, unknown> = {},
): SuspicionEventInput {
  return { seq: seq++, type, ts: new Date(T0 + offsetMs).toISOString(), payload };
}

console.log("verify-suspicion-score — P1.2");
console.log(`suspicion detector version: ${SUSPICION_DETECTOR_VERSION}\n`);

// ── [a] clean run scores 0 ──
console.log("[a] clean run");
{
  seq = 0;
  const clean = [
    ev("db.query", 0, { sql: "select 1", status: "ok" }),
    ev("message.client.candidate", 1000, { text: "hi" }),
    ev("deliverable.submit", 2000, { data: {} }),
  ];
  const r = computeSuspicionScore(clean);
  check("no integrity events → score 0", r.score === 0, `score=${r.score}`);
  check("no integrity events → no factors", r.factors.length === 0);
  check("version stamped", r.version === SUSPICION_DETECTOR_VERSION);
}
{
  const r = computeSuspicionScore([]);
  check("empty stream → score 0", r.score === 0 && r.factors.length === 0);
}

// ── [b] noisy run scores high (>60) ──
console.log("\n[b] noisy run");
{
  seq = 0;
  const noisy: SuspicionEventInput[] = [];
  // 6 rapid blur/focus pairs inside 60s → blur factor + focus-flurry
  for (let i = 0; i < 6; i++) {
    noisy.push(ev("integrity.tab_blur", i * 8_000));
    noisy.push(ev("integrity.tab_focus", i * 8_000 + 2_000));
  }
  noisy.push(ev("integrity.devtools", 70_000));
  noisy.push(ev("integrity.paste_burst", 80_000, { chars: 2_000, target: "editor" }));
  noisy.push(ev("integrity.paste_burst", 90_000, { chars: 800, target: "chat" }));
  noisy.push(ev("integrity.idle_gap", 100_000, { ms: 300_000 }));
  noisy.push(ev("integrity.copy", 110_000, { source: "brief", chars: 400 }));
  noisy.push(ev("integrity.fullscreen_exit", 120_000));
  const r = computeSuspicionScore(noisy);
  check(`noisy run scores high (>60)`, r.score > 60, `score=${r.score}`);
  check("score clamped to <=100", r.score <= 100, `score=${r.score}`);
  const kinds = r.factors.map((f) => f.kind).sort();
  check(
    "all seven factor kinds fire",
    ["blur", "copy_source", "devtools", "focus_flurry", "fullscreen_exit", "idle_gap", "paste_burst"]
      .every((k) => kinds.includes(k)),
    kinds.join(","),
  );
}

// ── [c] factors sum to score (under the 100 clamp) ──
console.log("\n[c] factor arithmetic");
{
  seq = 0;
  // 2 blurs (2*8=16) + 1 big paste (12) + 1 devtools (15) = 43 — under clamp.
  const mid = [
    ev("integrity.tab_blur", 0),
    ev("integrity.window_blur", 5_000),
    ev("integrity.paste_burst", 10_000, { chars: PASTE_CHARS_THRESHOLD + 100, target: "editor" }),
    ev("integrity.devtools", 20_000),
  ];
  const r = computeSuspicionScore(mid);
  const sum = r.factors.reduce((s, f) => s + f.contribution, 0);
  check("factors sum === score", sum === r.score, `sum=${sum} score=${r.score}`);
  check("expected mid score 43", r.score === 43, `score=${r.score}`);
  for (const f of r.factors) {
    check(
      `${f.kind}: contribution = min(count*weight, cap)`,
      f.contribution ===
        Math.min(f.count * f.weight, SUSPICION_WEIGHTS[f.kind as keyof typeof SUSPICION_WEIGHTS].cap),
    );
  }
}
// per-factor caps hold
{
  seq = 0;
  const blurs: SuspicionEventInput[] = [];
  for (let i = 0; i < 20; i++) blurs.push(ev("integrity.window_blur", i * 90_000));
  const r = computeSuspicionScore(blurs);
  const blur = r.factors.find((f) => f.kind === "blur");
  check("blur contribution capped at 40", blur?.contribution === SUSPICION_WEIGHTS.blur.cap,
    `contribution=${blur?.contribution}`);
}
// rate_capped (server-authored ingest-cap marker) counts as a factor —
// flooding the integrity channel raises suspicion instead of hiding it
{
  seq = 0;
  const one = computeSuspicionScore([ev("integrity.rate_capped", 0)]);
  const f1 = one.factors.find((f) => f.kind === "rate_capped");
  check("rate_capped: 1 marker → contribution 10",
    f1?.count === 1 && f1.contribution === SUSPICION_WEIGHTS.rate_capped.weight,
    JSON.stringify(f1));

  seq = 0;
  const three = computeSuspicionScore([
    ev("integrity.rate_capped", 0),
    ev("integrity.rate_capped", 60_000),
    ev("integrity.rate_capped", 120_000),
  ]);
  const f3 = three.factors.find((f) => f.kind === "rate_capped");
  check("rate_capped: 3 markers → contribution capped at 20",
    f3?.count === 3 && f3.contribution === SUSPICION_WEIGHTS.rate_capped.cap,
    JSON.stringify(f3));
}
// P6.3 webcam-presence factors (detector v2): face_absent / multiple_faces
// count signal-only occurrences (payload optional) and respect their caps.
{
  seq = 0;
  const one = computeSuspicionScore([
    ev("integrity.face_absent", 0),
    ev("integrity.multiple_faces", 10_000, { count: 2 }),
  ]);
  const fa = one.factors.find((f) => f.kind === "face_absent");
  const mf = one.factors.find((f) => f.kind === "multiple_faces");
  check("face_absent: 1 signal → contribution 6",
    fa?.count === 1 && fa.contribution === SUSPICION_WEIGHTS.face_absent.weight,
    JSON.stringify(fa));
  check("multiple_faces: 1 signal → contribution 12",
    mf?.count === 1 && mf.contribution === SUSPICION_WEIGHTS.multiple_faces.weight,
    JSON.stringify(mf));

  seq = 0;
  const many = computeSuspicionScore([
    ...Array.from({ length: 6 }, (_, i) => ev("integrity.face_absent", i * 60_000, { ms: 45_000 })),
    ...Array.from({ length: 5 }, (_, i) => ev("integrity.multiple_faces", i * 60_000 + 5_000)),
  ]);
  const faMany = many.factors.find((f) => f.kind === "face_absent");
  const mfMany = many.factors.find((f) => f.kind === "multiple_faces");
  check("face_absent: 6 signals → capped at 24",
    faMany?.count === 6 && faMany.contribution === SUSPICION_WEIGHTS.face_absent.cap,
    JSON.stringify(faMany));
  check("multiple_faces: 5 signals → capped at 36",
    mfMany?.count === 5 && mfMany.contribution === SUSPICION_WEIGHTS.multiple_faces.cap,
    JSON.stringify(mfMany));
}
// identity.* (P6 consent/verification events) must NOT contribute to the
// suspicion score — it aggregates integrity.* only.
{
  seq = 0;
  const r = computeSuspicionScore([
    ev("identity.consent", 0, { decision: "accepted", consent_text_version: "1" }),
    ev("identity.verified", 1_000, { verified: false, match_confidence: 0.4 }),
  ]);
  check("identity.* events → score 0, no factors", r.score === 0 && r.factors.length === 0,
    JSON.stringify(r));
}

// ── [d] thresholds — sub-threshold events contribute nothing ──
console.log("\n[d] thresholds");
{
  seq = 0;
  const sub = [
    ev("integrity.paste_burst", 0, { chars: PASTE_CHARS_THRESHOLD, target: "editor" }), // not > threshold
    ev("integrity.idle_gap", 1_000, { ms: IDLE_MS_THRESHOLD }),                          // not > threshold
    ev("integrity.copy", 2_000, { source: "other", chars: 900 }),                         // not brief/docs
  ];
  const r = computeSuspicionScore(sub);
  check("sub-threshold paste/idle/copy(other) → score 0", r.score === 0, `score=${r.score}`);
}

// ── [e] focus-flurry boundary — 4 pairs no, 5 pairs yes ──
console.log("\n[e] focus-flurry boundary");
{
  const pairs = (n: number): SuspicionEventInput[] => {
    seq = 0;
    const out: SuspicionEventInput[] = [];
    for (let i = 0; i < n; i++) {
      out.push(ev("integrity.tab_blur", i * 10_000));
      out.push(ev("integrity.tab_focus", i * 10_000 + 1_000));
    }
    return out;
  };
  const four = computeSuspicionScore(pairs(4));
  check("4 pairs in 60s → no flurry factor", !four.factors.some((f) => f.kind === "focus_flurry"));
  const five = computeSuspicionScore(pairs(5));
  const flurry = five.factors.find((f) => f.kind === "focus_flurry");
  check("5 pairs in 60s → 1 flurry (contribution 10)",
    flurry?.count === 1 && flurry.contribution === SUSPICION_WEIGHTS.focus_flurry.weight,
    JSON.stringify(flurry));
}

// ── [f] ISOLATION — integrity.* AND identity.* never reach evidence detectors ──
console.log("\n[f] isolation: integrity.* / identity.* → zero evidence units");
{
  const base: EventRow[] = [
    { seq: 1, type: "db.query", actor: "candidate",
      payload: { sql: "select * from payments", status: "ok", row_count: 10 } },
    { seq: 2, type: "db.query", actor: "candidate",
      payload: { sql: "select count(1) from payments", status: "error", error: "boom" } },
    { seq: 3, type: "message.client.candidate", actor: "candidate", payload: { text: "clarifying" } },
    { seq: 4, type: "deliverable.submit", actor: "candidate",
      payload: { data: { corrected_monthly_revenue: "$1.0M" } } },
  ];
  // integrity.* (P1) + the P6.3 webcam types + identity.* (P6.1/P6.2) — the
  // whole proctoring channel must be invisible to the detectors.
  const proctoringSeqs = [100, 101, 102, 103, 104, 105, 106, 107];
  const withProctoring: EventRow[] = [
    ...base,
    { seq: 100, type: "integrity.tab_blur", actor: "candidate", payload: {} },
    { seq: 101, type: "integrity.paste_burst", actor: "candidate", payload: { chars: 5_000, target: "editor" } },
    { seq: 102, type: "integrity.devtools", actor: "candidate", payload: {} },
    { seq: 103, type: "integrity.copy", actor: "candidate", payload: { source: "brief", chars: 900 } },
    { seq: 104, type: "integrity.face_absent", actor: "candidate", payload: {} },
    { seq: 105, type: "integrity.multiple_faces", actor: "candidate", payload: { count: 2 } },
    { seq: 106, type: "identity.consent", actor: "candidate",
      payload: { decision: "accepted", consent_text_version: "1" } },
    { seq: 107, type: "identity.verified", actor: "system",
      payload: { verified: true, match_confidence: 0.93 } },
  ];

  for (const slug of ["fde-db-triage", "some-other-scenario"]) {
    const unitsClean = runDetectors(slug, base, {});
    const unitsMixed = runDetectors(slug, withProctoring, {});

    const referencesProctoring = unitsMixed.some((u) =>
      u.event_seqs.some((s) => proctoringSeqs.includes(s)));
    check(`[${slug}] zero evidence units reference integrity/identity seqs`, !referencesProctoring);

    const mentionsProctoring = unitsMixed.some((u) =>
      u.kind.includes("integrity") || u.kind.includes("identity") ||
      JSON.stringify(u.value).includes("integrity.") ||
      JSON.stringify(u.value).includes("identity."));
    check(`[${slug}] no unit kind/value mentions integrity/identity`, !mentionsProctoring);

    check(
      `[${slug}] units identical with/without proctoring events (measurement-neutral)`,
      JSON.stringify(unitsClean) === JSON.stringify(unitsMixed),
    );
  }
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed} check(s))`}`);
process.exit(failed === 0 ? 0 : 1);
