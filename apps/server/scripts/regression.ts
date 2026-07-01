/**
 * Crucible regression runner (Slice 5.0).
 *
 * Runs the `verify-*.ts` suite serially against a LIVE server + real Supabase +
 * real LiteLLM/Gemini, aggregates pass/fail, and exits non-zero if anything
 * failed. This is the single command the asaya v1 build leans on to prove a
 * slice "did not regress the suite" — before 5.0 there was no such command and
 * most verifiers 401'd on stale auth.
 *
 * Usage (from repo root):
 *   pnpm --filter @crucible/server regression                 # default suite
 *   pnpm --filter @crucible/server regression discrimination  # subset by name
 *   REGRESSION_FULL=1 pnpm --filter @crucible/server regression
 *
 * Env:
 *   SERVER_URL              default http://127.0.0.1:3001 (matches the verifiers)
 *   REGRESSION_COOLDOWN_MS  pause between scripts to dodge Gemini rate limits
 *                           (default 60000; set 0 to disable)
 *   REGRESSION_FULL=1       also run the baseline-coupled verifiers (see below)
 *
 * Each verifier exits 0 on PASS / non-zero on FAIL (or SKIP-on-quota, which
 * those scripts treat as non-failing and still exit 0). We just collect codes.
 *
 * NOTE on the baseline-coupled verifiers (verify-gradient, verify-anchor-tuning):
 * they reuse STRONG/WEAK baseline session IDs from a prior discrimination run,
 * supplied via BASELINE_*_ID env. They are NOT self-contained, so they are
 * EXCLUDED from the default suite. Run them with REGRESSION_FULL=1 only after
 * exporting the baseline IDs the discrimination run printed.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const COOLDOWN_MS = Number(process.env.REGRESSION_COOLDOWN_MS ?? "60000");
const FULL = process.env.REGRESSION_FULL === "1";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Verifier {
  name: string; // short name for CLI selection + reporting
  file: string; // filename under scripts/
  note?: string;
}

// Self-contained verifiers — each provisions its own session(s).
const CORE: Verifier[] = [
  { name: "competency-model", file: "verify-competency-model.ts", note: "Supabase-only (no server/LLM)" },
  { name: "session-lifecycle", file: "verify-session-lifecycle.ts", note: "deterministic; needs 0014" },
  { name: "evidence-units", file: "verify-evidence-units.ts", note: "deterministic, no LLM" },
  { name: "outcomes", file: "verify-outcomes.ts", note: "deterministic, no LLM/server" },
  { name: "outcome-invites", file: "verify-outcome-invites.ts", note: "deterministic, no LLM/server" },
  { name: "drift", file: "verify-drift.ts", note: "deterministic, no LLM/server" },
  { name: "fairness", file: "verify-fairness.ts", note: "deterministic seam, no LLM/server" },
  { name: "fde-db-triage", file: "verify-fde-db-triage.ts" },
  { name: "submit-lock", file: "verify-submit-lock.ts", note: "server + 1 E2B session" },
  { name: "candidate-surfaces", file: "verify-candidate-surfaces.ts" },
  { name: "ai-assistant", file: "verify-ai-assistant.ts" },
  { name: "messages", file: "verify-messages.ts" },
  { name: "proactive-beats", file: "verify-proactive-beats.ts" },
  { name: "verification", file: "verify-verification.ts", note: "multi-turn WS + 2 evals" },
  { name: "verification-outcomes", file: "verify-verification-outcomes.ts", note: "RD2 defense logic + cap endpoint" },
  { name: "scorability", file: "verify-scorability.ts", note: "RD3 deterministic decision table" },
  { name: "competency-gating", file: "verify-competency-gating.ts", note: "RD4 not_assessed + reweight" },
  { name: "judge-injection", file: "verify-judge-injection.ts", note: "RD5 fence + injection canary" },
  { name: "rehydrate", file: "verify-rehydrate.ts" },
  { name: "scenario-state-race", file: "verify-scenario-state-race.ts" },
  { name: "discrimination", file: "verify-discrimination.ts" },
  { name: "pro-discrimination", file: "verify-pro-discrimination.ts" },
  { name: "analysis-agent", file: "verify-analysis-agent.ts" },
  { name: "isomorph-equivalence", file: "verify-isomorph-equivalence.ts", note: "2 matched LLM playthroughs" },
  { name: "reliability", file: "verify-reliability.ts", note: "N Stage-B reinterprets (LLM)" },
];

// Need baseline session IDs from a prior discrimination run (BASELINE_*_ID env).
const COUPLED: Verifier[] = [
  { name: "gradient", file: "verify-gradient.ts", note: "needs BASELINE_*_ID" },
  { name: "anchor-tuning", file: "verify-anchor-tuning.ts", note: "needs BASELINE_*_ID" },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function healthCheck(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVER_URL}/health`, { method: "GET" });
    return r.ok;
  } catch {
    return false;
  }
}

interface RunResult {
  name: string;
  code: number | null;
  durationMs: number;
}

function runVerifier(v: Verifier): RunResult {
  const abs = resolve(HERE, v.file);
  const started = Date.now();
  console.log(`\n${"=".repeat(72)}\n▶ ${v.name}  (${v.file})\n${"=".repeat(72)}`);
  // `pnpm exec tsx` resolves the workspace-local tsx binary regardless of cwd.
  const proc = spawnSync("pnpm", ["exec", "tsx", abs], {
    stdio: "inherit",
    env: process.env,
  });
  return { name: v.name, code: proc.status, durationMs: Date.now() - started };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const pool = FULL ? [...CORE, ...COUPLED] : CORE;

  // Subset selection: any arg matches a verifier name as a substring.
  const suite =
    args.length > 0
      ? pool.filter((v) => args.some((a) => v.name.includes(a)))
      : pool;

  if (suite.length === 0) {
    console.error(`No verifiers matched: ${args.join(", ")}`);
    console.error(`Known: ${[...CORE, ...COUPLED].map((v) => v.name).join(", ")}`);
    process.exit(2);
  }

  console.log(`Crucible regression — ${suite.length} verifier(s) against ${SERVER_URL}`);
  console.log(`Cooldown between scripts: ${COOLDOWN_MS}ms${FULL ? "  [FULL: incl. baseline-coupled]" : ""}`);
  if (!FULL) {
    console.log(`(omitting baseline-coupled: ${COUPLED.map((v) => v.name).join(", ")} — set REGRESSION_FULL=1)`);
  }

  if (!(await healthCheck())) {
    console.error(`\n✗ Server not reachable at ${SERVER_URL}/health — start the server first.`);
    process.exit(2);
  }

  const results: RunResult[] = [];
  for (let i = 0; i < suite.length; i++) {
    results.push(runVerifier(suite[i]!));
    if (COOLDOWN_MS > 0 && i < suite.length - 1) {
      console.log(`\n… cooldown ${COOLDOWN_MS}ms before next verifier`);
      await sleep(COOLDOWN_MS);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(72)}\nREGRESSION SUMMARY\n${"=".repeat(72)}`);
  let failed = 0;
  for (const r of results) {
    const ok = r.code === 0;
    if (!ok) failed++;
    const status = ok ? "PASS" : r.code === null ? "ERROR(signal)" : `FAIL(${r.code})`;
    console.log(`  ${ok ? "✓" : "✗"} ${r.name.padEnd(22)} ${status.padEnd(14)} ${(r.durationMs / 1000).toFixed(1)}s`);
  }
  console.log(`${"-".repeat(72)}\n  ${results.length - failed}/${results.length} passed`);

  process.exit(failed === 0 ? 0 : 1);
}

void main();
