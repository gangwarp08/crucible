/**
 * verify-ai-injection.ts — slice V7 acceptance (judgment-moment injections).
 *
 * Deterministic, infra-light: exercises the pure scheduling/trigger core in
 * src/services/ai-injections.ts plus the new agnostic injection_present
 * evidence unit (and its inertness for sessions without markers). The live
 * chat-route path (directive → model call → fired marker) is covered by the
 * E2E pass.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-ai-injection.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const {
  computeAiInjections,
  rescheduleAiInjections,
  pendingAiInjection,
  injectionAddendum,
} = await import("../src/services/ai-injections.js");
const { runDetectors } = await import("../src/services/evidence-extractor.js");
type EventRow = import("../src/services/evidence-extractor.js").EventRow;
type Scenario = import("../src/services/scenarios.js").Scenario;

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

const T0 = Date.parse("2026-10-11T10:00:00.000Z");

function scenarioWith(curveballs: unknown[], difficulty = "mid"): Scenario {
  return {
    id: "s", slug: "fde-db-triage", title: "t", role: "r", difficulty,
    brief: null, client_persona: {}, team_persona: {}, dataset_ref: null,
    docs: [], constraints: {}, rubric: {}, deliverable_spec: {},
    curveballs, success_criteria: {}, created_at: new Date(T0).toISOString(),
  };
}

console.log("verify-ai-injection — slice V7\n");

// ── [a] parsing + band gating ────────────────────────────────────────────────
{
  console.log("[a] computeAiInjections");
  const scheduled = computeAiInjections(
    scenarioWith([
      // Ordinary persona curveball — must be ignored here.
      { id: "beat1", trigger: { time_offset_minutes: 5 }, payload: { channel: "client", message: "hi" } },
      // Turn-triggered injection.
      { id: "inj_turn", kind: "ai_injection", trigger: { turn: 3 }, directive: "suggest full table scan" },
      // Time-triggered injection.
      { id: "inj_time", kind: "ai_injection", trigger: { time_offset_minutes: 10 }, directive: "suggest catching and ignoring the error" },
      // Band-gated above this session (mid < hard) — skipped.
      { id: "inj_hard", kind: "ai_injection", difficulty_band: "hard", trigger: { turn: 1 }, directive: "x" },
      // Malformed — skipped.
      { id: "inj_bad", kind: "ai_injection", trigger: {}, directive: "y" },
    ]),
    T0,
  );
  check("persona curveballs ignored", !scheduled.some((i) => i.id === "beat1"));
  check("two valid injections scheduled", scheduled.length === 2, scheduled.map((i) => i.id).join(","));
  check("turn trigger parsed", scheduled.find((i) => i.id === "inj_turn")?.turn === 3);
  check(
    "time trigger parsed",
    scheduled.find((i) => i.id === "inj_time")?.due_ts === new Date(T0 + 10 * 60_000).toISOString(),
  );
  check("band gate skips hard on mid session", !scheduled.some((i) => i.id === "inj_hard"));
  check("hard session includes hard injection",
    computeAiInjections(
      scenarioWith([{ id: "inj_hard", kind: "ai_injection", difficulty_band: "hard", trigger: { turn: 1 }, directive: "x" }], "hard"),
      T0,
    ).length === 1);
}

// ── [b] trigger logic ────────────────────────────────────────────────────────
{
  console.log("\n[b] pendingAiInjection");
  const injections = [
    { id: "a", directive: "d1", turn: 3, fired: false },
    { id: "b", directive: "d2", due_ts: new Date(T0 + 600_000).toISOString(), fired: false },
  ];
  check("turn 1: nothing due", pendingAiInjection(injections, 1, T0) === null);
  check("turn 3: turn injection due", pendingAiInjection(injections, 3, T0)?.id === "a");
  check("time passed: time injection due",
    pendingAiInjection([injections[1]!], 1, T0 + 600_001)?.id === "b");
  check("fired injections skipped",
    pendingAiInjection([{ ...injections[0]!, fired: true }], 5, T0) === null);
  check("malformed state → null", pendingAiInjection("garbage", 5, T0) === null);
  const addendum = injectionAddendum(injections[0]!);
  check("addendum embeds the directive", addendum.includes("d1"));
  check("addendum demands invisibility", /never mention/i.test(addendum));
}

// ── [c] reschedule on clock start ────────────────────────────────────────────
{
  console.log("\n[c] rescheduleAiInjections");
  const list = [
    { id: "a", directive: "d", turn: 2, fired: false },
    { id: "b", directive: "d", due_ts: new Date(T0 + 300_000).toISOString(), fired: false },
  ];
  const later = T0 + 120_000;
  const res = rescheduleAiInjections(list, T0, later);
  check("turn triggers untouched", res[0]!.turn === 2 && res[0]!.due_ts === undefined);
  check("time triggers slide, offset preserved",
    res[1]!.due_ts === new Date(later + 300_000).toISOString());
}

// ── [d] evidence unit + inertness ────────────────────────────────────────────
{
  console.log("\n[d] injection_present evidence unit");
  const T = new Date(T0).toISOString();
  const base: EventRow[] = [
    { seq: 1, type: "ai.assistant.candidate", actor: "candidate", ts: T, payload: { text: "help" } },
    { seq: 2, type: "ai.assistant.response", actor: "system", ts: T, payload: { text: "sure" } },
  ];
  const withInjection: EventRow[] = [
    ...base,
    { seq: 3, type: "ai_injection.fired", actor: "system", ts: T, payload: { id: "inj_turn" } },
    { seq: 4, type: "ai.assistant.candidate", actor: "candidate", ts: T, payload: { text: "that seems wrong?" } },
  ];
  const unitsClean = runDetectors("fde-db-triage", base, {});
  const unitsInj = runDetectors("fde-db-triage", withInjection, {});
  const injUnits = unitsInj.filter((u) => u.kind === "injection_present");
  check("unit emitted when marker present", injUnits.length === 1);
  check("binds to ai_orchestration", injUnits[0]?.competency_key === "ai_orchestration");
  check("cites the marker + follow-up seqs",
    JSON.stringify(injUnits[0]?.event_seqs) === JSON.stringify([3, 4]));
  check("value carries id + responded",
    JSON.stringify(injUnits[0]?.value) === JSON.stringify({ id: "inj_turn", candidate_responded: true }));
  check("INERT without markers (no injection units)",
    !unitsClean.some((u) => u.kind === "injection_present"));
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
