// Pure verifier for the onboarding workspace README (no LLM, no DB writes,
// no sandbox). For every live scenario fixture:
//   (a) the guarded README renders cleanly (guard does NOT trip on legit
//       mechanics: table names, persona names, doc titles);
//   (b) it contains the onboarding essentials (dataset file, table names,
//       both persona names, tab map);
//   (c) it contains NO ground-truth figures or narrative fragments;
//   (d) the guard DOES trip when an answer is planted into a candidate-visible
//       field (scenario title carrying the overstatement figure).
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-workspace-readme.ts
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import {
  buildWorkspaceReadme,
  renderGuardedReadme,
  parseTableNames,
  ReadmeLeakError,
} from "../src/services/workspace-readme.js";
import type { Scenario } from "../src/services/scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const SLUGS = [
  "fde-db-triage",
  "fde-db-triage-pro",
  "fde-api-integration",
  "fde-api-integration-pro",
];

let failures = 0;
function pass(msg: string): void {
  console.log("  PASS ", msg);
}
function fail(msg: string): void {
  failures += 1;
  console.error("  FAIL ", msg);
}

function loadScenarioFixture(slug: string): Scenario {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, "fixtures", slug, "scenario.json"), "utf8"));
  return {
    id: `fixture-${slug}`,
    slug,
    title: raw.title,
    role: raw.role,
    difficulty: raw.difficulty ?? null,
    brief: raw.brief ?? null,
    client_persona: raw.client_persona ?? {},
    team_persona: raw.team_persona ?? {},
    dataset_ref: raw.dataset_ref ?? null,
    docs: raw.docs ?? [],
    constraints: raw.constraints ?? {},
    rubric: raw.rubric ?? {},
    deliverable_spec: raw.deliverable_spec ?? {},
    curveballs: raw.curveballs ?? [],
    success_criteria: raw.success_criteria ?? {},
    created_at: new Date(0).toISOString(),
  };
}

for (const slug of SLUGS) {
  console.log(`\n[${slug}]`);
  const scenario = loadScenarioFixture(slug);
  const tables = scenario.dataset_ref ? parseTableNames(scenario.dataset_ref) : [];

  // (a) renders cleanly through the guard
  let readme: string;
  try {
    readme = renderGuardedReadme(scenario, tables);
    pass("guarded render succeeds (no false positive on legit mechanics)");
  } catch (err) {
    fail(`guard tripped on a clean scenario: ${(err as Error).message}`);
    continue;
  }

  // (b) onboarding essentials present
  if (readme.includes("customer.db")) pass("names the dataset file");
  else fail("missing customer.db mention");
  for (const t of tables) {
    if (readme.includes(`\`${t}\``)) pass(`lists table "${t}"`);
    else fail(`missing table "${t}"`);
  }
  const client = (scenario.client_persona as { name?: string }).name;
  const team = (scenario.team_persona as { name?: string }).name;
  if (client && readme.includes(client)) pass(`names the client persona (${client})`);
  else fail(`missing client persona name (${client ?? "?"})`);
  if (team && readme.includes(team)) pass(`names the team persona (${team})`);
  else fail(`missing team persona name (${team ?? "?"})`);
  for (const tab of ["Brief", "Docs", "Deliverable", "Data", "Terminal", "Assistant"]) {
    if (!readme.includes(`**${tab}**`)) fail(`missing tab pointer: ${tab}`);
  }
  pass("tab map present");

  // (c) no ground-truth figures leaked (independent re-check, not just the guard)
  if (scenario.dataset_ref) {
    const gt = JSON.parse(
      readFileSync(resolve(repoRoot, scenario.dataset_ref, "ground_truth.json"), "utf8"),
    );
    const flat = JSON.stringify(gt);
    const bigNumbers = [...flat.matchAll(/\d{5,}/g)].map((m) => m[0]);
    const leaked = bigNumbers.find((n) => readme.includes(n));
    if (leaked) fail(`README contains ground-truth figure ${leaked}`);
    else pass("no ground-truth figures in the README");
  }

  // (d) the guard trips on a planted leak
  const gtPath = scenario.dataset_ref
    ? resolve(repoRoot, scenario.dataset_ref, "ground_truth.json")
    : null;
  if (gtPath) {
    const gt = JSON.parse(readFileSync(gtPath, "utf8"));
    const flat = JSON.stringify(gt);
    const planted = [...flat.matchAll(/\d{5,}/g)].map((m) => m[0])[0];
    if (planted) {
      const poisoned: Scenario = { ...scenario, title: `${scenario.title} (${planted})` };
      try {
        renderGuardedReadme(poisoned, tables);
        fail(`guard did NOT trip on planted ground-truth figure ${planted}`);
      } catch (err) {
        if (err instanceof ReadmeLeakError) pass(`guard trips on planted figure ${planted}`);
        else fail(`unexpected error type from guard: ${(err as Error).name}`);
      }
    }
  }

  // Show the first rendered README once for eyeballing.
  if (slug === SLUGS[0]) {
    console.log("\n──── rendered README (fde-db-triage) ────");
    console.log(buildWorkspaceReadme(scenario, tables));
    console.log("──────────────────────────────────────────");
  }
}

console.log(failures === 0 ? "\nverify-workspace-readme: ALL PASS" : `\nverify-workspace-readme: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
