// verify-persona-scenario-driven.ts
//
// Verifies the persona subsystem is scenario-driven for non-family-1 scenarios
// WITHOUT changing the LIVE, calibrated family-1 (fde-db-triage) prompts.
//
// Three checks, all PURE (no LLM calls, no DB writes, no live session, zero
// budget spend). Persona JSON is read from the fixtures that mirror the DB:
//   fixtures/fde-db-triage/scenario.json
//   fixtures/fde-api-integration/scenario.json
//
// (a) FAMILY-1 SNAPSHOT — buildClientSystemPrompt / buildTeamSystemPrompt for
//     fde-db-triage must still contain the calibrated family-1 phrases and be
//     routed to the HARDCODED builders (isFamilyOneSlug === true). This is the
//     measurement-preservation guarantee.
// (b) FAMILY-2 GENERIC — the generic builders, fed fde-api-integration's
//     persona JSON, must carry the API-integration domain and must NOT carry
//     any family-1 (revenue/refund) domain.
// (c) ROUTING — fde-db-triage → hardcoded, fde-api-integration → generic.
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

// persona-agent transitively imports env.ts, which validates required env vars
// at module-load. Load .env BEFORE that import so a pure prompt-building check
// doesn't fail on missing LiteLLM/E2B/JWT config. No network / DB calls follow.
loadEnv({ path: resolve(repoRoot, ".env") });

const {
  buildClientSystemPrompt,
  buildTeamSystemPrompt,
  buildClientSystemPromptGeneric,
  buildTeamSystemPromptGeneric,
  isFamilyOneSlug,
} = await import("../src/services/persona-agent.js");
const { freshPersonaState } = await import("../src/services/registry.js");

interface ScenarioFixture {
  slug: string;
  brief: string | null;
  client_persona: ClientPersonaJson;
  team_persona: ClientPersonaJson;
}

function loadFixture(slug: string): ScenarioFixture {
  const path = resolve(repoRoot, "fixtures", slug, "scenario.json");
  return JSON.parse(readFileSync(path, "utf8")) as ScenarioFixture;
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Regex sets from the task spec.
const FAMILY1_DOMAIN =
  /revenue dashboard|refunds not being subtracted|monthly recognized revenue|\$1\.5M/i;
const FAMILY2_DOMAIN = /contact|sync|token|401|ContactHub|pagination|cursor|hardcod/i;

const fam1 = loadFixture("fde-db-triage");
const fam2 = loadFixture("fde-api-integration");

// ── (a) Family-1 snapshot ────────────────────────────────────────────────────
console.log("\n(a) family-1 (fde-db-triage) snapshot — hardcoded builders unchanged");
{
  const client = buildClientSystemPrompt(fam1.client_persona, {
    revealed_specifics: false,
    requirement_changed: false,
  });
  const team = buildTeamSystemPrompt(fam1.team_persona, {
    gave_refund_hint: false,
    gave_webhook_clue: false,
    gave_shortcut_pitch: false,
  });

  // Calibrated family-1 phrases that MUST survive verbatim in the hardcoded
  // prompts. If any of these drift, cohort-1 comparability is at risk.
  const clientMust = [
    "You are Dana, VP Finance at Meridian (a B2B SaaS company).",
    "monthly revenue dashboard looks materially too high.",
    'The tile in question is the "monthly recognized revenue" tile.',
    "Finance expected roughly $1.1M-$1.3M per month.",
    "The dashboard shows roughly $1.5M+ per month.",
  ];
  for (const phrase of clientMust) {
    check(`client prompt contains: ${JSON.stringify(phrase.slice(0, 48))}…`, client.includes(phrase));
  }

  const teamMust = [
    `You are Sam, ${fam1.team_persona.role} at Meridian.`,
    "pretty sure it's refunds not being subtracted, just filter those out.",
    "payments come in via Stripe webhooks",
    "the raw monthly SUM is close enough",
  ];
  for (const phrase of teamMust) {
    check(`team prompt contains: ${JSON.stringify(phrase.slice(0, 48))}…`, team.includes(phrase));
  }

  // Scaffolding must remain.
  check("client prompt has ANTI_JAILBREAK", client.includes("a real human. You are NOT an AI"));
  check("client prompt has JSON output directive", client.includes("RESPOND AS JSON ONLY"));
  check(
    "client prompt uses the fixed family-1 reveal enum",
    client.includes('["specifics" | "refund_hint" | "webhook_clue" | "shortcut_pitch"]'),
  );
  check("team prompt has JSON output directive", team.includes("RESPOND AS JSON ONLY"));

  // Routing: family-1 slug must select the hardcoded path.
  check("fde-db-triage routes to HARDCODED (isFamilyOneSlug === true)", isFamilyOneSlug(fam1.slug));
}

// ── (b) Family-2 generic ─────────────────────────────────────────────────────
console.log("\n(b) family-2 (fde-api-integration) generic builders — scenario-driven");
{
  const state = freshPersonaState();
  const client = buildClientSystemPromptGeneric(fam2.client_persona, fam2.brief, state);
  const team = buildTeamSystemPromptGeneric(fam2.team_persona, fam2.brief, state);

  // Persona identity comes from the scenario JSON, not a family-1 hardcode.
  check("client prompt names Maya (from scenario JSON)", client.includes("Maya"));
  check("team prompt keeps the scenario team role", team.includes(fam2.team_persona.role ?? "___"));

  // Domain: API-integration terms present.
  check("client prompt carries API-integration domain", FAMILY2_DOMAIN.test(client), "no domain match");
  check("team prompt carries API-integration domain", FAMILY2_DOMAIN.test(team), "no domain match");

  // The team beats carry the family-2 specifics (token 401s, hardcode paging).
  check("team prompt mentions 401s (from beats behavior)", /401/.test(team));
  check("team prompt mentions hardcode/paging (from beats behavior)", /hardcod|paging|cursor|page/i.test(team));

  // NEGATIVE: NO family-1 domain must leak into the generic prompts.
  check("client prompt has NO family-1 domain", !FAMILY1_DOMAIN.test(client), "family-1 domain leaked");
  check("team prompt has NO family-1 domain", !FAMILY1_DOMAIN.test(team), "family-1 domain leaked");

  // Scaffolding preserved in the generic path too.
  check("generic client prompt has ANTI_JAILBREAK", client.includes("a real human. You are NOT an AI"));
  check("generic client prompt has JSON output directive", client.includes("RESPOND AS JSON ONLY"));
  check("generic team prompt has JSON output directive", team.includes("RESPOND AS JSON ONLY"));

  // Beat-id-driven reveals: the generic JSON directive enumerates the
  // scenario's own beat ids (NOT the family-1 reveal keys).
  const teamBeatIds = (fam2.team_persona.beats ?? []).map((b) => b.id).filter(Boolean) as string[];
  for (const id of teamBeatIds) {
    check(`generic team reveal enum includes beat id "${id}"`, team.includes(JSON.stringify(id)));
  }
  check(
    "generic team prompt does NOT use the fixed family-1 reveal enum",
    !team.includes('["specifics" | "refund_hint" | "webhook_clue" | "shortcut_pitch"]'),
  );

  // Proactive generic beat renders the payload message in-voice.
  const proactive = buildTeamSystemPromptGeneric(fam2.team_persona, fam2.brief, state, {
    beatId: "hardcode_workaround",
    payloadMessage:
      "honestly we're tight on time — quickest fix: pin the page size back and skip the cursor handling.",
    behavior: (fam2.team_persona.beats ?? []).find((b) => b.id === "shortcut_pitch")?.behavior,
  });
  check("generic proactive prompt enters PROACTIVE BEAT MODE", proactive.includes("PROACTIVE BEAT MODE"));
  check("generic proactive prompt carries the payload message", proactive.includes("pin the page size back"));
  check("generic proactive prompt has NO family-1 domain", !FAMILY1_DOMAIN.test(proactive));
}

// ── (c) Routing ──────────────────────────────────────────────────────────────
console.log("\n(c) routing");
{
  check("fde-db-triage → hardcoded", isFamilyOneSlug("fde-db-triage"));
  check("fde-db-triage-iso → hardcoded (variant)", isFamilyOneSlug("fde-db-triage-iso"));
  check("fde-db-triage-pro → hardcoded (variant)", isFamilyOneSlug("fde-db-triage-pro"));
  check("fde-api-integration → generic", !isFamilyOneSlug("fde-api-integration"));
  check("fde-api-integration-pro → generic (variant)", !isFamilyOneSlug("fde-api-integration-pro"));
}

console.log("");
if (failures > 0) {
  console.error(`verify-persona-scenario-driven: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-persona-scenario-driven: ALL CHECKS PASSED");
process.exit(0);
