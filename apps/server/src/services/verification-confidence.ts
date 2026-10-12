// Verification pipeline (slice V5) — deterministic verification-confidence
// score over the informational channels.
//
// THE FRAMING RULE (product + legal): this is "verification confidence WITH
// EVIDENCE", never "fraud detected". It aggregates positive identity/
// continuity/environment evidence into 0–100, with every component carrying
// the event seqs a reviewer can click. A LOW score means "little evidence the
// work is verified", not "cheating" — v1 sessions without camera consent are
// mostly NOT_ASSESSED, and the score normalizes over what was assessable.
//
// Same architecture as suspicion-score.ts: pure function, no I/O, versioned,
// recomputable on demand over the durable event stream, directly testable.
//
// ISOLATION (the same load-bearing rule as suspicion): this score reads the
// integrity.*/identity.* informational channels exclusively and MUST NOT feed
// evidence_units, evaluations, or any competency score (mirror guard in
// evidence-extractor.ts). Recruiter-facing with component breakdown; the
// public shared report gets {score, assessed_max, version} only.

/** Bump when component logic/weights change — scores across versions are not
 *  comparable (same convention as SUSPICION_DETECTOR_VERSION). */
export const VERIFICATION_CONFIDENCE_VERSION = "1";

/** Default continuity match floor — mirrors env.FACE_MATCH_THRESHOLD's
 *  default; the route passes the live env value. */
export const DEFAULT_FACE_MATCH_THRESHOLD = 0.32;

export interface ConfidenceComponent {
  kind: string;
  /** Points earned (0..max) — 0 when not_assessed. */
  points: number;
  max: number;
  status: "assessed" | "not_assessed";
  /** Event seqs a reviewer can click to see the underlying evidence. */
  evidence_seqs: number[];
  /** One-line reviewer-facing note ("12/12 continuity samples matched"). */
  note: string;
}

export interface VerificationConfidence {
  /** 0–100, normalized over ASSESSED components only (null when nothing was
   *  assessable — a pre-pipeline session). */
  score: number | null;
  /** Sum of max over assessed components — the denominator behind `score`.
   *  Lets a reviewer tell "90 of a fully-assessed 100" from "90 of 30". */
  assessed_max: number;
  points: number;
  components: ConfidenceComponent[];
  version: string;
}

/** Same minimal event shape as SuspicionEventInput (review route row subset). */
export interface ConfidenceEventInput {
  seq: number;
  type: string;
  ts: string;
  payload: Record<string, unknown> | null;
}

/** Identity block as produced by proctoring-v2.readIdentityStatus. */
export interface ConfidenceIdentityInput {
  verified: boolean | null;
  matchConfidence: number | null;
}

/** BGV summary (slice V9 feeds this; null until then / when not run). */
export interface ConfidenceBgvInput {
  status: "complete" | "pending" | "failed";
  /** True when every requested check came back without discrepancy. */
  clear: boolean | null;
}

export const CONFIDENCE_MAX = {
  identity_verified: 30,
  continuity: 25,
  environment: 10,
  paste_provenance: 10,
  geo_consistency: 10,
  typing_stability: 10,
  bgv: 5,
} as const;

interface Options {
  faceMatchThreshold?: number;
  identity?: ConfidenceIdentityInput | null;
  bgv?: ConfidenceBgvInput | null;
}

/**
 * Deterministic verification confidence. Ignores every non-informational
 * event type, so callers can feed the whole event stream.
 */
export function computeVerificationConfidence(
  events: ConfidenceEventInput[],
  opts: Options = {},
): VerificationConfidence {
  const threshold = opts.faceMatchThreshold ?? DEFAULT_FACE_MATCH_THRESHOLD;
  const identity = opts.identity ?? null;
  const bgv = opts.bgv ?? null;

  const info = events
    .filter(
      (e) =>
        typeof e.type === "string" &&
        (e.type.startsWith("integrity.") || e.type.startsWith("identity.")),
    )
    .slice()
    .sort((a, b) => a.seq - b.seq);

  const seqsOf = (pred: (e: ConfidenceEventInput) => boolean): number[] =>
    info.filter(pred).map((e) => e.seq);

  const components: ConfidenceComponent[] = [];
  const add = (c: ConfidenceComponent): void => { components.push(c); };

  // ── identity_verified (0–30, scaled by match confidence) ─────────────────
  {
    const max = CONFIDENCE_MAX.identity_verified;
    const verifiedSeqs = seqsOf((e) => e.type === "identity.verified");
    if (identity === null || identity.verified === null) {
      add({ kind: "identity_verified", points: 0, max, status: "not_assessed", evidence_seqs: verifiedSeqs, note: "identity verification not attempted" });
    } else if (!identity.verified) {
      add({ kind: "identity_verified", points: 0, max, status: "assessed", evidence_seqs: verifiedSeqs, note: "ID↔selfie match below threshold" });
    } else {
      const conf = identity.matchConfidence ?? 0.8;
      const points = Math.round(max * Math.max(0, Math.min(1, conf)));
      add({ kind: "identity_verified", points, max, status: "assessed", evidence_seqs: verifiedSeqs, note: `ID↔selfie verified (confidence ${conf.toFixed(2)})` });
    }
  }

  // ── continuity (0–25, fraction of samples at/above threshold) ────────────
  {
    const max = CONFIDENCE_MAX.continuity;
    const matches = info.filter((e) => e.type === "integrity.face_match");
    if (matches.length === 0) {
      add({ kind: "continuity", points: 0, max, status: "not_assessed", evidence_seqs: [], note: "no continuity samples (not enrolled or v1 session)" });
    } else {
      const good = matches.filter((e) => {
        const s = e.payload?.["similarity"];
        return typeof s === "number" && s >= threshold;
      }).length;
      const points = Math.round((max * good) / matches.length);
      add({
        kind: "continuity", points, max, status: "assessed",
        evidence_seqs: matches.map((e) => e.seq),
        note: `${good}/${matches.length} continuity samples matched the enrolment anchor`,
      });
    }
  }

  // ── environment (0–10) — always assessable (v1 passive capture) ──────────
  {
    const max = CONFIDENCE_MAX.environment;
    const vcam = seqsOf((e) => e.type === "integrity.virtual_camera");
    const display = seqsOf(
      (e) => e.type === "integrity.display_change" && e.payload?.["extended"] === true,
    );
    let points: number = max;
    let note = "no environment anomalies";
    if (vcam.length > 0) {
      points = 0;
      note = "virtual camera device detected";
    } else if (display.length > 0) {
      points = Math.round(max / 2);
      note = "extended display present";
    }
    add({ kind: "environment", points, max, status: "assessed", evidence_seqs: [...vcam, ...display], note });
  }

  // ── paste_provenance (0–10) ───────────────────────────────────────────────
  {
    const max = CONFIDENCE_MAX.paste_provenance;
    const pastes = info.filter((e) => e.type === "integrity.paste_burst");
    const withProv = pastes.filter((e) => typeof e.payload?.["provenance"] === "string");
    const external = withProv.filter((e) => e.payload?.["provenance"] === "external");
    if (pastes.length > 0 && withProv.length === 0) {
      // Pre-v5 client: pastes happened but none carry provenance — can't judge.
      add({ kind: "paste_provenance", points: 0, max, status: "not_assessed", evidence_seqs: [], note: "pastes predate provenance classification" });
    } else {
      const points = external.length === 0 ? max : external.length === 1 ? Math.round(max / 2) : 0;
      const note =
        external.length === 0
          ? pastes.length === 0
            ? "no large pastes"
            : "all large pastes traced to in-workspace sources"
          : `${external.length} large paste(s) from outside the workspace`;
      add({ kind: "paste_provenance", points, max, status: "assessed", evidence_seqs: external.map((e) => e.seq), note });
    }
  }

  // ── geo_consistency (0–10) ────────────────────────────────────────────────
  {
    const max = CONFIDENCE_MAX.geo_consistency;
    const geo = info.filter((e) => e.type === "integrity.geo");
    if (geo.length === 0) {
      add({ kind: "geo_consistency", points: 0, max, status: "not_assessed", evidence_seqs: [], note: "no network observations (pre-slice session)" });
    } else {
      const ipChanges = info.filter((e) => e.type === "integrity.ip_change");
      const countryChanges = ipChanges.filter((e) => e.payload?.["country_changed"] === true);
      let points: number;
      if (countryChanges.length > 0) points = 0;
      else points = Math.max(0, max - 3 * ipChanges.length);
      const note =
        countryChanges.length > 0
          ? "country changed mid-session"
          : ipChanges.length > 0
            ? `${ipChanges.length} IP change(s), same country`
            : "stable network location";
      add({
        kind: "geo_consistency", points, max, status: "assessed",
        evidence_seqs: [...geo.map((e) => e.seq), ...ipChanges.map((e) => e.seq)],
        note,
      });
    }
  }

  // ── typing_stability (0–10) ───────────────────────────────────────────────
  {
    const max = CONFIDENCE_MAX.typing_stability;
    const windows = seqsOf((e) => e.type === "integrity.typing_window");
    const drifts = seqsOf((e) => e.type === "integrity.typing_drift");
    if (windows.length === 0) {
      add({ kind: "typing_stability", points: 0, max, status: "not_assessed", evidence_seqs: [], note: "no typing-rhythm capture (v1 session)" });
    } else {
      add({
        kind: "typing_stability",
        points: drifts.length === 0 ? max : 0,
        max,
        status: "assessed",
        evidence_seqs: drifts,
        note: drifts.length === 0 ? "typing rhythm consistent throughout" : "typing rhythm step change detected",
      });
    }
  }

  // ── bgv (0–5) ─────────────────────────────────────────────────────────────
  {
    const max = CONFIDENCE_MAX.bgv;
    if (bgv === null || bgv.status !== "complete" || bgv.clear === null) {
      add({ kind: "bgv", points: 0, max, status: "not_assessed", evidence_seqs: [], note: "no completed background verification" });
    } else {
      add({
        kind: "bgv",
        points: bgv.clear ? max : 0,
        max,
        status: "assessed",
        evidence_seqs: [],
        note: bgv.clear ? "claims verification clear" : "claims verification discrepancy",
      });
    }
  }

  const assessed = components.filter((c) => c.status === "assessed");
  const assessedMax = assessed.reduce((s, c) => s + c.max, 0);
  const points = assessed.reduce((s, c) => s + c.points, 0);
  const score = assessedMax > 0 ? Math.round((100 * points) / assessedMax) : null;

  return {
    score,
    assessed_max: assessedMax,
    points,
    components,
    version: VERIFICATION_CONFIDENCE_VERSION,
  };
}
