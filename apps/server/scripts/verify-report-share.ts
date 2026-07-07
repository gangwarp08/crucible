/**
 * verify-report-share.ts — P4.3 acceptance.
 *
 * Infra-light (Supabase service-role only — no server, no sandbox, no LLM):
 * exercises services/report-share.ts against the real report_shares table
 * (migration 0021).
 *
 * Acceptance (spec P4.3): token scoped + expiring; specifically —
 *   [a] mint returns the RAW token once; only sha256 is stored;
 *   [b] resolution: raw token → its share; garbage → nothing;
 *   [c] TTL is capped at 720h (both at the service and by construction);
 *   [d] expiry enforced — an expired share resolves with status 'expired';
 *   [e] revocation enforced + ORG-SCOPED — owner can revoke (idempotent),
 *       a foreign partner org CANNOT revoke (reads as not-found) and the
 *       share stays active;
 *   [f] a share cannot be minted without an owning org (0021 NOT NULL).
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; SKIPs (exit 0)
 * without Supabase creds or before migrations 0018/0021.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-report-share.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID, randomBytes, createHash } from "crypto";

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
  console.log("verify-report-share — P4.3");
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
  const {
    createReportShare,
    listReportShares,
    revokeReportShare,
    resolveReportShare,
    ReportShareError,
    MAX_SHARE_TTL_HOURS,
  } = await import("../src/services/report-share.js");

  // Migrations applied?
  const orgsProbe = await supabase.from("orgs").select("id").limit(1);
  if (orgsProbe.error) {
    console.log(`  ⚠ SKIP — orgs table unavailable (0018 not applied?): ${orgsProbe.error.message}`);
    process.exit(0);
  }
  const sharesProbe = await supabase.from("report_shares").select("id").limit(1);
  if (sharesProbe.error) {
    console.log(`  ⚠ SKIP — report_shares unavailable (0021 not applied?): ${sharesProbe.error.message}`);
    process.exit(0);
  }

  const suffix = randomBytes(4).toString("hex");
  const seeded = { orgIds: [] as string[], sessionIds: [] as string[] };
  async function cleanup(): Promise<void> {
    // report_shares cascade with their sessions.
    if (seeded.sessionIds.length) await supabase!.from("sessions").delete().in("id", seeded.sessionIds);
    if (seeded.orgIds.length) await supabase!.from("orgs").delete().in("id", seeded.orgIds);
  }

  try {
    const a = await createOrg(`Share A ${suffix}`, `test-share-a-${suffix}`);
    const b = await createOrg(`Share B ${suffix}`, `test-share-b-${suffix}`);
    seeded.orgIds.push(a.org.id, b.org.id);

    const sessionId = randomUUID();
    const { error: sessErr } = await supabase.from("sessions").insert({
      id: sessionId,
      sandbox_id: `verify-share-${suffix}`,
      template: "verify",
      litellm_key_alias: `verify-${sessionId}`,
      model: "none",
      budget_usd: 0,
      timeout_min: 1,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      status: "completed",
      org_id: a.org.id,
    });
    if (sessErr) throw new Error(`session seed failed: ${sessErr.message}`);
    seeded.sessionIds.push(sessionId);

    // ── [a] mint: raw shown once, only the hash stored ───────────────────
    console.log("\n[a] mint stores only the sha256");
    const { token, share } = await createReportShare({ sessionId, orgId: a.org.id, ttlHours: 24 });
    check("raw token is 32B base64url (43 chars)", /^[A-Za-z0-9_-]{43}$/.test(token), token);
    check("share summary carries no token material", !("token_hash" in (share as unknown as Record<string, unknown>)));
    const { data: rawRow } = await supabase
      .from("report_shares")
      .select("token_hash, org_id, session_id")
      .eq("id", share.id)
      .single();
    const expectedHash = createHash("sha256").update(token).digest("hex");
    check("stored token_hash === sha256(raw)", rawRow?.token_hash === expectedHash);
    check("raw token itself is NOT stored", rawRow?.token_hash !== token);
    check("share stamped with the owning org", rawRow?.org_id === a.org.id);
    check("share bound to the session", rawRow?.session_id === sessionId);
    check("fresh share derives 'active'", share.status === "active");

    // ── [b] resolution ───────────────────────────────────────────────────
    console.log("\n[b] token resolution");
    const hit = await resolveReportShare(token);
    check("raw token resolves its share", hit?.row.id === share.id && hit.status === "active");
    const miss = await resolveReportShare(randomBytes(32).toString("base64url"));
    check("unknown token resolves nothing", miss === null);

    // ── [c] TTL cap ──────────────────────────────────────────────────────
    console.log("\n[c] TTL cap (720h)");
    let capThrew = false;
    try {
      await createReportShare({ sessionId, orgId: a.org.id, ttlHours: MAX_SHARE_TTL_HOURS + 1 });
    } catch (err) {
      capThrew = err instanceof ReportShareError && err.code === "invalid";
    }
    check(`ttlHours > ${MAX_SHARE_TTL_HOURS} rejected`, capThrew);
    const maxTtl = await createReportShare({ sessionId, orgId: a.org.id, ttlHours: MAX_SHARE_TTL_HOURS });
    const maxMs = Date.parse(maxTtl.share.expires_at) - Date.now();
    check(
      "ttlHours = 720 lands ~30 days out",
      Math.abs(maxMs - MAX_SHARE_TTL_HOURS * 3_600_000) < 60_000,
      `delta=${maxMs}ms`,
    );

    // ── [d] expiry enforced ──────────────────────────────────────────────
    console.log("\n[d] expiry");
    const expiring = await createReportShare({ sessionId, orgId: a.org.id, ttlHours: 1 });
    await supabase
      .from("report_shares")
      .update({ expires_at: new Date(Date.now() - 1_000).toISOString() })
      .eq("id", expiring.share.id);
    const expired = await resolveReportShare(expiring.token);
    check("past expires_at resolves as 'expired'", expired?.status === "expired");

    // ── [e] revocation enforced + org-scoped ─────────────────────────────
    console.log("\n[e] revocation");
    const victim = await createReportShare({ sessionId, orgId: a.org.id, ttlHours: 24 });

    // Foreign org first: partner B must NOT be able to revoke A's share.
    let foreignThrew = false;
    try {
      await revokeReportShare(victim.share.id, b.org);
    } catch (err) {
      foreignThrew = err instanceof ReportShareError && err.code === "not_found";
    }
    check("foreign partner org cannot revoke (reads as not-found)", foreignThrew);
    const stillActive = await resolveReportShare(victim.token);
    check("share still active after the foreign attempt", stillActive?.status === "active");

    const revoked = await revokeReportShare(victim.share.id, a.org);
    check("owning org revokes", revoked.status === "revoked");
    const afterRevoke = await resolveReportShare(victim.token);
    check("revoked token resolves as 'revoked'", afterRevoke?.status === "revoked");
    const again = await revokeReportShare(victim.share.id, a.org);
    check("revoke is idempotent", again.status === "revoked");

    const adminOrg = { ...a.org, role: "admin" as const };
    const listAdmin = await listReportShares(sessionId, adminOrg);
    check("admin lists all shares for the session", listAdmin.length >= 4, `got ${listAdmin.length}`);
    const listB = await listReportShares(sessionId, b.org);
    check("foreign partner org lists none", listB.length === 0, `got ${listB.length}`);

    // ── [f] org is mandatory ─────────────────────────────────────────────
    console.log("\n[f] owning org required");
    let orglessThrew = false;
    try {
      await createReportShare({ sessionId, orgId: null });
    } catch (err) {
      orglessThrew = err instanceof ReportShareError && err.code === "invalid";
    }
    check("mint without an org is rejected", orglessThrew);
  } finally {
    await cleanup();
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-report-share crashed:", err);
  process.exit(1);
});
