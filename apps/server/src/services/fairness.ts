// L6 fairness / DIF seam (Slice 5.7) — SEAM ONLY, not the analysis.
//
// Differential item functioning (DIF) asks whether candidates of equal ability
// but different subgroups score differently on an item — a fairness red flag.
// A real DIF estimate (Mantel-Haenszel / logistic) needs a meaningful sample
// PER SUBGROUP; running it on a handful of sessions produces noise that looks
// like bias. So the seam here is the GATE: DIF only activates once every
// compared subgroup clears a minimum N. Below that we explicitly report
// "insufficient data" rather than a fake number. The estimate itself is stubbed
// until subgroup volume + a subgroup attribute (v2) exist.

export const DEFAULT_MIN_SUBGROUP_N = 30;

export interface DifGateResult {
  activated: boolean;
  min_n: number;
  subgroup_sizes: Record<string, number>;
  insufficient: string[]; // subgroups below min_n
  reason: string;
  // Populated only when activated; stubbed until v2 wires a real estimator.
  dif_estimate: null;
}

/**
 * Decide whether a DIF analysis may run. Activates only when EVERY subgroup
 * meets min_n; otherwise returns the gate result naming the under-powered
 * subgroups. Never throws — an empty/!sufficient input is a normal "not yet".
 */
export function difGate(
  subgroupSizes: Record<string, number>,
  minN: number = DEFAULT_MIN_SUBGROUP_N,
): DifGateResult {
  const entries = Object.entries(subgroupSizes);
  const insufficient = entries.filter(([, n]) => n < minN).map(([g]) => g);
  const activated = entries.length >= 2 && insufficient.length === 0;
  const reason = activated
    ? `all ${entries.length} subgroups ≥ ${minN}; DIF may run (estimator stubbed until v2)`
    : entries.length < 2
      ? "need ≥2 subgroups to compare"
      : `insufficient N in: ${insufficient.join(", ")} (min ${minN})`;
  return {
    activated,
    min_n: minN,
    subgroup_sizes: subgroupSizes,
    insufficient,
    reason,
    dif_estimate: null,
  };
}
