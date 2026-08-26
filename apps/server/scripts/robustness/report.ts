// Aggregation + reporting. Turns per-run results into the two deliverables the
// task asked for: (1) evidence that the detector discriminates across the
// candidate spectrum, and (2) a ranked improvement backlog. Also emits a
// validity-yield summary (how many runs are scorable + realistically paced).

import type { AgentTrace } from "./candidate-agent.js";
import type { Persona } from "./personas.js";
import type { SessionRow, EvalRow } from "./shared.js";

export interface RunResult {
  personaId: string;
  personaClass: string;
  skill: string;
  expectBand: [number, number];
  scenarioSlug: string;
  family: string;
  trial: number;
  sessionId: string | null;
  trace: AgentTrace | null;
  session: SessionRow | null;
  evaluation: EvalRow | null;
  error?: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");

const SKILL_ORDER = ["strong", "above_avg", "median", "below_avg", "weak"];

export function buildReport(results: RunResult[], meta: {
  runId: string; classes: string[]; scenarios: string[]; speed: number;
  simCostUsd: number; simCalls: number;
}): string {
  const L: string[] = [];
  const scored = results.filter((r) => r.evaluation?.status === "complete" && r.evaluation.overall_score != null);

  L.push(`# Robustness & Validity Report — ${meta.runId}`);
  L.push("");
  L.push(`Classes: ${meta.classes.join(", ")} · Scenarios: ${meta.scenarios.join(", ")} · SPEED=${meta.speed}`);
  L.push(`Runs: ${results.length} attempted, ${scored.length} scored · Simulator spend: $${meta.simCostUsd.toFixed(4)} over ${meta.simCalls} calls`);
  L.push("");

  // ── 1. Discrimination ─────────────────────────────────────────────────────
  L.push(`## 1. Discrimination across the candidate spectrum`);
  L.push("");
  L.push(`Mean overall score by persona (genuine spectrum ordered strong→weak). A healthy detector shows monotonic decline; inversions are flagged.`);
  L.push("");
  L.push(`| Persona | skill | n | mean overall | expected band | in band? |`);
  L.push(`|---|---|--:|--:|--:|:--:|`);
  const byPersona = groupBy(scored, (r) => r.personaId);
  const personaMeans: Record<string, number> = {};
  const orderedPersonaIds = Object.keys(byPersona).sort(
    (a, b) => SKILL_ORDER.indexOf(byPersona[a]![0]!.skill) - SKILL_ORDER.indexOf(byPersona[b]![0]!.skill),
  );
  for (const pid of orderedPersonaIds) {
    const rs = byPersona[pid]!;
    const m = mean(rs.map((r) => r.evaluation!.overall_score!));
    personaMeans[pid] = m;
    const band = rs[0]!.expectBand;
    const inBand = m >= band[0] && m <= band[1];
    L.push(`| ${pid} | ${rs[0]!.skill} | ${rs.length} | ${f2(m)} | ${band[0]}–${band[1]} | ${inBand ? "✓" : "✗"} |`);
  }
  L.push("");

  // Strong-vs-weak separation on genuine spectrum.
  const strongM = personaMeans["genuine-strong"];
  const weakM = personaMeans["genuine-weak"];
  if (strongM != null && weakM != null) {
    const spread = strongM - weakM;
    L.push(`**Strong→Weak separation:** ${f2(strongM)} vs ${f2(weakM)} (spread ${f2(spread)}). ` +
      `${spread >= 1.5 ? "✓ meets the ≥1.5 discrimination bar." : "✗ BELOW the ≥1.5 bar — detector not separating cleanly."}`);
    L.push("");
  }

  // Per-competency means by skill (are individual competencies discriminating?).
  L.push(`### Per-competency mean by skill`);
  L.push("");
  const comps = uniqueCompetencies(scored);
  L.push(`| competency | ${SKILL_ORDER.join(" | ")} |`);
  L.push(`|---|${SKILL_ORDER.map(() => "--:").join("|")}|`);
  for (const c of comps) {
    const cells = SKILL_ORDER.map((sk) => {
      const rows = scored.filter((r) => r.skill === sk && r.personaClass === "genuine");
      const vals = rows.map((r) => r.evaluation!.items.find((i) => i.competency === c)?.score)
        .filter((v): v is number => v != null);
      return f2(mean(vals));
    });
    L.push(`| ${c} | ${cells.join(" | ")} |`);
  }
  L.push("");

  // ── 2. Validity yield ─────────────────────────────────────────────────────
  L.push(`## 2. Validity yield (scorable + realistically paced)`);
  L.push("");
  const withSession = results.filter((r) => r.session);
  const scorable = withSession.filter((r) => r.session!.scorable === true);
  L.push(`- Sessions created: ${withSession.length}`);
  L.push(`- Scorable (passes all exclusion floors): ${scorable.length} (${pct(scorable.length, withSession.length)})`);
  const exBreak = groupBy(withSession.filter((r) => r.session!.exclusion_reason), (r) => r.session!.exclusion_reason!);
  if (Object.keys(exBreak).length) {
    L.push(`- Exclusion reasons:`);
    for (const [reason, rs] of Object.entries(exBreak)) L.push(`  - ${reason}: ${rs.length}`);
  }
  const durs = withSession.map((r) => r.session!.duration_ms).filter((d): d is number => d != null);
  if (durs.length) {
    const mins = durs.map((d) => d / 60000);
    L.push(`- Session duration (min): min ${f2(Math.min(...mins))}, median ${f2(median(mins))}, max ${f2(Math.max(...mins))}`);
    const under10 = mins.filter((m) => m < 10).length;
    L.push(`- Runs under 10 active min (would fail scorability floor): ${under10} (${pct(under10, mins.length)})`);
  }
  const accrued = results.map((r) => r.trace?.accruedSeconds ?? 0).filter((s) => s > 0);
  if (accrued.length) L.push(`- Mean simulated active time: ${f2(mean(accrued) / 60)} min (pacing-driven, not a burst).`);
  L.push("");

  // ── 3. Improvement backlog ────────────────────────────────────────────────
  L.push(`## 3. Ranked improvement backlog`);
  L.push("");
  const backlog = deriveBacklog(results, scored, personaMeans);
  if (!backlog.length) L.push(`No issues detected by the automated heuristics. Review the discrimination table manually.`);
  backlog.forEach((b, i) => L.push(`${i + 1}. **[${b.severity}]** ${b.title} — ${b.detail}`));
  L.push("");

  // ── Errors ────────────────────────────────────────────────────────────────
  const errs = results.filter((r) => r.error);
  if (errs.length) {
    L.push(`## Run errors (${errs.length})`);
    for (const e of errs.slice(0, 30)) L.push(`- ${e.personaId} / ${e.scenarioSlug} #${e.trial}: ${e.error}`);
    L.push("");
  }

  return L.join("\n") + "\n";
}

interface BacklogItem { severity: "HIGH" | "MED" | "LOW"; title: string; detail: string }

function deriveBacklog(all: RunResult[], scored: RunResult[], personaMeans: Record<string, number>): BacklogItem[] {
  const out: BacklogItem[] = [];

  // Discrimination inversions among genuine skills.
  for (let i = 0; i < SKILL_ORDER.length - 1; i++) {
    const hi = genuineSkillMean(scored, SKILL_ORDER[i]!);
    const lo = genuineSkillMean(scored, SKILL_ORDER[i + 1]!);
    if (Number.isFinite(hi) && Number.isFinite(lo) && lo > hi + 0.1) {
      out.push({ severity: "HIGH", title: `Score inversion: ${SKILL_ORDER[i + 1]} > ${SKILL_ORDER[i]}`,
        detail: `Mean ${f2(lo)} vs ${f2(hi)} — the detector rewards the weaker persona. Investigate the rubric anchors / evidence units that let this happen.` });
    }
  }

  // Personas landing outside their expected band.
  const outOfBand = Object.entries(groupBy(scored, (r) => r.personaId)).filter(([, rs]) => {
    const m = personaMeans[rs[0]!.personaId];
    const band = rs[0]!.expectBand;
    return m != null && (m < band[0] - 0.3 || m > band[1] + 0.3);
  });
  for (const [pid, rs] of outOfBand) {
    const m = personaMeans[pid]!;
    out.push({ severity: "MED", title: `${pid} scores outside expected band`,
      detail: `mean ${f2(m)} vs band ${rs[0]!.expectBand.join("–")}. Either the persona prompt or the calibration band needs adjustment.` });
  }

  // Scorability leakage: genuine sessions being excluded.
  const excludedGenuine = all.filter((r) => r.personaClass === "genuine" && r.session?.scorable === false);
  if (excludedGenuine.length) {
    const reasons = uniq(excludedGenuine.map((r) => r.session!.exclusion_reason ?? "?"));
    out.push({ severity: reasons.includes("excluded_abandoned") ? "HIGH" : "MED",
      title: `${excludedGenuine.length} genuine runs excluded from scoring`,
      detail: `reasons: ${reasons.join(", ")}. If real candidates would be excluded the same way, the floor may be too aggressive.` });
  }

  // Budget hits on genuine (non-DoS) sessions — should not happen.
  const budgetHitsGenuine = all.filter((r) => r.personaClass === "genuine" && r.trace?.budgetHit);
  if (budgetHitsGenuine.length) {
    out.push({ severity: "MED", title: `${budgetHitsGenuine.length} genuine runs hit the assistant budget`,
      detail: `A genuine candidate exhausting the token budget suggests the per-session allowance may be tight for this scenario.` });
  }

  // Missing/incomplete evaluations.
  const noEval = all.filter((r) => r.sessionId && (!r.evaluation || r.evaluation.status !== "complete"));
  if (noEval.length) {
    out.push({ severity: "HIGH", title: `${noEval.length} sessions produced no complete evaluation`,
      detail: `Analysis Agent did not return a complete scorecard — check judge errors / quota / not_assessed rates.` });
  }

  // Parse-failure noise (simulator robustness, not the platform's fault).
  const flaky = all.filter((r) => (r.trace?.parseFailures ?? 0) >= 3);
  if (flaky.length) out.push({ severity: "LOW", title: `${flaky.length} runs had ≥3 simulator JSON parse failures`,
    detail: `Harness robustness: tighten the action-format instruction or add a repair step.` });

  const rank = { HIGH: 0, MED: 1, LOW: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ─── small helpers ───────────────────────────────────────────────────────────
function groupBy<T>(xs: T[], key: (x: T) => string): Record<string, T[]> {
  const o: Record<string, T[]> = {};
  for (const x of xs) { const k = key(x); (o[k] ??= []).push(x); }
  return o;
}
function genuineSkillMean(scored: RunResult[], skill: string): number {
  return mean(scored.filter((r) => r.personaClass === "genuine" && r.skill === skill)
    .map((r) => r.evaluation!.overall_score!));
}
function uniqueCompetencies(scored: RunResult[]): string[] {
  const s = new Set<string>();
  for (const r of scored) for (const it of r.evaluation!.items) s.add(it.competency);
  return [...s];
}
function uniq<T>(xs: T[]): T[] { return [...new Set(xs)]; }
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function pct(a: number, b: number): string { return b ? `${Math.round((100 * a) / b)}%` : "—"; }
