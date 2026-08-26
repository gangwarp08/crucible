// Orchestrator entrypoint for the robustness harness.
//
//   pnpm --filter @crucible/server exec tsx scripts/robustness/run.ts --dry-run
//   pnpm --filter @crucible/server exec tsx scripts/robustness/run.ts \
//       CLASSES=genuine SCENARIOS=fde-db-triage TRIALS=1 SPEED=0.25
//
// --dry-run needs NO infra: it expands the manifest and prints a cost
// projection. A live run needs the dev server up, Supabase reachable, and a
// funded Gemini wallet (both the per-session candidate keys AND the simulator
// key draw on it). If infra is missing, a live run SKIPs cleanly (exit 0).
//
// Flags may be passed as --dry-run / --live or as ENV=VALUE tokens.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import {
  REPO_ROOT, supabase, getScenarioIdBySlug, createSession, startClock,
  fetchBootstrap, openMessagingWs, closeBus, endSession, pollForEval,
  fetchSessionRow, fetchTodaySpendUsd, mintSessionLink, withRetry, sleep,
} from "./shared.js";
import { litellmConfigured, mintSimulatorKey, revokeSimulatorKey, simSpend } from "./llm.js";
import { runCandidateAgent, type ScenarioDoc } from "./candidate-agent.js";
import { pacerFor } from "./pacing.js";
import {
  defaultOptsFromEnv, expandManifest, perSessionCost, COST_MODEL, type RunSpec,
} from "./manifest.js";
import { buildReport, type RunResult } from "./report.js";

// Allow ENV=VALUE tokens on argv (convenience alongside real env vars).
for (const a of process.argv.slice(2)) {
  const m = a.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]!] = m[2]!;
}
const DRY = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const SPEED = Number(process.env.SPEED ?? "1");
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "3");
const WALLET_USD = Number(process.env.WALLET_USD ?? "100");
const MAX_STEPS = Number(process.env.MAX_STEPS ?? "40");
const SIM_BUDGET_MINUTES = Number(process.env.SIM_KEY_MINUTES ?? "600");
// When set, every synthetic session is created under this org (via a minted
// single-use link) so runs are visible to that org's review key + admin, and
// stay out of the default asaya tenant.
const ORG_KEY = process.env.ORG_KEY ?? "";

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(REPO_ROOT, `docs/robustness/${runId}`);

function loadScenarioDocs(slug: string): { docs: ScenarioDoc[]; brief: string | null } {
  const path = resolve(REPO_ROOT, `fixtures/${slug}/scenario.json`);
  if (!existsSync(path)) return { docs: [], brief: null };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as {
      docs?: Array<{ id: string; title: string; body: string }>; brief?: string;
    };
    return { docs: j.docs ?? [], brief: j.brief ?? null };
  } catch { return { docs: [], brief: null }; }
}

function projectCost(nRuns: number): string {
  const L: string[] = [];
  for (const [name, tier] of Object.entries(COST_MODEL.tiers)) {
    const per = perSessionCost(tier);
    const base = per * nRuns;
    const withOverhead = base * 1.3; // reruns / failed-run waste / re-scoring
    L.push(`  gemini-${name}: ~$${per.toFixed(3)}/session × ${nRuns} = $${base.toFixed(2)} (≈ $${withOverhead.toFixed(2)} with +30% overhead)`);
  }
  return L.join("\n");
}

async function driveOne(spec: RunSpec, simKey: string): Promise<RunResult> {
  const base: RunResult = {
    personaId: spec.persona.id, personaClass: spec.persona.class, skill: spec.persona.skill,
    expectBand: spec.persona.expectBand, scenarioSlug: spec.scenario.slug, family: spec.scenario.family,
    trial: spec.trial, sessionId: null, trace: null, session: null, evaluation: null,
  };
  const { docs, brief: fixtureBrief } = loadScenarioDocs(spec.scenario.slug);
  try {
    const scenarioId = await withRetry(() => getScenarioIdBySlug(spec.scenario.slug));
    let linkToken: string | undefined;
    if (ORG_KEY) {
      linkToken = await withRetry(() => mintSessionLink(ORG_KEY, `robustness-${spec.persona.id}-t${spec.trial}`, scenarioId));
    }
    const { sessionId } = await withRetry(() => createSession(scenarioId, linkToken ? { linkToken } : {}));
    base.sessionId = sessionId;
    await startClock(sessionId);
    const bootstrap = await withRetry(() => fetchBootstrap(sessionId));
    if (!bootstrap) throw new Error("no bootstrap state");
    if (!bootstrap.scenarioBrief && fixtureBrief) bootstrap.scenarioBrief = fixtureBrief;
    const bus = await openMessagingWs(sessionId);
    const pacer = pacerFor(spec.persona.skill, SPEED, spec.seed);

    const trace = await runCandidateAgent({
      sessionId, simKey, persona: spec.persona, pacer, bootstrap, docs, bus,
      maxSteps: MAX_STEPS, maxWallMs: 55 * 60_000,
      log: (line) => console.log(`    [${spec.persona.id}/${spec.scenario.slug}#${spec.trial}] ${line}`),
    });
    base.trace = trace;
    closeBus(bus);
    await endSession(sessionId);
    base.evaluation = await pollForEval(sessionId, 180_000);
    base.session = await fetchSessionRow(sessionId);
  } catch (err) {
    base.error = (err as Error).message;
  }
  return base;
}

async function pool(specs: RunSpec[], simKey: string): Promise<RunResult[]> {
  const results: RunResult[] = [];
  let idx = 0;
  let stopped = false;
  const jsonlPath = resolve(outDir, "runs.jsonl");

  async function worker(w: number): Promise<void> {
    while (true) {
      if (stopped) return;
      // Wallet cap: stop launching once simulator spend nears the cap.
      if (simSpend.costUsd >= WALLET_USD) {
        if (!stopped) console.log(`\n⚠ wallet cap reached: simulator spend $${simSpend.costUsd.toFixed(2)} ≥ $${WALLET_USD}. Not launching more runs.`);
        stopped = true; return;
      }
      const my = idx++;
      if (my >= specs.length) return;
      const spec = specs[my]!;
      console.log(`▶ [worker ${w}] run ${my + 1}/${specs.length}: ${spec.persona.id} · ${spec.scenario.slug} · trial ${spec.trial}`);
      const r = await driveOne(spec, simKey);
      results.push(r);
      writeFileSync(jsonlPath, JSON.stringify(summarizeResult(r)) + "\n", { flag: "a" });
      const ov = r.evaluation?.overall_score;
      console.log(`✔ [worker ${w}] ${spec.persona.id}: overall=${ov != null ? ov.toFixed(2) : "—"} scorable=${r.session?.scorable ?? "?"} dur=${r.session?.duration_ms ? Math.round(r.session.duration_ms / 60000) + "m" : "?"} ${r.error ? "ERR:" + r.error : ""}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, specs.length) }, (_, w) => worker(w)));
  return results;
}

function summarizeResult(r: RunResult): Record<string, unknown> {
  return {
    personaId: r.personaId, class: r.personaClass, skill: r.skill, scenario: r.scenarioSlug,
    trial: r.trial, sessionId: r.sessionId, overall: r.evaluation?.overall_score ?? null,
    scorable: r.session?.scorable ?? null, exclusion: r.session?.exclusion_reason ?? null,
    duration_ms: r.session?.duration_ms ?? null, spend_usd: r.session?.spend_usd ?? null,
    submitted: r.trace?.submitted ?? null, actions: r.trace?.actions ?? null,
    accruedSeconds: r.trace?.accruedSeconds ?? null, note: r.trace?.note ?? null, error: r.error ?? null,
  };
}

(async () => {
  const opts = defaultOptsFromEnv();
  const specs = expandManifest(opts);
  console.log(`Robustness harness — runId ${runId}`);
  console.log(`Classes=${opts.classes.join(",")} Scenarios=${opts.scenarioSlugs.join(",")} Trials=${opts.trials} → ${specs.length} runs`);
  console.log(`SPEED=${SPEED} CONCURRENCY=${CONCURRENCY} WALLET_USD=${WALLET_USD} MAX_STEPS=${MAX_STEPS}`);
  console.log(`Org attribution: ${ORG_KEY ? "ON (sessions under the provided ORG_KEY)" : "OFF (default org)"}`);
  console.log(`Simulator models: bulk=${process.env.SIM_MODEL_BULK ?? process.env.SIM_MODEL ?? "gemini-flash"} strong=${process.env.SIM_MODEL_STRONG ?? process.env.SIM_MODEL ?? "gemini-flash"}`);
  console.log("");
  console.log("Persona × scenario breakdown:");
  const counts: Record<string, number> = {};
  for (const s of specs) counts[s.persona.id] = (counts[s.persona.id] ?? 0) + 1;
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  console.log("");
  console.log(`Projected Gemini cost (all-in, both keys):`);
  console.log(projectCost(specs.length));
  console.log("");

  if (DRY) {
    console.log("--dry-run: no sessions created, no spend. Remove --dry-run to execute.");
    return;
  }

  // Live preflight — SKIP cleanly if infra/wallet not ready (family2-harness pattern).
  if (!supabase) { console.log("SKIP: Supabase not configured (SUPABASE_URL/SERVICE_ROLE_KEY)."); return; }
  if (!litellmConfigured()) { console.log("SKIP: LiteLLM not configured (LITELLM_BASE_URL/MASTER_KEY)."); return; }
  try {
    const r = await fetch(process.env.SERVER_URL ?? "http://127.0.0.1:3001", { method: "GET" }).catch(() => null);
    if (!r) { console.log("SKIP: dev server not reachable at SERVER_URL. Start it with `pnpm dev`."); return; }
  } catch { /* tolerate */ }

  const already = await fetchTodaySpendUsd();
  if (already != null) console.log(`Today's cost_ledger spend so far: $${already.toFixed(2)} (global daily ceiling applies separately).`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify({ runId, opts, speed: SPEED, count: specs.length }, null, 2));

  let simKey: string;
  try {
    simKey = await mintSimulatorKey({ alias: `robustness-${runId}`, maxBudgetUsd: WALLET_USD, durationMinutes: SIM_BUDGET_MINUTES });
    console.log(`Minted simulator key (budget $${WALLET_USD}, ${SIM_BUDGET_MINUTES}m).`);
  } catch (err) {
    console.log(`SKIP: could not mint simulator key — ${(err as Error).message}`);
    console.log(`(This usually means the Gemini wallet / LiteLLM key budget isn't funded yet. See docs/robustness README.)`);
    return;
  }

  const t0 = Date.now();
  let results: RunResult[] = [];
  try {
    results = await pool(specs, simKey);
  } finally {
    await revokeSimulatorKey(simKey);
  }

  const report = buildReport(results, {
    runId, classes: opts.classes, scenarios: opts.scenarioSlugs, speed: SPEED,
    simCostUsd: simSpend.costUsd, simCalls: simSpend.calls,
  });
  writeFileSync(resolve(outDir, "report.md"), report);

  console.log(`\n─── done in ${((Date.now() - t0) / 60000).toFixed(1)} min ───`);
  console.log(`Simulator spend: $${simSpend.costUsd.toFixed(4)} (${simSpend.calls} calls, ${simSpend.promptTokens}+${simSpend.completionTokens} tok)`);
  console.log(`Report: ${resolve(outDir, "report.md")}`);
  console.log(`Per-run JSONL: ${resolve(outDir, "runs.jsonl")}`);
  await sleep(50);
})().catch((err) => { console.error(err); process.exit(1); });
