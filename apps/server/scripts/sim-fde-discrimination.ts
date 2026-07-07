// Early discriminant-validity demo for Crucible's scoring rubric.
//
// Runs three archetypal Forward Deployed Engineer (FDE) candidate playbooks —
// STRONG, MEDIAN, WEAK — against the calibrated `fde-db-triage-pro` scenario,
// N times each (default N=3). Each trial is an independent live session: real
// persona agents (Dana, Sam), real sandbox, real Analysis Agent evaluation.
// Within-archetype variance comes from LLM nondeterminism in the persona
// agents and the judge.
//
// Output: a stakeholder-ready markdown report at
//   docs/discrimination-report.md
// plus the raw JSON at
//   fixtures/discrimination-runs/<iso>.json
//
// Run:
//   pnpm --filter @crucible/server exec tsx scripts/sim-fde-discrimination.ts
//
// Env:
//   SERVER_URL       default http://127.0.0.1:3001
//   RUNS             trials per archetype (default 3)
//   ARCHETYPES       comma-separated subset, e.g. "STRONG,WEAK" (default all)
//   REPORT_PATH      default ../../docs/discrimination-report.md (repo-rooted)

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { mkdirSync, writeFileSync } from "fs";
import {
  runStrong,
  runHeldout,
  runWeak,
  getScenarioId,
  type PlayResult,
} from "./verify-pro-discrimination.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const REPO_ROOT = resolve(here, "../../..");
const RUNS_PER_ARCHETYPE = Math.max(1, Number(process.env.RUNS ?? "3"));
const REPORT_PATH =
  process.env.REPORT_PATH ?? resolve(REPO_ROOT, "docs/discrimination-report.md");
const RAW_DIR = resolve(REPO_ROOT, "fixtures/discrimination-runs");

type ArchetypeName = "STRONG" | "MEDIAN" | "WEAK";

interface ArchetypeDef {
  name: ArchetypeName;
  label: string;
  blurb: string;
  runner: (scenarioId: string) => Promise<PlayResult>;
}

const ARCHETYPES: ArchetypeDef[] = [
  {
    name: "STRONG",
    label: "Strong FDE",
    blurb:
      "Probes the brief with a clarifying question to the customer (Dana) before " +
      "writing SQL, reads the docs, verifies all three reported issues with data, " +
      "pushes back on the teammate (Sam) with evidence when his hint is wrong, and " +
      "ships a ranked deliverable that explicitly distinguishes signal from noise.",
  runner: runStrong,
  },
  {
    name: "MEDIAN",
    label: "Median FDE",
    blurb:
      "Competent SQL but does not probe ambiguity. Acknowledges the teammate " +
      "neutrally without verifying his hint. Finds the two real issues (revenue + " +
      "churn) but does not investigate the third. Ships a workable two-issue " +
      "deliverable with a caveat about the unverified third.",
    runner: runHeldout,
  },
  {
    name: "WEAK",
    label: "Weak FDE",
    blurb:
      "Accepts the teammate's misleading hint without verification. Runs one naive " +
      "aggregate query. Does not read docs, does not ask the customer anything, " +
      "does not engage the AI assistant. Submits an incomplete deliverable that " +
      "prioritizes the wrong issue.",
    runner: runWeak,
  },
];

const archetypeFilter = (process.env.ARCHETYPES ?? "")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = archetypeFilter.length
  ? ARCHETYPES.filter((a) => archetypeFilter.includes(a.name))
  : ARCHETYPES;

// ─── Stats helpers ─────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

// Two-tailed t critical values at α=0.05 for df 1..30. For df>30 we fall back
// to the normal approximation 1.960 — error <2% by df=30.
const T_CRIT_95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
  15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080,
  22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048,
  29: 2.045, 30: 2.042,
};

interface CI {
  lower: number;
  upper: number;
  half: number; // half-width = upper - mean
}

function ci95(xs: number[]): CI {
  const n = xs.length;
  if (n < 2) return { lower: NaN, upper: NaN, half: NaN };
  const m = mean(xs);
  const s = stdev(xs);
  const df = n - 1;
  const tc = T_CRIT_95[df] ?? 1.960;
  const half = (tc * s) / Math.sqrt(n);
  return { lower: m - half, upper: m + half, half };
}

// ─── Aggregation ──────────────────────────────────────────────────────────

interface Trial {
  archetype: ArchetypeName;
  trial: number;
  sessionId: string;
  evalId: string | null;
  overall: number | null;
  competencies: Record<string, number>;
  status: "complete" | "error" | "missing";
}

interface ArchetypeSummary {
  archetype: ArchetypeName;
  label: string;
  blurb: string;
  trials: Trial[];
  overallRuns: number[];
  overallMean: number;
  overallStdev: number;
  overallCi: CI;
  competencyMeans: Record<string, number>;
  competencyStdevs: Record<string, number>;
}

const COMP_ORDER = [
  "design_under_constraints",
  "teamwork",
  "data_fluency",
  "execution",
  "problem_framing",
  "outcome_communication",
  "ai_orchestration",
  "customer_engagement",
];

function summarize(name: ArchetypeName, label: string, blurb: string, trials: Trial[]): ArchetypeSummary {
  const overallRuns = trials
    .map((t) => t.overall)
    .filter((x): x is number => x !== null);
  const competencyMeans: Record<string, number> = {};
  const competencyStdevs: Record<string, number> = {};
  for (const c of COMP_ORDER) {
    const xs = trials.map((t) => t.competencies[c]).filter((x): x is number => typeof x === "number");
    competencyMeans[c] = mean(xs);
    competencyStdevs[c] = stdev(xs);
  }
  return {
    archetype: name, label, blurb, trials,
    overallRuns,
    overallMean: mean(overallRuns),
    overallStdev: stdev(overallRuns),
    overallCi: ci95(overallRuns),
    competencyMeans, competencyStdevs,
  };
}

// ─── Verdict ──────────────────────────────────────────────────────────────

interface Verdict {
  rankOrderHolds: boolean;
  pairwiseGapsExceedNoise: boolean;
  strongAlwaysAboveWeak: boolean;
  ciNonOverlap: boolean; // 95% CIs of adjacent archetypes do not overlap
  perCompetencyConsistency: number; // fraction of competencies where strong > median > weak (means)
  notes: string[];
}

function judge(summaries: ArchetypeSummary[]): Verdict {
  const byName = new Map(summaries.map((s) => [s.archetype, s]));
  const s = byName.get("STRONG");
  const m = byName.get("MEDIAN");
  const w = byName.get("WEAK");
  const notes: string[] = [];

  if (!s || !m || !w) {
    return {
      rankOrderHolds: false,
      pairwiseGapsExceedNoise: false,
      strongAlwaysAboveWeak: false,
      ciNonOverlap: false,
      perCompetencyConsistency: 0,
      notes: ["one or more archetypes missing — verdict skipped"],
    };
  }

  const rankOrderHolds = s.overallMean > m.overallMean && m.overallMean > w.overallMean;
  if (!rankOrderHolds) notes.push(`mean rank-order broken: STRONG=${fmt(s.overallMean)}, MEDIAN=${fmt(m.overallMean)}, WEAK=${fmt(w.overallMean)}`);

  // Within-archetype noise estimate: pool stdevs across the 3 archetypes.
  const pooledNoise = mean([s.overallStdev, m.overallStdev, w.overallStdev]);
  const gapSM = s.overallMean - m.overallMean;
  const gapMW = m.overallMean - w.overallMean;
  const pairwiseGapsExceedNoise =
    gapSM > pooledNoise && gapMW > pooledNoise;
  if (!pairwiseGapsExceedNoise) {
    notes.push(`gap < noise: STRONG-MEDIAN=${fmt(gapSM)}, MEDIAN-WEAK=${fmt(gapMW)}, pooled σ=${fmt(pooledNoise)}`);
  }

  // Trial-level: is every strong trial above every weak trial?
  let allStrongAboveAllWeak = true;
  for (const ts of s.overallRuns) {
    for (const tw of w.overallRuns) {
      if (!(ts > tw)) allStrongAboveAllWeak = false;
    }
  }
  if (!allStrongAboveAllWeak) {
    notes.push(`some STRONG trial scored ≤ some WEAK trial — rank-order not perfectly stable`);
  }

  let agree = 0, total = 0;
  for (const c of COMP_ORDER) {
    const sm = s.competencyMeans[c];
    const mm = m.competencyMeans[c];
    const wm = w.competencyMeans[c];
    if (typeof sm !== "number" || typeof mm !== "number" || typeof wm !== "number") continue;
    total++;
    if (sm >= mm && mm >= wm && sm > wm) agree++;
  }
  const perCompetencyConsistency = total > 0 ? agree / total : 0;

  // CI non-overlap: strict (Strong.lower > Median.upper AND Median.lower > Weak.upper).
  // NaN-safe: any NaN CI bound fails the check.
  const ciSM = Number.isFinite(s.overallCi.lower) && Number.isFinite(m.overallCi.upper) &&
               s.overallCi.lower > m.overallCi.upper;
  const ciMW = Number.isFinite(m.overallCi.lower) && Number.isFinite(w.overallCi.upper) &&
               m.overallCi.lower > w.overallCi.upper;
  const ciNonOverlap = ciSM && ciMW;
  if (!ciNonOverlap) {
    notes.push(
      `CI overlap: STRONG=[${fmt(s.overallCi.lower)},${fmt(s.overallCi.upper)}], ` +
      `MEDIAN=[${fmt(m.overallCi.lower)},${fmt(m.overallCi.upper)}], ` +
      `WEAK=[${fmt(w.overallCi.lower)},${fmt(w.overallCi.upper)}]`,
    );
  }

  return {
    rankOrderHolds,
    pairwiseGapsExceedNoise,
    strongAlwaysAboveWeak: allStrongAboveAllWeak,
    ciNonOverlap,
    perCompetencyConsistency,
    notes,
  };
}

// ─── Report ───────────────────────────────────────────────────────────────

function compLabel(key: string): string {
  return key.split("_").map((w) => {
    if (w === "ai") return "AI";
    return w[0]!.toUpperCase() + w.slice(1);
  }).join(" ");
}

function renderMarkdown(
  summaries: ArchetypeSummary[],
  verdict: Verdict,
  runsPerArchetype: number,
  scenarioSlug: string,
  startedAt: string,
  finishedAt: string,
  durationMs: number,
): string {
  const lines: string[] = [];
  lines.push(`# Crucible — Early Discriminant-Validity Report`);
  lines.push(``);
  lines.push(`**Scenario:** \`${scenarioSlug}\` (Forward Deployed Engineer style: ambiguous customer ticket, misleading teammate hint, mid-session requirement change).`);
  lines.push(`**Run:** ${startedAt} → ${finishedAt} (${(durationMs / 1000 / 60).toFixed(1)} min wall clock).`);
  lines.push(`**Method:** ${summaries.length} archetypal FDE candidate playbooks × ${runsPerArchetype} independent trials each = ${summaries.length * runsPerArchetype} live end-to-end sessions, scored post-hoc by the Analysis Agent on 8 weighted competencies. Within-archetype variance comes from LLM nondeterminism in the two persona agents (Dana, Sam) and in the judge.`);
  lines.push(``);

  // ── Headline table ──
  lines.push(`## Headline`);
  lines.push(``);
  lines.push(`| Archetype | Overall (mean ± σ) | 95% CI | n |`);
  lines.push(`|---|---:|---:|---:|`);
  for (const s of summaries) {
    const ci = s.overallRuns.length >= 2
      ? `[${fmt(s.overallCi.lower)}, ${fmt(s.overallCi.upper)}]`
      : "—";
    lines.push(`| **${s.label}** | ${fmt(s.overallMean)} ± ${fmt(s.overallStdev)} | ${ci} | ${s.overallRuns.length} |`);
  }
  lines.push(``);
  // Show raw trial scores in a collapsible-ish second table — useful for audit
  // without bloating the headline.
  lines.push(`<details><summary>Raw trial scores</summary>`);
  lines.push(``);
  for (const s of summaries) {
    const runs = s.overallRuns.length > 0 ? s.overallRuns.map((x) => fmt(x)).join(", ") : "—";
    lines.push(`- **${s.label}** — ${runs}`);
  }
  lines.push(``);
  lines.push(`</details>`);
  lines.push(``);

  // ── Verdict ──
  lines.push(`## Discriminant-validity verdict`);
  lines.push(``);
  const tick = (ok: boolean) => ok ? "✅" : "❌";
  lines.push(`- ${tick(verdict.rankOrderHolds)} **Rank-order holds on means**: Strong > Median > Weak.`);
  lines.push(`- ${tick(verdict.ciNonOverlap)} **95% confidence intervals do not overlap**: Strong's lower bound > Median's upper bound, and Median's lower bound > Weak's upper bound. This is the strongest of the separation claims.`);
  lines.push(`- ${tick(verdict.pairwiseGapsExceedNoise)} **Pairwise gaps exceed within-archetype noise**: both Strong–Median and Median–Weak gaps are larger than the pooled within-archetype standard deviation.`);
  lines.push(`- ${tick(verdict.strongAlwaysAboveWeak)} **Trial-level separation**: every Strong trial outscored every Weak trial.`);
  lines.push(`- **Per-competency consistency:** Strong ≥ Median ≥ Weak holds on ${Math.round(verdict.perCompetencyConsistency * 100)}% of the 8 competencies.`);
  if (verdict.notes.length > 0) {
    lines.push(``);
    lines.push(`**Caveats from this run:**`);
    for (const n of verdict.notes) lines.push(`- ${n}`);
  }
  lines.push(``);

  const headlinePass =
    verdict.rankOrderHolds && verdict.ciNonOverlap && verdict.strongAlwaysAboveWeak;
  lines.push(`**Headline:** ${headlinePass ? "scores separate strong from weak FDE candidates consistently across trials, with non-overlapping 95% confidence intervals." : "separation is partial — see caveats."}`);
  lines.push(``);

  // ── Per-competency breakdown ──
  lines.push(`## Per-competency mean (± σ)`);
  lines.push(``);
  lines.push(`| Competency | ${summaries.map((s) => s.label).join(" | ")} |`);
  lines.push(`|---|${summaries.map(() => "---:").join("|")}|`);
  for (const c of COMP_ORDER) {
    const cells = summaries.map((s) => `${fmt(s.competencyMeans[c] ?? NaN)} ± ${fmt(s.competencyStdevs[c] ?? NaN)}`);
    lines.push(`| ${compLabel(c)} | ${cells.join(" | ")} |`);
  }
  lines.push(``);

  // ── Archetype detail ──
  lines.push(`## Archetypes`);
  lines.push(``);
  for (const s of summaries) {
    lines.push(`### ${s.label}`);
    lines.push(``);
    lines.push(s.blurb);
    lines.push(``);
    lines.push(`| Trial | Session | Evaluation | Overall | Status |`);
    lines.push(`|---:|---|---|---:|---|`);
    for (const t of s.trials) {
      lines.push(`| ${t.trial} | \`${t.sessionId}\` | ${t.evalId ? `\`${t.evalId}\`` : "—"} | ${t.overall === null ? "—" : fmt(t.overall)} | ${t.status} |`);
    }
    lines.push(``);
  }

  // ── Methodology + limitations ──
  lines.push(`## Methodology`);
  lines.push(``);
  lines.push(`Each trial is a real end-to-end session: HTTP-driven candidate, real E2B sandbox, real LiteLLM-gated calls to the persona agents, real Analysis Agent grading from the persisted event stream. No mocks. The three archetype playbooks are scripted sequences of (a) Dana/Sam chat turns, (b) SQL queries, (c) doc views, (d) AI assistant turns, and (e) a deliverable submission. Each archetype's playbook is identical across its ${runsPerArchetype} trials — *only the LLMs vary between trials*. Curveball timing is compressed to keep wall-clock manageable; this does not affect the rubric anchors.`);
  lines.push(``);
  lines.push(`## Limitations`);
  lines.push(``);
  lines.push(`- **N=${runsPerArchetype} per archetype** is a preliminary signal, not a significance test. A follow-up at N≥10 with confidence intervals is the next step.`);
  lines.push(`- **Single scenario.** Cross-scenario validity (does the rubric generalize beyond DB triage?) is not demonstrated here; it requires running the same archetypes against at least two additional calibrated FDE scenarios.`);
  lines.push(`- **Scripted playbooks** are stand-ins for real human candidate variance. They capture archetypal behavior but not the full naturalistic distribution.`);
  lines.push(`- **No blind human comparison yet.** Pairing this against human rater scores on the same sessions would strengthen the validity claim.`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`Reproduce: \`pnpm --filter @crucible/server exec tsx scripts/sim-fde-discrimination.ts\``);
  return lines.join("\n") + "\n";
}

// ─── Main ─────────────────────────────────────────────────────────────────

function logBanner(title: string): void {
  console.log(`\n═══ ${title} ═══`);
}

function tsForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

(async () => {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  console.log(`SERVER_URL=${process.env.SERVER_URL ?? "http://127.0.0.1:3001"}`);
  console.log(`RUNS_PER_ARCHETYPE=${RUNS_PER_ARCHETYPE}`);
  console.log(`ARCHETYPES=${SELECTED.map((a) => a.name).join(",")}`);

  const scenarioId = await getScenarioId();
  console.log(`scenario fde-db-triage-pro id=${scenarioId}`);

  const trials: Trial[] = [];

  for (const archetype of SELECTED) {
    logBanner(`${archetype.label} (${archetype.name}) — ${RUNS_PER_ARCHETYPE} trials`);
    for (let i = 1; i <= RUNS_PER_ARCHETYPE; i++) {
      console.log(`\n--- ${archetype.name} trial ${i}/${RUNS_PER_ARCHETYPE} ---`);
      let result: PlayResult;
      try {
        result = await archetype.runner(scenarioId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ! trial threw: ${msg.slice(0, 200)}`);
        trials.push({
          archetype: archetype.name,
          trial: i,
          sessionId: "",
          evalId: null,
          overall: null,
          competencies: {},
          status: "error",
        });
        continue;
      }
      const e = result.evaluation;
      const competencies: Record<string, number> = {};
      if (e) for (const it of e.items) competencies[it.competency] = it.score;
      trials.push({
        archetype: archetype.name,
        trial: i,
        sessionId: result.sessionId,
        evalId: e?.id ?? null,
        overall: e?.overall_score ?? null,
        competencies,
        status: e ? e.status : "missing",
      });
      console.log(
        `  trial ${i}: session=${result.sessionId} eval=${e?.id ?? "—"} overall=${e?.overall_score !== undefined ? fmt(e.overall_score) : "—"}`,
      );
    }
  }

  // Summarize
  const summaries = SELECTED.map((a) =>
    summarize(a.name, a.label, a.blurb, trials.filter((t) => t.archetype === a.name)),
  );

  const verdict = judge(summaries);

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - t0;

  // Write raw JSON
  mkdirSync(RAW_DIR, { recursive: true });
  const rawPath = resolve(RAW_DIR, `${tsForFile()}.json`);
  writeFileSync(rawPath, JSON.stringify({
    startedAt, finishedAt, durationMs,
    scenarioSlug: "fde-db-triage-pro",
    runsPerArchetype: RUNS_PER_ARCHETYPE,
    trials, summaries, verdict,
  }, null, 2));
  console.log(`\nraw runs JSON: ${rawPath}`);

  // Write markdown report
  const md = renderMarkdown(
    summaries, verdict, RUNS_PER_ARCHETYPE,
    "fde-db-triage-pro", startedAt, finishedAt, durationMs,
  );
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, md);
  console.log(`report markdown: ${REPORT_PATH}`);

  // CLI summary
  logBanner("SUMMARY");
  for (const s of summaries) {
    const ci = s.overallRuns.length >= 2
      ? `95% CI [${fmt(s.overallCi.lower)}, ${fmt(s.overallCi.upper)}]`
      : "CI N/A";
    console.log(`  ${s.label.padEnd(14)} overall=${fmt(s.overallMean)} ± ${fmt(s.overallStdev)}  ${ci}  trials=[${s.overallRuns.map((x) => fmt(x)).join(", ")}]`);
  }
  console.log(
    `\n  rank-order holds:           ${verdict.rankOrderHolds ? "YES" : "NO"}` +
    `\n  95% CIs non-overlapping:    ${verdict.ciNonOverlap ? "YES" : "NO"}` +
    `\n  gaps exceed pooled noise:   ${verdict.pairwiseGapsExceedNoise ? "YES" : "NO"}` +
    `\n  every STRONG > every WEAK:  ${verdict.strongAlwaysAboveWeak ? "YES" : "NO"}` +
    `\n  per-competency consistency: ${Math.round(verdict.perCompetencyConsistency * 100)}%`,
  );
  if (verdict.notes.length > 0) {
    console.log(`\n  notes:`);
    for (const n of verdict.notes) console.log(`    - ${n}`);
  }
  // Exit 0 regardless — this is a measurement script, not a gate.
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
