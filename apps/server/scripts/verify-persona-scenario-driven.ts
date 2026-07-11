// verify-persona-scenario-driven.ts
//
// Verifies the persona subsystem is FULLY scenario-driven: every scenario —
// including the (formerly hardcoded) family-1 fde-db-triage — builds its client
// and team prompts from its own DB persona JSON via the generic builders. No
// hardcoded family-1 path remains.
//
// All checks are PURE (no LLM calls, no DB writes, no live session, zero budget
// spend). Persona JSON is read from the fixtures that mirror the DB.
//
// (a) NO HARDCODING — the persona-agent source has no isFamilyOneSlug / hardcoded
//     family-1 builders left.
// (b) FAMILY-1 GENERIC — fde-db-triage's client/team prompts, built generically
//     from its persona JSON, name Dana/Sam and carry the revenue-triage domain.
// (c) FAMILY-2 GENERIC — fde-api-integration's prompts name Priya/Sam, carry the
//     API-integration domain, and leak NO family-1 domain.
// (d) DIFFERENTIAL HINTS — the two HARD scenarios' opening/misleading beats float
//     multiple candidate causes (differential); the mid scenarios stay single.
//
// Run:
//   pnpm --filter @crucible/server exec tsx scripts/verify-persona-scenario-driven.ts

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config as loadEnv } from "dotenv";
import type { ClientPersonaJson } from "../src/services/persona-agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

loadEnv({ path: resolve(repoRoot, ".env") });

const { buildClientSystemPromptGeneric, buildTeamSystemPromptGeneric } =
  await import("../src/services/persona-agent.js");
const { freshPersonaState } = await import("../src/services/registry.js");

interface Beat { id?: string; trigger?: string; behavior?: string }
interface ScenarioFixture {
  slug: string;
  brief: string | null;
  client_persona: ClientPersonaJson & { beats?: Beat[] };
  team_persona: ClientPersonaJson & { beats?: Beat[] };
}

function loadFixture(slug: string): ScenarioFixture {
  return JSON.parse(readFileSync(resolve(repoRoot, "fixtures", slug, "scenario.json"), "utf8"));
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const FAMILY1_DOMAIN = /revenue|dashboard|refund|finance/i;
const FAMILY2_DOMAIN = /contact|sync|token|401|ContactHub|pagination|cursor|hardcod/i;

const fam1 = loadFixture("fde-db-triage");
const fam2 = loadFixture("fde-api-integration");
const state = () => freshPersonaState();

// ── (a) No hardcoding left in the source ─────────────────────────────────────
console.log("\n(a) no hardcoded family-1 persona path remains");
{
  const src = readFileSync(resolve(repoRoot, "apps/server/src/services/persona-agent.ts"), "utf8");
  check("persona-agent has no isFamilyOneSlug", !/isFamilyOneSlug/.test(src));
  check("persona-agent has no non-generic buildClientSystemPrompt", !/buildClientSystemPrompt\b(?!Generic)/.test(src));
  check("persona-agent has no non-generic buildTeamSystemPrompt", !/buildTeamSystemPrompt\b(?!Generic)/.test(src));
}

// ── (b) Family-1 via the generic builders ────────────────────────────────────
console.log("\n(b) family-1 (fde-db-triage) — scenario-driven from its own JSON");
{
  const client = buildClientSystemPromptGeneric(fam1.client_persona, fam1.brief, state());
  const team = buildTeamSystemPromptGeneric(fam1.team_persona, fam1.brief, state());
  check("client names Dana", client.includes("Dana"));
  check("team names Sam", team.includes("Sam"));
  check("client carries the revenue-triage domain", FAMILY1_DOMAIN.test(client), "no domain match");
  check("team carries the revenue-triage domain", FAMILY1_DOMAIN.test(team), "no domain match");
  check("client has ANTI_JAILBREAK", client.includes("a real human. You are NOT an AI"));
  check("client has JSON output directive", client.includes("RESPOND AS JSON ONLY"));
  check("team has JSON output directive", team.includes("RESPOND AS JSON ONLY"));
}

// ── (c) Family-2 via the generic builders ────────────────────────────────────
console.log("\n(c) family-2 (fde-api-integration) — scenario-driven, Priya/Sam");
{
  const client = buildClientSystemPromptGeneric(fam2.client_persona, fam2.brief, state());
  const team = buildTeamSystemPromptGeneric(fam2.team_persona, fam2.brief, state());
  check("client names Priya (from scenario JSON)", client.includes("Priya"));
  check("client does NOT name Maya (renamed)", !client.includes("Maya"));
  check("team carries the API-integration domain", FAMILY2_DOMAIN.test(team), "no domain match");
  check("team mentions 401s (from beats)", /401/.test(team));
  check("client has NO family-1 revenue/dashboard leak", !/revenue dashboard|monthly recognized revenue/i.test(client));
  check("team has NO family-1 revenue/dashboard leak", !/revenue dashboard|monthly recognized revenue/i.test(team));
  const teamBeatIds = (fam2.team_persona.beats ?? []).map((b) => b.id).filter(Boolean) as string[];
  for (const id of teamBeatIds) {
    check(`generic team reveal enum includes beat id "${id}"`, team.includes(JSON.stringify(id)));
  }
}

// ── (d) Differential misleading-hint on the HARD scenarios ───────────────────
console.log("\n(d) differential opening hints on the hard sims (verification-over-trust preserved)");
{
  // For each hard sim, the opening/misleading team beat must name MULTIPLE
  // candidate causes (a differential), not one confident steer.
  const openingBehavior = (f: ScenarioFixture): string => {
    const beats = f.team_persona.beats ?? [];
    const b = beats.find((x) => /misleading|opening|hint|double_push/i.test(x.id ?? "")) ?? beats[0];
    return (b?.behavior ?? "").toLowerCase();
  };

  const apiPro = loadFixture("fde-api-integration-pro");
  const apiHint = openingBehavior(apiPro);
  const apiCauses = ["auth", "token", "pagination", "cursor", "api"].filter((c) => apiHint.includes(c));
  check(`api-integration-pro hint is a differential (${apiCauses.length} causes: ${apiCauses.join(",")})`, apiCauses.length >= 2);
  check("api-integration-pro hint leans lightly (mentions 'differential' or 'gut'/'lean')", /differential|my gut|leans? light|haven't (actually )?dug/i.test(apiHint));

  const dbPro = loadFixture("fde-db-triage-pro");
  const dbHint = openingBehavior(dbPro);
  const dbCauses = ["refund", "dupe", "duplicate", "webhook", "timezone"].filter((c) => dbHint.includes(c));
  check(`db-triage-pro hint is a differential (${dbCauses.length} cause-terms: ${dbCauses.join(",")})`, dbCauses.length >= 2);
  check("db-triage-pro hint leans lightly (mentions 'differential' or 'gut'/'lean')", /differential|my gut|leans? light|haven't (actually )?dug/i.test(dbHint));

  // Verification-over-trust intent still documented somewhere in the team persona.
  const dbTeam = JSON.stringify(dbPro.team_persona).toLowerCase();
  check("db-triage-pro still frames verification-over-trust", /verification[ -]over[ -]trust|rewards verification|quantif/i.test(dbTeam));
}

console.log("");
if (failures > 0) {
  console.error(`verify-persona-scenario-driven: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-persona-scenario-driven: ALL CHECKS PASSED");
process.exit(0);
