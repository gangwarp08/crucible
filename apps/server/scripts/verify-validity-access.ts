/**
 * verify-validity-access.ts — V.1 acceptance (admin gate + read-only surface).
 *
 * Infra-light (Supabase service-role + in-process Fastify inject — no E2B, no
 * LLM). Asserts, on ALL six /api/admin/validity/* endpoints:
 *   - admin org key   → 200
 *   - partner org key → 403 (admin_only)
 *   - no key          → 401/403 (fails closed)
 *   - garbage key     → 401
 * and, statically, that routes/validity.ts + services/validity.ts contain NO
 * write patterns (.insert/.update/.upsert/.delete/.rpc) — read-only by
 * construction.
 *
 * NOTE on the no-key case: requireOrg's back-compat switch (ORG_AUTH_REQUIRED
 * off → key-less requests resolve to the default asaya org, role admin) does
 * NOT apply to this surface: requireAdmin in routes/validity.ts rejects
 * key-less requests with 401 before delegating to requireOrg. To prove that
 * fail-closed property under the WORST config, this verifier pins
 * ORG_AUTH_REQUIRED=false before any src import — the no-key 401 assertion
 * below must hold even with the back-compat switch active.
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; clean SKIP (exit 0)
 * without Supabase creds or before migration 0018.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-validity-access.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

// Pin the org-auth flag to the WORST config BEFORE any src module loads
// (env.ts snapshots process.env at first import): with the back-compat
// switch active, the validity surface must STILL 401 key-less requests.
process.env.ORG_AUTH_REQUIRED = "false";

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VIEWS = ["discrimination", "not-assessed", "distributions", "correlation", "exclusions", "versions"] as const;

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

async function main(): Promise<void> {
  console.log("verify-validity-access — V.1");

  // ── [a] static: read-only by construction (no creds needed) ───────────────
  console.log("\n[a] no write paths in the validity surface (static)");
  const writeRe = /\.(insert|update|upsert|delete|rpc)\(/;
  const routesSrc = readFileSync(resolve(here, "../src/routes/validity.ts"), "utf8");
  const serviceSrc = readFileSync(resolve(here, "../src/services/validity.ts"), "utf8");
  check("routes/validity.ts has no .insert/.update/.upsert/.delete/.rpc(", !writeRe.test(routesSrc));
  check("services/validity.ts has no .insert/.update/.upsert/.delete/.rpc(", !writeRe.test(serviceSrc));

  if (!url || !key) {
    console.log("  ⚠ SKIP (live checks) — Supabase creds absent");
    process.exit(failed === 0 ? 0 : 1);
  }

  const { supabase } = await import("../src/services/supabase.js");
  if (!supabase) {
    console.log("  ⚠ SKIP (live checks) — service-role client unavailable");
    process.exit(failed === 0 ? 0 : 1);
  }
  const db = supabase;
  const missingTable = (e: { code?: string; message?: string } | null) =>
    !!e && /42P01|PGRST205|does not exist|Could not find the table/i.test(`${e.code} ${e.message}`);
  const orgsProbe = await db.from("orgs").select("id").limit(1);
  if (missingTable(orgsProbe.error)) {
    console.log("  ⚠ SKIP (live checks) — orgs table absent (migration 0018 not applied)");
    process.exit(failed === 0 ? 0 : 1);
  }

  const { createOrg } = await import("../src/services/orgs.js");
  const { validityRoutes } = await import("../src/routes/validity.js");
  const { default: Fastify } = await import("fastify");

  // ── Seed: a partner org + an admin credential ──────────────────────────────
  const run = randomUUID().slice(0, 8);
  const partner = await createOrg(`vd-acc-p-${run}`, `vd-acc-p-${run}`);
  const createdOrgIds: string[] = [partner.org.id];

  // Admin credential: prefer the operator-set ORG_ADMIN_KEY (resolves to the
  // default asaya org, role admin); else mint an org and flip it to admin.
  let adminKey = process.env.ORG_ADMIN_KEY ?? "";
  if (!adminKey) {
    const a = await createOrg(`vd-acc-a-${run}`, `vd-acc-a-${run}`);
    createdOrgIds.push(a.org.id);
    const { error } = await db.from("orgs").update({ role: "admin" }).eq("id", a.org.id);
    if (error) throw new Error(`admin role flip failed: ${error.message}`);
    adminKey = a.apiKey;
  }

  const app = Fastify();
  await app.register(validityRoutes);

  const hit = async (view: string, orgKey?: string) =>
    app.inject({
      method: "GET",
      url: `/api/admin/validity/${view}`,
      ...(orgKey !== undefined ? { headers: { "x-org-key": orgKey } } : {}),
    });

  try {
    console.log("\n[b] access matrix — all six endpoints");
    for (const view of VIEWS) {
      const admin = await hit(view, adminKey);
      check(`${view}: admin key → 200`, admin.statusCode === 200, `status=${admin.statusCode} body=${admin.body.slice(0, 200)}`);

      const part = await hit(view, partner.apiKey);
      check(`${view}: partner key → 403`, part.statusCode === 403, `status=${part.statusCode}`);

      const noKey = await hit(view);
      check(
        `${view}: no key → 401/403 (fails closed)`,
        noKey.statusCode === 401 || noKey.statusCode === 403,
        `status=${noKey.statusCode}`,
      );

      const garbage = await hit(view, "not-a-real-org-key-0000000000");
      check(`${view}: garbage key → 401`, garbage.statusCode === 401, `status=${garbage.statusCode}`);
    }

    // Sanity: the admin 200 actually returned the shared envelope, i.e. we hit
    // the real aggregation path, not an empty handler.
    const sample = await hit("versions", adminKey);
    const body = sample.json() as { version_context?: unknown; min_n?: number };
    check("admin response carries the shared envelope (version_context + min_n)",
      sample.statusCode === 200 && body.version_context !== undefined && typeof body.min_n === "number");
  } finally {
    console.log("\n[cleanup]");
    await app.close();
    for (const id of createdOrgIds) {
      await db.from("orgs").delete().eq("id", id);
    }
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-validity-access crashed:", err);
  process.exit(1);
});
