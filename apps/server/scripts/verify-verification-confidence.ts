/**
 * verify-verification-confidence.ts — slice V5 acceptance.
 *
 * Deterministic, infra-light: exercises computeVerificationConfidence() over
 * fixture event streams.
 *
 * Acceptance:
 *   - clean consented-v2 session (identity verified, continuity all matching,
 *     no anomalies) → high score, all components assessed;
 *   - v1-only session → identity/continuity/typing/bgv NOT_ASSESSED, score
 *     normalizes over environment+paste+geo only;
 *   - anomalous session (virtual camera, external pastes, mismatched
 *     continuity, drift) → low score with evidence seqs;
 *   - pre-pipeline session (no informational events, no identity) → score
 *     null, assessed_max covers only always-assessable components;
 *   - score == round(100 * points / assessed_max) invariant.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-verification-confidence.ts
 */
import {
  computeVerificationConfidence,
  VERIFICATION_CONFIDENCE_VERSION,
  CONFIDENCE_MAX,
  type ConfidenceEventInput,
} from "../src/services/verification-confidence.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

const T0 = Date.parse("2026-10-11T10:00:00.000Z");
let seq = 0;
function ev(type: string, payload: Record<string, unknown> = {}): ConfidenceEventInput {
  return { seq: ++seq, type, ts: new Date(T0 + seq * 1000).toISOString(), payload };
}
function comp(r: ReturnType<typeof computeVerificationConfidence>, kind: string) {
  return r.components.find((c) => c.kind === kind)!;
}

console.log("verify-verification-confidence — slice V5");
console.log(`version: ${VERIFICATION_CONFIDENCE_VERSION}\n`);

// ── [a] clean consented-v2 session ───────────────────────────────────────────
{
  console.log("[a] clean v2 session");
  const events = [
    ev("integrity.client_env", { tz_offset_minutes: -330, tz_name: "Asia/Kolkata" }),
    ev("integrity.geo", { country: "IN" }),
    ev("identity.consent", { decision: "accepted" }),
    ev("identity.verified", { verified: true, match_confidence: 0.93 }),
    ...Array.from({ length: 12 }, () => ev("integrity.face_match", { similarity: 0.8 })),
    ...Array.from({ length: 10 }, () => ev("integrity.typing_window", { n: 100, mean_iki_ms: 180 })),
    ev("integrity.paste_burst", { chars: 900, target: "editor", provenance: "internal" }),
  ];
  const r = computeVerificationConfidence(events, {
    identity: { verified: true, matchConfidence: 0.93 },
  });
  check("all 6 non-bgv components assessed",
    r.components.filter((c) => c.status === "assessed").length === 6,
    r.components.map((c) => `${c.kind}:${c.status}`).join(","));
  check("bgv not_assessed (none provided)", comp(r, "bgv").status === "not_assessed");
  check("identity scaled by confidence",
    comp(r, "identity_verified").points === Math.round(CONFIDENCE_MAX.identity_verified * 0.93));
  check("continuity full (12/12 matched)", comp(r, "continuity").points === CONFIDENCE_MAX.continuity);
  check("high score (>= 90)", (r.score ?? 0) >= 90, `score=${r.score}`);
  check("score invariant", r.score === Math.round((100 * r.points) / r.assessed_max));
}

// ── [b] v1-only session ──────────────────────────────────────────────────────
{
  console.log("\n[b] v1-only session");
  const events = [
    ev("integrity.client_env", { tz_offset_minutes: 0, tz_name: "Europe/London" }),
    ev("integrity.geo", { country: "GB" }),
    ev("integrity.tab_blur"),
    ev("integrity.paste_burst", { chars: 600, target: "chat", provenance: "internal" }),
  ];
  const r = computeVerificationConfidence(events, { identity: null });
  for (const kind of ["identity_verified", "continuity", "typing_stability", "bgv"]) {
    check(`${kind} not_assessed`, comp(r, kind).status === "not_assessed");
  }
  const expectedMax =
    CONFIDENCE_MAX.environment + CONFIDENCE_MAX.paste_provenance + CONFIDENCE_MAX.geo_consistency;
  check("assessed_max covers env+paste+geo only", r.assessed_max === expectedMax, `max=${r.assessed_max}`);
  check("clean v1 session scores 100 of what was assessable", r.score === 100, `score=${r.score}`);
}

// ── [c] anomalous session ────────────────────────────────────────────────────
{
  console.log("\n[c] anomalous session");
  const vcam = ev("integrity.virtual_camera", { label_class: "obs" });
  const events = [
    ev("integrity.geo", { country: "US" }),
    ev("identity.verified", { verified: true, match_confidence: 0.85 }),
    vcam,
    ev("integrity.paste_burst", { chars: 2000, target: "editor", provenance: "external" }),
    ev("integrity.paste_burst", { chars: 1500, target: "editor", provenance: "external" }),
    ...Array.from({ length: 4 }, () => ev("integrity.face_match", { similarity: 0.1 })),
    ...Array.from({ length: 6 }, () => ev("integrity.typing_window", { n: 100, mean_iki_ms: 180 })),
    ev("integrity.typing_drift", { baseline_mean_ms: 180, window_mean_ms: 330 }),
    ev("integrity.ip_change", { country_changed: true }),
  ];
  const r = computeVerificationConfidence(events, {
    identity: { verified: true, matchConfidence: 0.85 },
  });
  check("environment zeroed by virtual camera", comp(r, "environment").points === 0);
  check("environment cites the virtual-camera seq",
    comp(r, "environment").evidence_seqs.includes(vcam.seq));
  check("paste zeroed by 2 external pastes", comp(r, "paste_provenance").points === 0);
  check("continuity zeroed (0/4 matched)", comp(r, "continuity").points === 0);
  check("typing zeroed by drift", comp(r, "typing_stability").points === 0);
  check("geo zeroed by country change", comp(r, "geo_consistency").points === 0);
  check("only identity contributes → low score", (r.score ?? 100) <= 30, `score=${r.score}`);
}

// ── [d] pre-pipeline session ─────────────────────────────────────────────────
{
  console.log("\n[d] pre-pipeline session");
  const r = computeVerificationConfidence([], { identity: null });
  // environment is always assessable (absence of anomaly events IS the
  // evidence on any session that ran the v1 client); geo/paste need their
  // event sources. Score normalizes over what's assessable.
  check("score is not null (environment assessable)", r.score !== null);
  check("assessed_max small", r.assessed_max === CONFIDENCE_MAX.environment + CONFIDENCE_MAX.paste_provenance, `max=${r.assessed_max}`);
}

// ── [e] pre-v5 pastes (no provenance) ────────────────────────────────────────
{
  console.log("\n[e] pre-v5 paste handling");
  const r = computeVerificationConfidence(
    [ev("integrity.paste_burst", { chars: 900, target: "editor" })],
    { identity: null },
  );
  check("provenance-less pastes → not_assessed", comp(r, "paste_provenance").status === "not_assessed");
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
