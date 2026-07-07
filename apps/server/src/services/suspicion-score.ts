// P1.2 — deterministic suspicion score over integrity.* events.
//
// Aggregates the browser-reported integrity channel (integrity.tab_blur,
// integrity.paste_burst, …) into a 0–100 Suspicion Score plus the weighted
// factors that produced it. Pure function, no I/O — same pattern as
// scorability.ts — so it's recomputable on demand over the durable event
// stream and directly testable by verify-suspicion-score.ts.
//
// ISOLATION (spec P1, critical): this score is an INFORMATIONAL recruiter
// signal only. It reads integrity.* events exclusively and MUST NOT feed
// evidence_units, evaluations, or any competency score. The mirror-image
// guard lives in evidence-extractor.ts (integrity.* is hard-filtered out of
// detector input).

/** Bump when weights/thresholds/factor logic change so stored or displayed
 *  scores can be told apart across versions. */
export const SUSPICION_DETECTOR_VERSION = "1";

export interface SuspicionFactor {
  kind: string;
  /** How many qualifying occurrences were observed. */
  count: number;
  /** Points per occurrence. */
  weight: number;
  /** min(count * weight, cap) — the points this factor added to the score. */
  contribution: number;
}

export interface SuspicionScore {
  /** 0–100; min(100, sum of factor contributions). */
  score: number;
  factors: SuspicionFactor[];
  version: string;
}

/** Minimal event shape — matches the events-table row subset the review
 *  route selects (seq, type, ts, payload). */
export interface SuspicionEventInput {
  seq: number;
  type: string;
  /** ISO 8601 timestamp (events.ts). */
  ts: string;
  payload: Record<string, unknown> | null;
}

// ── Weights & thresholds ────────────────────────────────────────────────────
// CALIBRATION-PENDING defaults (spec P1 open question): proposed for cohort 1,
// expected to be tuned once real cohort data exists. Each factor contributes
// min(count * weight, cap); the total is clamped to 100.
export const SUSPICION_WEIGHTS = {
  blur:            { weight: 8,  cap: 40 }, // tab_blur + window_blur count
  paste_burst:     { weight: 12, cap: 36 }, // paste_burst with chars > PASTE_CHARS_THRESHOLD
  idle_gap:        { weight: 5,  cap: 20 }, // idle_gap with ms > IDLE_MS_THRESHOLD
  devtools:        { weight: 15, cap: 30 }, // best-effort signal — deliberately capped low-ish
  copy_source:     { weight: 6,  cap: 24 }, // copy from brief/docs (candidate exfiltrating prompt material)
  fullscreen_exit: { weight: 4,  cap: 12 },
  focus_flurry:    { weight: 10, cap: 20 }, // >=5 blur/focus pairs inside 60s (tab-cycling)
  rate_capped:     { weight: 10, cap: 20 }, // server-authored ingest-cap marker — flooding raises suspicion, not hides it
} as const;

export const PASTE_CHARS_THRESHOLD = 500;
export const IDLE_MS_THRESHOLD = 120_000;
export const FLURRY_PAIRS = 5;
export const FLURRY_WINDOW_MS = 60_000;

function factor(kind: keyof typeof SUSPICION_WEIGHTS, count: number): SuspicionFactor {
  const { weight, cap } = SUSPICION_WEIGHTS[kind];
  return { kind, count, weight, contribution: Math.min(count * weight, cap) };
}

/** Count focus-flurries: greedy scan over blur timestamps (ms); every run of
 *  FLURRY_PAIRS blur→focus pairs inside FLURRY_WINDOW_MS counts once. */
function countFlurries(pairTimesMs: number[]): number {
  let flurries = 0;
  let i = 0;
  while (i + FLURRY_PAIRS - 1 < pairTimesMs.length) {
    if (pairTimesMs[i + FLURRY_PAIRS - 1]! - pairTimesMs[i]! <= FLURRY_WINDOW_MS) {
      flurries++;
      i += FLURRY_PAIRS; // consume the pairs of this flurry
    } else {
      i++;
    }
  }
  return flurries;
}

/**
 * Deterministic 0–100 suspicion score. Ignores every non-integrity event, so
 * callers can feed the whole event stream. Factors with zero occurrences are
 * omitted; sum of contributions === score whenever the sum is under the
 * 100-point clamp.
 */
export function computeSuspicionScore(events: SuspicionEventInput[]): SuspicionScore {
  const integrity = events
    .filter((e) => typeof e.type === "string" && e.type.startsWith("integrity."))
    .slice()
    .sort((a, b) => a.seq - b.seq);

  let blurCount = 0;
  let pasteCount = 0;
  let idleCount = 0;
  let devtoolsCount = 0;
  let copyCount = 0;
  let fullscreenCount = 0;
  let rateCappedCount = 0;

  // blur→focus pairing for the flurry factor: a tab_blur "opens" a pair, the
  // next tab_focus closes it. Pair time = the blur's timestamp.
  const pairTimesMs: number[] = [];
  let openBlurMs: number | null = null;

  for (const e of integrity) {
    const p = e.payload ?? {};
    switch (e.type) {
      case "integrity.tab_blur": {
        blurCount++;
        const t = Date.parse(e.ts);
        openBlurMs = Number.isFinite(t) ? t : null;
        break;
      }
      case "integrity.window_blur":
        blurCount++;
        break;
      case "integrity.tab_focus":
        if (openBlurMs !== null) {
          pairTimesMs.push(openBlurMs);
          openBlurMs = null;
        }
        break;
      case "integrity.paste_burst":
        if (typeof p["chars"] === "number" && p["chars"] > PASTE_CHARS_THRESHOLD) pasteCount++;
        break;
      case "integrity.idle_gap":
        if (typeof p["ms"] === "number" && p["ms"] > IDLE_MS_THRESHOLD) idleCount++;
        break;
      case "integrity.devtools":
        devtoolsCount++;
        break;
      case "integrity.copy":
        if (p["source"] === "brief" || p["source"] === "docs") copyCount++;
        break;
      case "integrity.fullscreen_exit":
        fullscreenCount++;
        break;
      case "integrity.rate_capped":
        rateCappedCount++; // server-authored (one per capped minute window)
        break;
      default:
        break; // unknown integrity.* subtype — contributes nothing
    }
  }

  const all: SuspicionFactor[] = [
    factor("blur", blurCount),
    factor("paste_burst", pasteCount),
    factor("idle_gap", idleCount),
    factor("devtools", devtoolsCount),
    factor("copy_source", copyCount),
    factor("fullscreen_exit", fullscreenCount),
    factor("focus_flurry", countFlurries(pairTimesMs)),
    factor("rate_capped", rateCappedCount),
  ];
  const factors = all.filter((f) => f.count > 0);
  const score = Math.min(100, factors.reduce((s, f) => s + f.contribution, 0));

  return { score, factors, version: SUSPICION_DETECTOR_VERSION };
}
