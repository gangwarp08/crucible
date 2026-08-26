// Run matrix. Expands (persona × scenario × trials) into a work-list, with the
// non-genuine classes gated OFF by default. Everything is env/flag-overridable
// so the same harness runs a 1-session smoke or a 300-session full pass.

import { type Persona, type PersonaClass, personasForClasses } from "./personas.js";

export interface ScenarioSpec {
  slug: string;
  family: string;
  kind: "sqlite" | "git_repo";
}

/** The scenarios that exist as fixtures/DB rows. code-debug is git_repo
 *  (file-read + deliverable supported; terminal test-runs are a follow-up). */
export const SCENARIOS: ScenarioSpec[] = [
  { slug: "fde-db-triage",           family: "fde-db-triage",       kind: "sqlite" },
  { slug: "fde-db-triage-pro",       family: "fde-db-triage",       kind: "sqlite" },
  { slug: "fde-api-integration",     family: "fde-api-integration", kind: "sqlite" },
  { slug: "fde-api-integration-pro", family: "fde-api-integration", kind: "sqlite" },
  { slug: "fde-code-debug",          family: "fde-code-debug",      kind: "git_repo" },
];

export interface RunSpec {
  persona: Persona;
  scenario: ScenarioSpec;
  trial: number;
  seed: number;
}

export interface ManifestOpts {
  classes: PersonaClass[];
  scenarioSlugs: string[]; // subset of SCENARIOS by slug
  trials: number;
  seedBase: number;
}

export function defaultOptsFromEnv(): ManifestOpts {
  const classes = (process.env.CLASSES ?? "genuine")
    .split(",").map((s) => s.trim()).filter(Boolean) as PersonaClass[];
  const scenarioSlugs = (process.env.SCENARIOS ??
    "fde-db-triage,fde-api-integration,fde-code-debug")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const trials = Number(process.env.TRIALS ?? "6");
  const seedBase = Number(process.env.SEED_BASE ?? "1000");
  return { classes, scenarioSlugs, trials, seedBase };
}

export function expandManifest(opts: ManifestOpts): RunSpec[] {
  let personas = personasForClasses(opts.classes);
  // Optional persona-id allowlist (comma-separated) for targeted smoke runs.
  const only = (process.env.PERSONAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (only.length) personas = personas.filter((p) => only.includes(p.id));
  const scenarios = SCENARIOS.filter((s) => opts.scenarioSlugs.includes(s.slug));
  const runs: RunSpec[] = [];
  let i = 0;
  for (const persona of personas) {
    for (const scenario of scenarios) {
      for (let trial = 1; trial <= opts.trials; trial++) {
        runs.push({ persona, scenario, trial, seed: opts.seedBase + i * 7919 });
        i++;
      }
    }
  }
  return runs;
}

// ─── Cost model (for --dry-run projection; see plan doc for derivation) ──────
// Tokens per session, split by who pays. Platform-internal is capped by the
// per-session LiteLLM key; simulator is the candidate-driver on its own key.
export const COST_MODEL = {
  platformInputTok: 99_000,
  platformOutputTok: 13_500,
  simInputTok: 180_000,
  simOutputTok: 12_000,
  // gemini-flash tiers ($/1M in, $/1M out). Report a range.
  tiers: {
    "2.5-flash": { in: 0.30, out: 2.50 },
    "3-flash": { in: 0.50, out: 3.00 },
  } as Record<string, { in: number; out: number }>,
};

export function perSessionCost(tier: { in: number; out: number }): number {
  const inTok = COST_MODEL.platformInputTok + COST_MODEL.simInputTok;
  const outTok = COST_MODEL.platformOutputTok + COST_MODEL.simOutputTok;
  return (inTok * tier.in + outTok * tier.out) / 1_000_000;
}
