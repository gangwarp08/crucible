/**
 * verify-verification-outcomes.ts — RD2 (Slice 6.3) acceptance.
 *
 * Two layers:
 *  A. DETERMINISTIC (no infra) — the pure defense classifier + cap-status logic
 *     in src/services/defense.ts: answer classification, session-level defense
 *     outcome, advisory-vs-applied mapping, and the execution-cap arithmetic.
 *  B. SERVER + SUPABASE — the POST /api/review/sessions/:id/verification-cap
 *     endpoint: seed a session + evaluation in `advisory_pending`, confirm the
 *     cap (execution → 3, overall recomputed, status confirmed), assert the
 *     second confirm 409s (idempotent), and that override leaves scores intact.
 *
 * Exit 0 on PASS, non-zero on FAIL. Layer B SKIPs (non-failing) when Supabase
 * creds or the server are absent, so the deterministic core always runs in CI.
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";
import { WebSocket } from "undici";
import {
  classifyAnswer,
  computeDefenseOutcome,
  capStatusFor,
  applyExecutionCap,
  VERIFICATION_CAP_SCORE,
} from "../src/services/defense.js";
import type { CondensedVerification } from "../src/services/analysis-input.js";

const here = dirname(fileURLToPath(import.meta.url));
// .env lives at the repo root (apps/server/scripts → ../../../.env).
loadEnv({ path: resolve(here, "../../../.env") });

const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

// ── Helpers to build CondensedVerification fixtures ──────────────────────────
function vfn(prompted: boolean, answers: string[]): CondensedVerification {
  const turns: CondensedVerification["turns"] = [];
  let seq = 1;
  const qCount = Math.max(answers.length, prompted ? 1 : 0);
  for (let i = 0; i < qCount; i++) {
    turns.push({ seq: seq++, role: "verifier", text: `Defend decision ${i + 1}?` });
    if (i < answers.length) turns.push({ seq: seq++, role: "candidate", text: answers[i]! });
  }
  return { prompted, turns };
}

// ── Layer A: deterministic ───────────────────────────────────────────────────
function layerA(): void {
  console.log("\nLayer A — deterministic defense classifier + cap logic");

  // classifyAnswer
  check("classify: empty → refusal", classifyAnswer("") === "refusal");
  check("classify: 'I dont know' → refusal", classifyAnswer("I don't know honestly") === "refusal");
  check("classify: credits the AI → refusal", classifyAnswer("the AI wrote that query for me") === "refusal");
  check("classify: terse → weak", classifyAnswer("the query") === "weak");
  check(
    "classify: substantive → strong",
    classifyAnswer("I deduped on charge_id because the export double-counted retried captures, then summed.") === "strong",
  );

  // computeDefenseOutcome
  check("outcome: not prompted → null", computeDefenseOutcome(vfn(false, [])) === null);
  check("outcome: prompted, no answers → not_reached", computeDefenseOutcome(vfn(true, [])) === "not_reached");
  check(
    "outcome: all refusals → declined",
    computeDefenseOutcome(vfn(true, ["I don't know", "no idea", "the ai did it"])) === "declined",
  );
  check(
    "outcome: one weak among strong → weak",
    computeDefenseOutcome(
      vfn(true, [
        "I deduped on charge_id because the export double-counted retried captures.",
        "the query",
      ]),
    ) === "weak",
  );
  check(
    "outcome: all strong → coherent",
    computeDefenseOutcome(
      vfn(true, [
        "I deduped on charge_id because the export double-counted retried captures, then summed net.",
        "I filtered status='succeeded' so refunds and failures were excluded from revenue.",
      ]),
    ) === "coherent",
  );

  // capStatusFor
  check("cap: weak + advisory → advisory_pending", capStatusFor("weak", true) === "advisory_pending");
  check("cap: weak + !advisory → applied", capStatusFor("weak", false) === "applied");
  check("cap: declined + advisory → advisory_pending", capStatusFor("declined", true) === "advisory_pending");
  check("cap: coherent → none", capStatusFor("coherent", true) === "none");
  check("cap: not_reached → none", capStatusFor("not_reached", true) === "none");
  check("cap: null → none", capStatusFor(null, true) === "none");

  // applyExecutionCap
  const capped = applyExecutionCap([
    { competency: "execution", score: 5 },
    { competency: "communication", score: 5 },
    { competency: "execution", score: 2 },
  ]);
  check("applyCap: execution>3 → 3", capped[0]!.score === VERIFICATION_CAP_SCORE);
  check("applyCap: non-execution untouched", capped[1]!.score === 5);
  check("applyCap: execution already ≤3 untouched", capped[2]!.score === 2);
}

// ── Layer B: server + Supabase endpoint ──────────────────────────────────────
async function seedSession(
  supabase: ReturnType<typeof createClient>,
  capStatus: string,
  execScore: number,
): Promise<{ sessionId: string; evalId: string; priorOverall: number }> {
  const sessionId = randomUUID();
  const evalId = randomUUID();
  // execution 0.5 + communication 0.5; overall = exec*0.5 + 4*0.5
  const priorOverall = Math.round((execScore * 0.5 + 4 * 0.5) * 100) / 100;
  const nowDeadline = new Date(Date.now() + 60_000).toISOString();

  const sErr = (
    await supabase.from("sessions").insert({
      id: sessionId,
      status: "completed",
      sandbox_id: "seed",
      template: "seed",
      litellm_key_alias: "seed",
      model: "seed",
      budget_usd: 1,
      timeout_min: 30,
      deadline: nowDeadline,
      defense_outcome: "weak",
      verification_cap_status: capStatus,
    })
  ).error;
  if (sErr) throw new Error(`session seed: ${sErr.message}`);

  const eErr = (
    await supabase.from("evaluations").insert({
      id: evalId,
      session_id: sessionId,
      overall_score: priorOverall,
      summary: "seed",
      model: "seed",
      status: "complete",
    })
  ).error;
  if (eErr) throw new Error(`evaluation seed: ${eErr.message}`);

  const iErr = (
    await supabase.from("evaluation_items").insert([
      { evaluation_id: evalId, competency: "execution", score: execScore, weight: 0.5, rationale: "seed" },
      { evaluation_id: evalId, competency: "outcome_communication", score: 4, weight: 0.5, rationale: "seed" },
    ])
  ).error;
  if (iErr) throw new Error(`items seed: ${iErr.message}`);

  return { sessionId, evalId, priorOverall };
}

async function cleanup(supabase: ReturnType<typeof createClient>, sessionId: string): Promise<void> {
  // evaluation_items cascade on evaluations delete; delete evals then session.
  await supabase.from("evaluations").delete().eq("session_id", sessionId);
  await supabase.from("sessions").delete().eq("id", sessionId);
}

async function layerB(): Promise<void> {
  console.log("\nLayer B — POST /verification-cap (server + Supabase)");

  const url =
    process.env.SUPABASE_URL ??
    (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("  ⚠ SKIP — Supabase creds absent (SUPABASE_URL/PROJECT_REF + SERVICE_ROLE_KEY)");
    return;
  }
  try {
    const health = await fetch(`${SERVER_URL}/health`);
    if (!health.ok) throw new Error("health not ok");
  } catch {
    console.log(`  ⚠ SKIP — server not reachable at ${SERVER_URL}`);
    return;
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: WebSocket as any },
  });

  // ── confirm path ──
  const a = await seedSession(supabase, "advisory_pending", 5);
  try {
    const r = await fetch(`${SERVER_URL}/api/review/sessions/${a.sessionId}/verification-cap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "confirm" }),
    });
    const body = (await r.json()) as Record<string, unknown>;
    check("confirm: 200", r.status === 200, `got ${r.status} ${JSON.stringify(body)}`);
    check("confirm: status=confirmed", body.verification_cap_status === "confirmed");
    check("confirm: execution capped to 3", body.execution_score === VERIFICATION_CAP_SCORE);
    check("confirm: overall recomputed to 3.5", body.overall_score === 3.5, `got ${String(body.overall_score)}`);

    // DB reflects the cap.
    const { data: itemRow } = await supabase
      .from("evaluation_items")
      .select("score")
      .eq("evaluation_id", a.evalId)
      .eq("competency", "execution")
      .maybeSingle();
    check("confirm: DB execution score = 3", Number(itemRow?.score) === 3, `got ${String(itemRow?.score)}`);
    const { data: sRow } = await supabase
      .from("sessions")
      .select("verification_cap_status")
      .eq("id", a.sessionId)
      .maybeSingle();
    check("confirm: DB session status confirmed", sRow?.verification_cap_status === "confirmed");

    // ── idempotency: second confirm 409s ──
    const r2 = await fetch(`${SERVER_URL}/api/review/sessions/${a.sessionId}/verification-cap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "confirm" }),
    });
    check("idempotent: second confirm 409", r2.status === 409, `got ${r2.status}`);
  } finally {
    await cleanup(supabase, a.sessionId);
  }

  // ── override path ──
  const b = await seedSession(supabase, "advisory_pending", 5);
  try {
    const r = await fetch(`${SERVER_URL}/api/review/sessions/${b.sessionId}/verification-cap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "override" }),
    });
    const body = (await r.json()) as Record<string, unknown>;
    check("override: 200 + overridden", r.status === 200 && body.verification_cap_status === "overridden");
    const { data: itemRow } = await supabase
      .from("evaluation_items")
      .select("score")
      .eq("evaluation_id", b.evalId)
      .eq("competency", "execution")
      .maybeSingle();
    check("override: execution score UNCHANGED (5)", Number(itemRow?.score) === 5, `got ${String(itemRow?.score)}`);
  } finally {
    await cleanup(supabase, b.sessionId);
  }

  // ── guard: a non-pending session 409s ──
  const c = await seedSession(supabase, "none", 5);
  try {
    const r = await fetch(`${SERVER_URL}/api/review/sessions/${c.sessionId}/verification-cap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "confirm" }),
    });
    check("guard: status=none → 409 no_pending_cap", r.status === 409, `got ${r.status}`);
  } finally {
    await cleanup(supabase, c.sessionId);
  }
}

async function main(): Promise<void> {
  console.log("verify-verification-outcomes — RD2 (Slice 6.3)");
  layerA();
  await layerB();
  console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed} check(s))`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
