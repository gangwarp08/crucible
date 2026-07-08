/**
 * verify-biometric-retention.ts — P6.4 acceptance (deletion path, org-scoped).
 *
 * Infra-light (Supabase service-role + in-process Fastify inject — no E2B, no
 * LLM). Raw frames are never stored (asserted by verify-identity-verify.ts),
 * so "retention honored" reduces to: the DERIVED identity data is hard-
 * deletable, deletion is complete, and only the OWNING org can delete it.
 *   [a] service: foreign partner org deletes NOTHING (0 rows, row survives,
 *       and learns nothing); owner hard-deletes; idempotent re-delete → 0;
 *       readIdentityStatus → null after deletion (deletion is complete);
 *   [b] route: POST /api/review/sessions/:id/identity-delete behind the org
 *       key guard — no key → refused when ORG_AUTH_REQUIRED, foreign key
 *       deletes 0, owner key deletes the row.
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; clean SKIP (exit 0)
 * without Supabase creds or before migrations 0018/0024.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-biometric-retention.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";

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
  console.log("verify-biometric-retention — P6.4");
  if (!url || !key) {
    console.log("  ⚠ SKIP — Supabase creds absent");
    process.exit(0);
  }

  const { supabase } = await import("../src/services/supabase.js");
  if (!supabase) {
    console.log("  ⚠ SKIP — service-role client unavailable");
    process.exit(0);
  }
  const missingTable = (e: { code?: string; message?: string } | null) =>
    !!e && /42P01|PGRST205|does not exist|Could not find the table/i.test(`${e.code} ${e.message}`);
  const orgsProbe = await supabase.from("orgs").select("id").limit(1);
  if (missingTable(orgsProbe.error)) {
    console.log("  ⚠ SKIP — orgs table absent (migration 0018 not applied)");
    process.exit(0);
  }
  const idProbe = await supabase.from("identity_checks").select("id").limit(1);
  if (missingTable(idProbe.error)) {
    console.log("  ⚠ SKIP — identity_checks absent (migration 0024 not applied; P6 dormant)");
    process.exit(0);
  }

  const { createOrg } = await import("../src/services/orgs.js");
  const { recordConsent, verifyIdentity, deleteIdentityData, readIdentityStatus } =
    await import("../src/services/proctoring-v2.js");
  const { proctoringRoutes } = await import("../src/routes/proctoring.js");
  const { default: Fastify } = await import("fastify");

  // ── Seed: owner org A (flag on) + foreign partner org B + session in A ────
  const run = randomUUID().slice(0, 8);
  const a = await createOrg(`pv2-ret-a-${run}`, `pv2-ret-a-${run}`);
  const b = await createOrg(`pv2-ret-b-${run}`, `pv2-ret-b-${run}`);
  await supabase.from("orgs").update({ settings: { proctoring_v2_enabled: true } }).eq("id", a.org.id);

  const SID = randomUUID();
  {
    const { error } = await supabase.from("sessions").insert({
      id: SID, status: "completed", sandbox_id: `pv2-ret-${run}`, template: "crucible-dev",
      litellm_key_alias: `ret-${run}`, model: "gemini-flash",
      budget_usd: 1.0, timeout_min: 60, deadline: "2030-01-01T00:00:00.000Z",
      scenario_state: {}, org_id: a.org.id,
    });
    if (error) throw new Error(`seed session failed: ${error.message}`);
  }
  const seedIdentity = async () => {
    await supabase!.from("identity_checks").delete().eq("session_id", SID);
    await recordConsent(SID, a.org, "accepted");
    await verifyIdentity(SID, a.org, "data:image/jpeg;base64,QUFB", "data:image/jpeg;base64,QkJC",
      async () => 0.91);
  };

  const app = Fastify();
  await app.register(proctoringRoutes);

  const cleanup = async () => {
    await app.close();
    await supabase.from("events").delete().eq("session_id", SID);
    await supabase.from("identity_checks").delete().eq("session_id", SID);
    await supabase.from("sessions").delete().eq("id", SID);
    await supabase.from("orgs").delete().eq("id", a.org.id);
    await supabase.from("orgs").delete().eq("id", b.org.id);
  };

  try {
    // ── [a] service-layer deletion, org-scoped ─────────────────────────────
    console.log("\n[a] service deletion (org-scoped, complete, idempotent)");
    await seedIdentity();
    check("identity data on record before deletion", (await readIdentityStatus(SID)) !== null);

    const foreignDeleted = await deleteIdentityData(SID, b.org);
    check("foreign partner org deletes NOTHING (0 rows)", foreignDeleted === 0, `deleted=${foreignDeleted}`);
    check("row survives the foreign attempt", (await readIdentityStatus(SID)) !== null);

    const ownerDeleted = await deleteIdentityData(SID, a.org);
    check("owning org hard-deletes (1 row)", ownerDeleted === 1, `deleted=${ownerDeleted}`);
    check("deletion is complete — no identity status remains", (await readIdentityStatus(SID)) === null);
    const raw = await supabase.from("identity_checks").select("id").eq("session_id", SID);
    check("zero identity_checks rows remain", (raw.data ?? []).length === 0);
    const again = await deleteIdentityData(SID, a.org);
    check("re-delete is idempotent (0 rows)", again === 0, `deleted=${again}`);

    // ── [b] the org-guarded deletion endpoint ───────────────────────────────
    console.log("\n[b] POST /api/review/sessions/:id/identity-delete");
    await seedIdentity();
    const foreignRes = await app.inject({
      method: "POST",
      url: `/api/review/sessions/${SID}/identity-delete`,
      headers: { "x-org-key": b.apiKey },
    });
    check("foreign org key → deleted 0 (learns nothing)",
      foreignRes.statusCode === 200 && foreignRes.json().deleted === 0, foreignRes.body);
    check("row survives the foreign endpoint call", (await readIdentityStatus(SID)) !== null);

    const badKey = await app.inject({
      method: "POST",
      url: `/api/review/sessions/${SID}/identity-delete`,
      headers: { "x-org-key": "not-a-real-org-key-0000000000" },
    });
    check("garbage org key → 401", badKey.statusCode === 401, `status=${badKey.statusCode}`);

    const ownerRes = await app.inject({
      method: "POST",
      url: `/api/review/sessions/${SID}/identity-delete`,
      headers: { "x-org-key": a.apiKey },
    });
    check("owner org key → deleted 1", ownerRes.statusCode === 200 && ownerRes.json().deleted === 1, ownerRes.body);
    check("endpoint deletion is complete", (await readIdentityStatus(SID)) === null);
  } finally {
    console.log("\n[cleanup]");
    await cleanup();
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-biometric-retention crashed:", err);
  process.exit(1);
});
