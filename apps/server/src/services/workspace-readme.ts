// Candidate-workspace README generator.
//
// Seeds /workspace/README.md at session provisioning so the candidate's first
// instinct — open the README — answers "what do I have and where does it
// live" without a treasure hunt. STRICTLY environment mechanics: everything
// in it is already candidate-visible elsewhere (scenario title/role/brief
// pointer, dataset file + table names, persona names/roles, doc titles, tab
// map). It must NEVER carry scenario answers.
//
// That "never" is enforced, not assumed: assertNoAnswerLeak() checks the
// rendered README against the scenario's ground_truth.json (distinctive
// numbers and verbatim narrative strings) and both personas' never_reveals
// lists, and hard-fails provisioning on a hit. This is a tripwire for future
// scenario authors — a doc title or brief edit that embeds an answer will
// refuse to provision rather than leak.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "./scenarios.js";
import { personaMeta } from "./scenarios.js";
import { readDatasetManifest, type DatasetManifest } from "./dataset-seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");

export class ReadmeLeakError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ReadmeLeakError";
  }
}

/** Table names from the dataset's schema.sql, in CREATE order. Returns [] when
 *  the schema can't be read — the README simply omits the table list. */
export function parseTableNames(datasetRef: string): string[] {
  try {
    const sql = readFileSync(resolve(REPO_ROOT, datasetRef, "schema.sql"), "utf8");
    return [...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)].map(
      (m) => m[1]!,
    );
  } catch {
    return [];
  }
}

/** Doc titles from the scenario's docs jsonb (tolerant of shape drift). */
function docTitles(docs: unknown[]): string[] {
  const out: string[] = [];
  for (const d of docs ?? []) {
    if (d && typeof d === "object") {
      const t = (d as Record<string, unknown>)["title"];
      if (typeof t === "string" && t.trim()) out.push(t.trim());
    }
  }
  return out;
}

export function buildWorkspaceReadme(scenario: Scenario, tables: string[]): string {
  const client = personaMeta(scenario.client_persona);
  const team = personaMeta(scenario.team_persona);
  const docs = docTitles(scenario.docs);
  const deliverableComponents = Array.isArray(
    (scenario.deliverable_spec as Record<string, unknown>)?.["components"],
  )
    ? ((scenario.deliverable_spec as Record<string, unknown>)["components"] as unknown[]).length
    : 0;

  // "fde" is the internal role key; spell it out for the candidate.
  const roleLabel = scenario.role === "fde" ? "forward-deployed engineer" : scenario.role;

  const lines: string[] = [];
  lines.push(`# ${scenario.title} — workspace guide`);
  lines.push("");
  lines.push(
    `You are the **${roleLabel}**. Your full instructions and the situation are in the **Brief** tab — read that first. This file is just the map, so you spend your time solving, not searching.`,
  );
  lines.push("");
  // Dataset-kind-aware inventory: sqlite scenarios get the customer.db map,
  // git_repo scenarios get the inherited-codebase map. The manifest read is
  // tolerant (absent → sqlite), matching the seeder's dispatch exactly.
  const manifest: DatasetManifest = scenario.dataset_ref
    ? readDatasetManifest(scenario.dataset_ref)
    : { kind: "sqlite", root: ".", workspace_dir: "" };

  lines.push(`## What's in this workspace`);
  if (manifest.kind === "git_repo") {
    lines.push(
      `- \`${manifest.workspace_dir}/\` — the codebase you've inherited: source, tests, docs, and its \`data/\` directory (writable — fixing this code is the job).`,
    );
    lines.push(`- \`README.md\` — this guide. The repo has its own README too.`);
    lines.push("");
    lines.push(`## Working with the code`);
    lines.push(`- **Terminal** tab — a full shell: run the service, run its tests, grep, git.`);
    lines.push(`- **Editor** (this pane) — open and edit the repo's files directly.`);
  } else {
    if (tables.length > 0) {
      lines.push(
        `- \`customer.db\` — a read-only SQLite copy of the data you'll be working with. Tables: ${tables.map((t) => `\`${t}\``).join(", ")}.`,
      );
    } else {
      lines.push(`- \`customer.db\` — a read-only SQLite copy of the data you'll be working with.`);
    }
    lines.push(`- \`README.md\` — this guide.`);
    lines.push("");
    lines.push(`## Working with the data`);
    lines.push(`- **Data** tab — run SQL against \`customer.db\` (the fastest path).`);
    lines.push(`- **Terminal** tab — a full shell in this workspace.`);
    lines.push(`- **Editor** (this pane) — create files freely for notes or query drafts.`);
  }
  lines.push("");
  lines.push(`## Who's in the chat (Messages tab)`);
  // Skip the "(your client/teammate)" gloss when the persona's role string
  // already says so ("senior engineer / teammate" reads badly doubled).
  if (client) {
    const gloss = /client/i.test(client.role) ? "" : " (your client)";
    lines.push(`- **${client.name}** — ${client.role}${gloss}.`);
  }
  if (team) {
    const gloss = /teammate/i.test(team.role) ? "" : " (your teammate)";
    lines.push(`- **${team.name}** — ${team.role}${gloss}.`);
  }
  lines.push(
    `Both are in one shared channel — use the **To:** toggle above the message box to pick who you're addressing. They see the whole conversation.`,
  );
  lines.push("");
  lines.push(`## Where everything lives`);
  lines.push(`- **Brief** — your instructions, the situation, and your constraints.`);
  if (docs.length > 0) {
    lines.push(`- **Docs** — reference documents: ${docs.map((t) => `“${t}”`).join(", ")}.`);
  } else {
    lines.push(`- **Docs** — reference documents for the task.`);
  }
  lines.push(
    `- **Deliverable** — ${deliverableComponents > 0 ? `exactly what you must submit (${deliverableComponents} component${deliverableComponents === 1 ? "" : "s"})` : "what you must submit"}, and where you submit it.`,
  );
  lines.push(`- **Assistant** — an AI helper. It draws on your session token budget, so spend deliberately.`);
  lines.push(`- **Live status** (top bar) — time, tokens, and budget remaining.`);
  lines.push("");
  lines.push(
    `When you're done, submit through the **Deliverable** tab before the clock runs out.`,
  );
  lines.push("");
  return lines.join("\n");
}

// ─── Leak guard ──────────────────────────────────────────────────────────────

/** Collect forbidden tokens from a ground-truth JSON value: numbers with
 *  |value| >= 1000 (distinctive figures — cents totals, row counts) and string
 *  leaves of length >= 25 (narratives, discriminators). Short strings and
 *  small numbers are skipped deliberately: table/column names and month labels
 *  are candidate-visible by design and would only false-positive. */
function forbiddenTokens(node: unknown, out: Set<string>): void {
  if (typeof node === "number") {
    if (Math.abs(node) >= 1000) out.add(String(node));
    return;
  }
  if (typeof node === "string") {
    if (node.trim().length >= 25) out.add(node.trim().toLowerCase());
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) forbiddenTokens(v, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) forbiddenTokens(v, out);
  }
}

function neverReveals(persona: Record<string, unknown> | null | undefined): string[] {
  const raw = persona?.["never_reveals"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length >= 25);
}

/** Throw ReadmeLeakError if the rendered README contains any ground-truth
 *  figure/narrative or a persona never_reveals sentence. `datasetRef` may be
 *  null (scenario without a dataset) — ground-truth checks are skipped, the
 *  persona checks still run. */
export function assertNoAnswerLeak(
  readme: string,
  scenario: Scenario,
  datasetRef: string | null,
): void {
  const haystack = readme.toLowerCase();
  const tokens = new Set<string>();

  if (datasetRef) {
    try {
      const gt = JSON.parse(readFileSync(resolve(REPO_ROOT, datasetRef, "ground_truth.json"), "utf8"));
      forbiddenTokens(gt, tokens);
    } catch {
      // No ground truth on disk — nothing to check against (dev scenarios).
    }
  }
  for (const s of [...neverReveals(scenario.client_persona), ...neverReveals(scenario.team_persona)]) {
    tokens.add(s.toLowerCase());
  }

  for (const token of tokens) {
    if (haystack.includes(token)) {
      throw new ReadmeLeakError(
        `[workspace-readme] refusing to provision: generated README for scenario ` +
          `"${scenario.slug}" contains an answer-bearing token (${token.slice(0, 60)}…). ` +
          `Check the scenario's candidate-visible fields (title/brief/docs/roles).`,
      );
    }
  }
}

/** Render + guard in one step — the only entry point provisioning should use. */
export function renderGuardedReadme(scenario: Scenario, tables: string[]): string {
  const readme = buildWorkspaceReadme(scenario, tables);
  assertNoAnswerLeak(readme, scenario, scenario.dataset_ref);
  return readme;
}
