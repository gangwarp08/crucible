/**
 * verify-candidate-report.ts — P4.2/P4.3 acceptance (the external-safe report).
 *
 * Infra-light (Supabase service-role only — no server, no sandbox, no LLM):
 * seeds a session DELIBERATELY loaded with internal-only fields (model name,
 * sandbox id, spend), then exercises services/shared-report.ts — the payload
 * behind the PUBLIC GET /api/report/:token.
 *
 * Acceptance (spec P4.2/P4.3):
 *   [a] the response parses against the strict Zod allowlist;
 *   [b] NO forbidden key appears ANYWHERE in the payload (deep key scan:
 *       cost, spend_usd, model, sandbox_id, transcript, …) and none of the
 *       seeded secret VALUES leak either — even though every one of them is
 *       present on the underlying rows;
 *   [c] evidence links resolve: per-competency evidence carries the seeded
 *       {event_seq, note} pairs (external mode: seq + note only, no events);
 *   [d] identity/context fields: candidate_label, scenario title/role,
 *       difficulty band, verification outcome, scorable status, dates;
 *   [e] AI-Fluency placement maps the ai_orchestration score (thresholds:
 *       <2.5 dependent, 2.5–3.9 augmented, >=4 orchestrator) and is labeled
 *       informational;
 *   [f] suspicion is present, informational, computed from integrity events —
 *       score + version ONLY, no per-factor breakdown (recruiter-only);
 *   [g] the allowlist is STRICT — injecting an extra key makes parsing throw
 *       (internal fields are excludable by construction, not by omission).
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; SKIPs (exit 0)
 * without Supabase creds or before migrations 0018/0020.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-candidate-report.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID, randomBytes } from "crypto";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

/** Every key at every depth of a JSON-ish value. */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const item of v) allKeys(item, out);
  } else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out.add(k);
      allKeys(val, out);
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log("verify-candidate-report — P4.2/P4.3");
  if (!url || !key) {
    console.log("  ⚠ SKIP — Supabase creds absent");
    process.exit(0);
  }

  const { supabase } = await import("../src/services/supabase.js");
  if (!supabase) {
    console.log("  ⚠ SKIP — service-role client unavailable");
    process.exit(0);
  }
  const { createOrg } = await import("../src/services/orgs.js");
  const { buildSharedReport, SharedReportSchema } = await import("../src/services/shared-report.js");
  const { aiFluencyPlacement } = await import("../src/services/ai-fluency.js");

  const orgsProbe = await supabase.from("orgs").select("id").limit(1);
  if (orgsProbe.error) {
    console.log(`  ⚠ SKIP — orgs table unavailable (0018 not applied?): ${orgsProbe.error.message}`);
    process.exit(0);
  }
  const bandProbe = await supabase.from("sessions").select("difficulty_band").limit(1);
  if (bandProbe.error) {
    console.log(`  ⚠ SKIP — sessions.difficulty_band unavailable (0020 not applied?): ${bandProbe.error.message}`);
    process.exit(0);
  }

  const suffix = randomBytes(4).toString("hex");
  const SECRET_MODEL = `secret-model-${suffix}`;
  const SECRET_SANDBOX = `sbx-secret-${suffix}`;
  const SECRET_KEY_ALIAS = `key-alias-secret-${suffix}`;

  const seeded = {
    orgIds: [] as string[],
    sessionIds: [] as string[],
    evalIds: [] as string[],
    linkIds: [] as string[],
    scenarioIds: [] as string[],
  };
  async function cleanup(): Promise<void> {
    if (seeded.evalIds.length) await supabase!.from("evaluations").delete().in("id", seeded.evalIds);
    if (seeded.linkIds.length) await supabase!.from("session_links").delete().in("id", seeded.linkIds);
    if (seeded.sessionIds.length) await supabase!.from("sessions").delete().in("id", seeded.sessionIds);
    if (seeded.scenarioIds.length) await supabase!.from("scenarios").delete().in("id", seeded.scenarioIds);
    if (seeded.orgIds.length) await supabase!.from("orgs").delete().in("id", seeded.orgIds);
  }

  try {
    // ── Seed: a session dripping with internal-only fields ───────────────
    const a = await createOrg(`Report ${suffix}`, `test-report-${suffix}`);
    seeded.orgIds.push(a.org.id);

    const { data: scen, error: scenErr } = await supabase
      .from("scenarios")
      .insert({ slug: `verify-report-${suffix}`, title: `Verify Report ${suffix}`, role: "fde" })
      .select("id")
      .single();
    if (scenErr) throw new Error(`scenario seed failed: ${scenErr.message}`);
    const scenarioId = (scen as { id: string }).id;
    seeded.scenarioIds.push(scenarioId);

    const sessionId = randomUUID();
    const { error: sessErr } = await supabase.from("sessions").insert({
      id: sessionId,
      sandbox_id: SECRET_SANDBOX,
      template: "verify",
      litellm_key_alias: SECRET_KEY_ALIAS,
      model: SECRET_MODEL,
      budget_usd: 5,
      spend_usd: 1.234567,
      timeout_min: 60,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      status: "completed",
      ended_at: new Date().toISOString(),
      org_id: a.org.id,
      scenario_id: scenarioId,
      difficulty_band: "hard",
      scorable: true,
      defense_outcome: "coherent",
    });
    if (sessErr) throw new Error(`session seed failed: ${sessErr.message}`);
    seeded.sessionIds.push(sessionId);

    const { data: evalRow, error: evalErr } = await supabase
      .from("evaluations")
      .insert({
        session_id: sessionId,
        scenario_id: scenarioId,
        overall_score: 4.2,
        status: "complete",
        model: SECRET_MODEL, // judge model name — must never leave the building
        summary: "internal judge summary",
      })
      .select("id")
      .single();
    if (evalErr) throw new Error(`evaluation seed failed: ${evalErr.message}`);
    const evalId = (evalRow as { id: string }).id;
    seeded.evalIds.push(evalId);

    const EVIDENCE = [
      { event_seq: 12, note: "diagnosed the double-count with a targeted query" },
      { event_seq: 34, note: "verified the fix before submitting" },
    ];
    const { error: itemsErr } = await supabase.from("evaluation_items").insert([
      {
        evaluation_id: evalId,
        competency: "execution",
        score: 4,
        assessed: true,
        weight: 0.5,
        rationale: "shipped a correct fix",
        evidence: EVIDENCE,
      },
      {
        evaluation_id: evalId,
        competency: "ai_orchestration",
        score: 4,
        assessed: true,
        weight: 0.3,
        rationale: "delegated well, verified outputs",
        evidence: [],
      },
      {
        evaluation_id: evalId,
        competency: "data_fluency",
        score: null,
        assessed: false,
        weight: 0.2,
        rationale: "not surfaced",
        evidence: [],
      },
    ]);
    if (itemsErr) throw new Error(`items seed failed: ${itemsErr.message}`);

    const { data: link, error: linkErr } = await supabase
      .from("session_links")
      .insert({
        token_hash: randomBytes(32).toString("hex"),
        candidate_label: `Jane Doe ${suffix}`,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        consumed_at: new Date().toISOString(),
        session_id: sessionId,
        org_id: a.org.id,
      })
      .select("id")
      .single();
    if (linkErr) throw new Error(`link seed failed: ${linkErr.message}`);
    seeded.linkIds.push((link as { id: string }).id);

    const { error: evErr } = await supabase.from("events").insert([
      { session_id: sessionId, seq: 1, type: "integrity.tab_blur", actor: "candidate", payload: {} },
      { session_id: sessionId, seq: 2, type: "integrity.tab_blur", actor: "candidate", payload: {} },
      // A non-integrity event that must NOT appear in the shared payload.
      { session_id: sessionId, seq: 12, type: "db.query", actor: "candidate", payload: { sql: "select secret" } },
    ]);
    if (evErr) throw new Error(`events seed failed: ${evErr.message}`);

    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const report = await buildSharedReport(sessionId, expiresAt);

    // ── [a] strict schema ────────────────────────────────────────────────
    console.log("\n[a] Zod allowlist parse");
    check("payload parses against SharedReportSchema", SharedReportSchema.safeParse(report).success);

    // ── [b] forbidden keys + values ──────────────────────────────────────
    console.log("\n[b] internal fields excluded (even though present on the rows)");
    const keys = allKeys(report);
    const FORBIDDEN_KEYS = [
      "cost", "cost_usd", "spend_usd", "budget_usd", "cumulative_spend_usd",
      "model", "sandbox_id", "litellm_key_alias", "template",
      "transcript", "events", "payload",
      "session_id", "org_id", "id", "token_hash", "summary", "scenario_state",
      // Suspicion factor breakdown is recruiter-only — the public report
      // carries the score + version, nothing per-factor.
      "factors", "kind", "weight", "contribution",
    ];
    for (const fk of FORBIDDEN_KEYS) {
      check(`no "${fk}" key anywhere in the payload`, !keys.has(fk));
    }
    const json = JSON.stringify(report);
    check("seeded model name never appears", !json.includes(SECRET_MODEL));
    check("seeded sandbox id never appears", !json.includes(SECRET_SANDBOX));
    check("seeded key alias never appears", !json.includes(SECRET_KEY_ALIAS));
    check("seeded spend value never appears", !json.includes("1.234567"));
    check("raw event payloads never appear", !json.includes("select secret"));

    // ── [c] evidence resolves ────────────────────────────────────────────
    console.log("\n[c] evidence links");
    const exec = report.competencies.find((c) => c.key === "execution");
    check("execution item present with score 4", exec?.score === 4 && exec.assessed === true);
    check(
      "evidence carries the seeded {event_seq, note} pairs",
      exec?.evidence.length === 2 &&
        exec.evidence[0]!.event_seq === 12 &&
        exec.evidence[0]!.note === EVIDENCE[0]!.note &&
        exec.evidence[1]!.event_seq === 34,
    );
    const notAssessed = report.competencies.find((c) => c.key === "data_fluency");
    check("not-assessed competency surfaces as assessed=false, score null",
      notAssessed?.assessed === false && notAssessed.score === null);

    // ── [d] identity / context fields ────────────────────────────────────
    console.log("\n[d] external-safe context");
    check("candidate_label from the session link", report.candidate_label === `Jane Doe ${suffix}`);
    check("scenario title + role", report.scenario.title === `Verify Report ${suffix}` && report.scenario.role === "fde");
    check("difficulty band", report.difficulty_band === "hard");
    check("overall score", report.overall_score === 4.2);
    check("verification outcome", report.verification.defense_outcome === "coherent");
    check("scorable status", report.scorable === true && report.exclusion_reason === null);
    check("share expiry echoed", report.share.expires_at === expiresAt);

    // ── [e] AI-Fluency ───────────────────────────────────────────────────
    console.log("\n[e] AI-Fluency Index (informational)");
    check("ai_orchestration 4 → ai_orchestrator", report.ai_fluency.placement === "ai_orchestrator");
    check("labeled informational", report.ai_fluency.informational === true);
    // Threshold unit checks (signed-off mapping).
    check("2.49 → ai_dependent", aiFluencyPlacement(2.49) === "ai_dependent");
    check("2.5 → ai_augmented", aiFluencyPlacement(2.5) === "ai_augmented");
    check("3.9 → ai_augmented", aiFluencyPlacement(3.9) === "ai_augmented");
    check("4 → ai_orchestrator", aiFluencyPlacement(4) === "ai_orchestrator");
    check("null → null", aiFluencyPlacement(null) === null);

    // ── [f] suspicion ────────────────────────────────────────────────────
    console.log("\n[f] suspicion (informational)");
    check("computed from integrity events (>0)", report.suspicion.score > 0, `score=${report.suspicion.score}`);
    check("labeled informational", report.suspicion.informational === true);
    check("version present", typeof report.suspicion.version === "string" && report.suspicion.version.length > 0);
    check("no factor breakdown in the shared payload", !("factors" in report.suspicion));

    // ── [g] strictness: extra keys are a thrown error, not a leak ────────
    console.log("\n[g] allowlist is strict");
    const injected = { ...report, spend_usd: 1.23 } as unknown;
    check("injected internal key fails the schema", !SharedReportSchema.safeParse(injected).success);
  } finally {
    await cleanup();
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-candidate-report crashed:", err);
  process.exit(1);
});
