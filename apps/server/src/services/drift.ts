// L6 drift detection (Slice 5.7).
//
// When any version stamp on an evaluation changes (competency model, detector,
// judge prompt, or scenario content), the held-out ANCHOR set should be
// re-scored and compared against its baseline. If a competency's score moves
// beyond a tolerated band, that's DRIFT — the change altered how candidates are
// judged, and the instrument needs re-calibration before the new version is
// trusted. This module is the pure comparison core; the verifier + a future
// scheduled job feed it baseline vs re-scored items.
//
// Pure functions, no IO — so the logic is deterministically testable.

export interface ScoredItem {
  competency: string;
  score: number;
}

export interface VersionStampSet {
  competency_model_version?: number | string | null;
  detector_version?: string | null;
  judge_prompt_version?: string | null;
  scenario_version?: number | string | null;
}

export interface CompetencyDelta {
  competency: string;
  baseline: number;
  rescored: number;
  delta: number; // rescored - baseline
}

export interface DriftReport {
  versions_changed: string[];   // which stamps differ baseline → rescored
  per_competency: CompetencyDelta[];
  max_abs_delta: number;
  mean_abs_delta: number;
  drifted: boolean;             // any |delta| > band
  band: number;
}

const STAMP_KEYS: (keyof VersionStampSet)[] = [
  "competency_model_version",
  "detector_version",
  "judge_prompt_version",
  "scenario_version",
];

/** Which version stamps differ between two evaluations. */
export function changedStamps(a: VersionStampSet, b: VersionStampSet): string[] {
  const out: string[] = [];
  for (const k of STAMP_KEYS) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    // Compare as strings so 1 (number) and "1" (text) don't read as a change.
    if (String(av) !== String(bv)) out.push(k);
  }
  return out;
}

/**
 * Compare a baseline scoring against a re-scoring of the same anchor session(s).
 * `drifted` is true when any competency moved by more than `band` (default 1.0,
 * i.e. more than a full point on the 1-5 scale). Competencies present in only
 * one set are reported with the missing side as 0 (a structural change worth
 * surfacing).
 */
export function detectDrift(
  baseline: ScoredItem[],
  rescored: ScoredItem[],
  opts: { band?: number; baselineVersions?: VersionStampSet; rescoredVersions?: VersionStampSet } = {},
): DriftReport {
  const band = opts.band ?? 1.0;
  const baseBy = new Map(baseline.map((i) => [i.competency, i.score]));
  const reBy = new Map(rescored.map((i) => [i.competency, i.score]));
  const keys = new Set<string>([...baseBy.keys(), ...reBy.keys()]);

  const per: CompetencyDelta[] = [];
  let maxAbs = 0;
  let sumAbs = 0;
  for (const c of keys) {
    const b = baseBy.get(c) ?? 0;
    const r = reBy.get(c) ?? 0;
    const delta = Math.round((r - b) * 1e4) / 1e4;
    const abs = Math.abs(delta);
    if (abs > maxAbs) maxAbs = abs;
    sumAbs += abs;
    per.push({ competency: c, baseline: b, rescored: r, delta });
  }
  per.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const versionsChanged =
    opts.baselineVersions && opts.rescoredVersions
      ? changedStamps(opts.baselineVersions, opts.rescoredVersions)
      : [];

  return {
    versions_changed: versionsChanged,
    per_competency: per,
    max_abs_delta: maxAbs,
    mean_abs_delta: keys.size ? Math.round((sumAbs / keys.size) * 1e4) / 1e4 : 0,
    drifted: maxAbs > band,
    band,
  };
}
