/**
 * verify-tenant-isolation.ts — P2 acceptance (THE GATE).
 *
 * Seeds two orgs A/B (+ a session, an outcome, and a session_link each)
 * directly via the service-role client, then asserts the APP-LAYER isolation
 * mechanisms — the only ones that matter, since all app traffic is
 * service-role and bypasses RLS (deny-all RLS is just the DB backstop):
 *
 *   [a] key resolution   — A's API key resolves org A, B's resolves B,
 *                          garbage resolves nothing;
 *   [b] query scoping    — scopeToOrg(q, partner) returns ONLY that org's
 *                          sessions; an admin org sees all;
 *   [c] access predicate — orgCanAccess: partner A cannot see B's rows,
 *                          admin sees everything (the 404 gate on detail
 *                          routes is built on this);
 *   [d] webhook secrets  — A's webhook secret attributes to org A and can
 *                          NEVER attribute to org B; outcomes are stamped
 *                          with the authenticated org;
 *   [e] link inheritance — a session_link created by A carries A's org_id,
 *                          and the pure inheritance function gives a session
 *                          started from it A's org (default org only for
 *                          link-less starts);
 *   [f] correlation scope— correlateOutcomes scoped to partner A excludes B's
 *                          outcomes entirely (the read that used to leak
 *                          cross-tenant candidate_ref/session_id/scores);
 *   [g] webhook session gate — posting an outcome against ANOTHER org's
 *                          session is rejected with the SAME "not found"
 *                          error as a nonexistent session (no existence
 *                          oracle); admin bypasses.
 *
 * No sandbox, no LLM. Cleans up everything it seeds. Exit 0 PASS / 1 FAIL;
 * SKIPs (exit 0) without Supabase creds or before migration 0018.
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

async function main(): Promise<void> {
  console.log("verify-tenant-isolation — P2 (THE GATE)");
  if (!url || !key) {
    console.log("  ⚠ SKIP — Supabase creds absent");
    process.exit(0);
  }

  const { supabase } = await import("../src/services/supabase.js");
  if (!supabase) {
    console.log("  ⚠ SKIP — service-role client unavailable");
    process.exit(0);
  }
  const {
    createOrg,
    resolveOrgByApiKey,
    resolveOrgByWebhookSecret,
    orgCanAccess,
    scopeToOrg,
    sessionOrgIdFromLink,
  } = await import("../src/services/orgs.js");
  const { createSessionLink } = await import("../src/services/session-link.js");
  const { insertOutcome, correlateOutcomes, assertSessionVisibleToOrg, OutcomesError } =
    await import("../src/services/outcomes.js");

  // Migration applied?
  const probe = await supabase.from("orgs").select("id").limit(1);
  if (probe.error) {
    console.log(`  ⚠ SKIP — orgs table unavailable (migration 0018 not applied?): ${probe.error.message}`);
    process.exit(0);
  }

  const suffix = randomBytes(4).toString("hex");
  const seeded = {
    orgIds: [] as string[],
    sessionIds: [] as string[],
    outcomeIds: [] as string[],
    linkIds: [] as string[],
    evalIds: [] as string[],
  };
  async function cleanup(): Promise<void> {
    if (seeded.outcomeIds.length) await supabase!.from("outcomes").delete().in("id", seeded.outcomeIds);
    if (seeded.evalIds.length) await supabase!.from("evaluations").delete().in("id", seeded.evalIds);
    if (seeded.linkIds.length) await supabase!.from("session_links").delete().in("id", seeded.linkIds);
    if (seeded.sessionIds.length) await supabase!.from("sessions").delete().in("id", seeded.sessionIds);
    if (seeded.orgIds.length) await supabase!.from("orgs").delete().in("id", seeded.orgIds);
  }

  try {
    // ── Seed two orgs ────────────────────────────────────────────────────
    const a = await createOrg(`Tenant A ${suffix}`, `test-tenant-a-${suffix}`);
    const b = await createOrg(`Tenant B ${suffix}`, `test-tenant-b-${suffix}`);
    seeded.orgIds.push(a.org.id, b.org.id);

    // A session per org (direct insert — no sandbox).
    async function seedSession(orgId: string): Promise<string> {
      const id = randomUUID();
      const { error } = await supabase!.from("sessions").insert({
        id,
        sandbox_id: `verify-tenant-${suffix}`,
        template: "verify",
        litellm_key_alias: `verify-${id}`,
        model: "none",
        budget_usd: 0,
        timeout_min: 1,
        deadline: new Date(Date.now() + 60_000).toISOString(),
        status: "completed",
        org_id: orgId,
      });
      if (error) throw new Error(`session seed failed: ${error.message}`);
      seeded.sessionIds.push(id);
      return id;
    }
    const sessionA = await seedSession(a.org.id);
    const sessionB = await seedSession(b.org.id);

    // ── [a] API-key resolution ───────────────────────────────────────────
    console.log("\n[a] org API-key resolution");
    const resA = await resolveOrgByApiKey(a.apiKey);
    const resB = await resolveOrgByApiKey(b.apiKey);
    const resBad = await resolveOrgByApiKey("not-a-real-key");
    check("A's key resolves org A", resA?.id === a.org.id);
    check("B's key resolves org B", resB?.id === b.org.id);
    check("A's key does NOT resolve org B", resA?.id !== b.org.id);
    check("garbage key resolves nothing", resBad === null);

    // ── [b] query scoping ────────────────────────────────────────────────
    console.log("\n[b] org-scoped session queries");
    const bothIds = [sessionA, sessionB];
    const scopedA = await scopeToOrg(
      supabase.from("sessions").select("id, org_id").in("id", bothIds),
      resA!,
    );
    const rowsA = (scopedA.data ?? []) as Array<{ id: string; org_id: string }>;
    check("partner A sees exactly its own session", rowsA.length === 1 && rowsA[0]!.id === sessionA,
      `got ${rowsA.map((r) => r.id).join(",")}`);
    check("partner A does not see B's session", !rowsA.some((r) => r.id === sessionB));

    const adminOrg = { ...a.org, role: "admin" as const };
    const scopedAdmin = await scopeToOrg(
      supabase.from("sessions").select("id").in("id", bothIds),
      adminOrg,
    );
    const adminRows = (scopedAdmin.data ?? []) as Array<{ id: string }>;
    check("admin sees all sessions", adminRows.length === 2, `got ${adminRows.length}`);

    // ── [c] access predicate (detail-route 404 gate) ─────────────────────
    console.log("\n[c] orgCanAccess predicate");
    check("A can access its own session's org", orgCanAccess(resA!, a.org.id));
    check("A CANNOT access B's session's org", !orgCanAccess(resA!, b.org.id));
    check("admin can access both", orgCanAccess(adminOrg, a.org.id) && orgCanAccess(adminOrg, b.org.id));

    // ── [d] per-org webhook secrets ──────────────────────────────────────
    console.log("\n[d] webhook-secret attribution");
    const whkA = await resolveOrgByWebhookSecret(a.webhookSecret);
    const whkB = await resolveOrgByWebhookSecret(b.webhookSecret);
    check("A's secret attributes to org A", whkA?.id === a.org.id);
    check("A's secret can NEVER attribute to org B", whkA?.id !== b.org.id);
    check("B's secret attributes to org B", whkB?.id === b.org.id);
    check("unknown secret attributes to nothing", (await resolveOrgByWebhookSecret("nope")) === null);

    // The route stamps outcomes with the AUTHENTICATED org (never payload-
    // supplied). Service-level check: even when an insert references another
    // org's session (the route now rejects that up-front — see [g]), the
    // stamped org is the authenticated one, never the session's.
    const outcome = await insertOutcome(
      { candidate_ref: `verify-${suffix}`, session_id: sessionB, outcome_type: "hired", value: true },
      "webhook",
      whkA!.id,
    );
    seeded.outcomeIds.push(outcome.id);
    const { data: outRow } = await supabase
      .from("outcomes")
      .select("org_id")
      .eq("id", outcome.id)
      .single();
    check(
      "outcome is stamped with the authenticated org (A), not the target session's org (B)",
      (outRow as { org_id: string } | null)?.org_id === a.org.id,
    );

    // ── [e] session-link org inheritance ─────────────────────────────────
    console.log("\n[e] session-link inheritance");
    const { link } = await createSessionLink({
      candidateLabel: `verify-${suffix}`,
      orgId: a.org.id,
    });
    seeded.linkIds.push(link.id);
    check("link created by A carries A's org_id", link.org_id === a.org.id);
    check(
      "a session started from A's link inherits A's org",
      sessionOrgIdFromLink(link.org_id, b.org.id) === a.org.id,
    );
    check(
      "a link-less start falls back to the default org",
      sessionOrgIdFromLink(null, "default-org-id") === "default-org-id",
    );

    // ── [f] correlation scoping ──────────────────────────────────────────
    // Seed one completed evaluation + one 'hired' outcome per org (a shared
    // candidate_ref prefix isolates this run's rows from real data), then
    // assert A's scoped correlation contains ONLY A's pair.
    console.log("\n[f] correlation scoping");
    const corrPrefix = `verify-corr-${suffix}`;
    async function seedEvaluation(sessionId: string, score: number): Promise<void> {
      const { data, error } = await supabase!
        .from("evaluations")
        .insert({ session_id: sessionId, overall_score: score, status: "complete" })
        .select("id")
        .single();
      if (error) throw new Error(`evaluation seed failed: ${error.message}`);
      seeded.evalIds.push((data as { id: string }).id);
    }
    await seedEvaluation(sessionA, 4);
    await seedEvaluation(sessionB, 2);
    const outA = await insertOutcome(
      { candidate_ref: `${corrPrefix}-a`, session_id: sessionA, outcome_type: "hired", value: true },
      "webhook",
      a.org.id,
    );
    const outB = await insertOutcome(
      { candidate_ref: `${corrPrefix}-b`, session_id: sessionB, outcome_type: "hired", value: false },
      "webhook",
      b.org.id,
    );
    seeded.outcomeIds.push(outA.id, outB.id);

    const corrA = await correlateOutcomes("hired", null, corrPrefix, a.org.id);
    check(
      "partner A's correlation includes A's outcome",
      corrA.pairs.some((p) => p.session_id === sessionA),
    );
    check(
      "partner A's correlation EXCLUDES B's outcomes (sessions + candidate_refs)",
      !corrA.pairs.some((p) => p.session_id === sessionB) &&
        !corrA.pairs.some((p) => p.candidate_ref === `${corrPrefix}-b`),
      `pairs: ${JSON.stringify(corrA.pairs)}`,
    );
    const corrAll = await correlateOutcomes("hired", null, corrPrefix, null);
    check("unscoped (admin) correlation sees both orgs' outcomes", corrAll.n === 2, `n=${corrAll.n}`);

    // ── [g] webhook foreign-session gate (no existence oracle) ──────────
    // POST /api/outcomes calls assertSessionVisibleToOrg before inserting:
    // a foreign session and a nonexistent session must fail IDENTICALLY.
    console.log("\n[g] webhook foreign-session rejection");
    async function visibilityError(sessionId: string, org: { id: string; role: "admin" | "partner" } | null): Promise<string | null> {
      try {
        await assertSessionVisibleToOrg(sessionId, org);
        return null;
      } catch (err) {
        if (err instanceof OutcomesError) return err.message;
        throw err;
      }
    }
    const foreignErr = await visibilityError(sessionB, resA!);
    const missingId = randomUUID();
    const missingErr = await visibilityError(missingId, resA!);
    check("A posting against B's session is rejected", foreignErr !== null, foreignErr ?? "");
    check("A posting against a nonexistent session is rejected", missingErr !== null);
    check(
      "foreign and missing sessions raise the SAME-shaped error (no oracle)",
      !!foreignErr &&
        !!missingErr &&
        foreignErr.replace(sessionB, "<id>") === missingErr.replace(missingId, "<id>"),
      `foreign="${foreignErr}" missing="${missingErr}"`,
    );
    check("A CAN post against its own session", (await visibilityError(sessionA, resA!)) === null);
    check(
      "admin bypasses the session gate (can post against B's session)",
      (await visibilityError(sessionB, adminOrg)) === null,
    );
  } finally {
    await cleanup();
  }

  console.log(failed === 0 ? "\nPASS — tenant isolation holds" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("verify-tenant-isolation crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
