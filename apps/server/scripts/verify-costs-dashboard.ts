/**
 * verify-costs-dashboard.ts — costs dashboard acceptance (admin gate +
 * read-only surface + aggregation correctness).
 *
 * Infra-light (Supabase service-role + in-process Fastify inject — no E2B, no
 * LLM). Asserts:
 *   [a] statically, that routes/costs.ts + services/costs.ts contain NO write
 *       patterns (.insert/.update/.upsert/.delete/.rpc) — read-only by
 *       construction — and no NEXT_PUBLIC_ leakage of the master key.
 *   [b] on ALL three /api/admin/costs/* endpoints:
 *         admin org key   → 200
 *         partner org key → 403 (admin_only)
 *         no key          → 401 (fails closed, ORG_AUTH_REQUIRED pinned false)
 *         garbage key     → 401
 *   [c] internal aggregation correctness on seeded sessions with KNOWN
 *       spend/budget/duration values inside an isolated 1997 date window —
 *       exact totals, avg, p90, utilization buckets, sandbox-hours, trends.
 *   [d] litellm section shape: with real LITELLM_BASE_URL + master key the
 *       gateway is hit LIVE and available:true + shape is asserted; with
 *       stubbed/absent creds available:false is tolerated. Either way the
 *       payload must NEVER contain the master key.
 *
 * Same fail-closed pinning as verify-validity-access.ts: ORG_AUTH_REQUIRED is
 * forced to "false" BEFORE any src import — key-less requests must still 401.
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; clean SKIP (exit 0)
 * without Supabase creds or before migration 0018.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-costs-dashboard.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

// Pin the org-auth flag to the WORST config BEFORE any src module loads
// (env.ts snapshots process.env at first import): the costs surface must
// STILL 401 key-less requests with the back-compat switch active.
process.env.ORG_AUTH_REQUIRED = "false";

// env.ts hard-requires these; stub any that are absent so the verifier can
// still run its static + DB checks in a creds-less environment. Track whether
// LiteLLM creds are REAL — only then is the live-gateway assertion armed.
const litellmIsReal = !!process.env.LITELLM_BASE_URL && !!process.env.LITELLM_MASTER_KEY;
process.env.LITELLM_BASE_URL ??= "https://ci-stub.invalid";
process.env.LITELLM_MASTER_KEY ??= "ci-stub";
process.env.E2B_API_KEY ??= "ci-stub";
process.env.JWT_SECRET ??= "ci-stub-jwt-secret-at-least-32-characters-long-padding";

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ENDPOINTS = ["overview", "litellm", "internal"] as const;

// `any` (below, on injected-response JSON): deliberate — this verifier pokes
// at payloads exactly as an untyped web client would; the shape assertions ARE
// the test, so pre-typing the payload would assume what we're verifying.

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}
const close = (a: number | null | undefined, b: number, eps = 1e-6): boolean =>
  typeof a === "number" && Math.abs(a - b) < eps;

async function main(): Promise<void> {
  console.log("verify-costs-dashboard");

  // ── [a] static: read-only by construction (no creds needed) ───────────────
  console.log("\n[a] no write paths in the costs surface (static)");
  const writeRe = /\.(insert|update|upsert|delete|rpc)\(/;
  const routesSrc = readFileSync(resolve(here, "../src/routes/costs.ts"), "utf8");
  const serviceSrc = readFileSync(resolve(here, "../src/services/costs.ts"), "utf8");
  check("routes/costs.ts has no .insert/.update/.upsert/.delete/.rpc(", !writeRe.test(routesSrc));
  check("services/costs.ts has no .insert/.update/.upsert/.delete/.rpc(", !writeRe.test(serviceSrc));
  check("services/costs.ts never logs the master key (no console.* of MASTER_KEY)",
    !/console\.\w+\([^)]*MASTER_KEY/.test(serviceSrc));

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
  const { costsRoutes } = await import("../src/routes/costs.js");
  const { default: Fastify } = await import("fastify");

  // ── Seed: a partner org + an admin credential + 3 known sessions ──────────
  const run = randomUUID().slice(0, 8);
  const partner = await createOrg(`costs-p-${run}`, `costs-p-${run}`);
  const createdOrgIds: string[] = [partner.org.id];
  const seededSessionIds: string[] = [];

  let adminKey = process.env.ORG_ADMIN_KEY ?? "";
  if (!adminKey) {
    const a = await createOrg(`costs-a-${run}`, `costs-a-${run}`);
    createdOrgIds.push(a.org.id);
    const { error } = await db.from("orgs").update({ role: "admin" }).eq("id", a.org.id);
    if (error) throw new Error(`admin role flip failed: ${error.message}`);
    adminKey = a.apiKey;
  }

  // Isolated aggregation window: nothing real lives on 1997-01-01, so exact
  // totals over ?from&to are deterministic regardless of DB contents.
  const WIN_FROM = "1997-01-01T00:00:00Z";
  const WIN_TO = "1997-01-01T23:59:59Z";
  const base = {
    assessment_id: null,
    sandbox_id: "verify-costs-sbx",
    template: "verify-costs",
    litellm_key_alias: `verify-costs-${run}`,
    model: "gemini-flash",
    timeout_min: 60,
    deadline: "1997-01-01T12:00:00Z",
    org_id: partner.org.id,
    scenario_id: null,
  };
  // spends 0.10 + 0.20 + 0.30 → total 0.60, avg 0.20, p90 0.28 (interpolated).
  // durations 1h + 2h + 0.5h → 3.5 sandbox-hours. s3 hits its budget.
  const seeds = [
    { ...base, id: randomUUID(), status: "completed", end_reason: "manual",  spend_usd: 0.1, budget_usd: 1.0,  duration_ms: 3_600_000, scorable: true,  created_at: "1997-01-01T09:00:00Z" },
    { ...base, id: randomUUID(), status: "completed", end_reason: "timeout", spend_usd: 0.2, budget_usd: 1.0,  duration_ms: 7_200_000, scorable: false, created_at: "1997-01-01T10:00:00Z" },
    { ...base, id: randomUUID(), status: "active",    end_reason: "budget",  spend_usd: 0.3, budget_usd: 0.3,  duration_ms: 1_800_000, scorable: null,  created_at: "1997-01-01T11:00:00Z" },
  ];

  const app = Fastify();
  await app.register(costsRoutes);

  const hit = async (endpoint: string, orgKey?: string, qs = "") =>
    app.inject({
      method: "GET",
      url: `/api/admin/costs/${endpoint}${qs}`,
      ...(orgKey !== undefined ? { headers: { "x-org-key": orgKey } } : {}),
    });

  try {
    const { error: seedErr } = await db.from("sessions").insert(seeds);
    if (seedErr) throw new Error(`session seed failed: ${seedErr.message}`);
    seededSessionIds.push(...seeds.map((s) => s.id));

    // ── [b] access matrix — all three endpoints ──────────────────────────────
    console.log("\n[b] access matrix — all three endpoints");
    for (const ep of ENDPOINTS) {
      const admin = await hit(ep, adminKey);
      check(`${ep}: admin key → 200`, admin.statusCode === 200, `status=${admin.statusCode} body=${admin.body.slice(0, 200)}`);

      const part = await hit(ep, partner.apiKey);
      check(`${ep}: partner key → 403`, part.statusCode === 403, `status=${part.statusCode}`);

      const noKey = await hit(ep);
      check(`${ep}: no key → 401 (fails closed under ORG_AUTH_REQUIRED=false)`, noKey.statusCode === 401, `status=${noKey.statusCode}`);

      const garbage = await hit(ep, "not-a-real-org-key-0000000000");
      check(`${ep}: garbage key → 401`, garbage.statusCode === 401, `status=${garbage.statusCode}`);
    }

    // ── [c] internal aggregation correctness on the seeded window ────────────
    console.log("\n[c] internal aggregation over seeded sessions (exact figures)");
    const res = await hit("internal", adminKey, `?from=${encodeURIComponent(WIN_FROM)}&to=${encodeURIComponent(WIN_TO)}`);
    check("internal (windowed) → 200", res.statusCode === 200, `status=${res.statusCode} body=${res.body.slice(0, 200)}`);
    const internal = (res.json() as { internal: Record<string, any> }).internal;

    check("sessions.total = 3", internal?.sessions?.total === 3, JSON.stringify(internal?.sessions));
    const statusMap = new Map<string, number>(
      (internal?.sessions?.by_status ?? []).map((r: { status: string; n: number }) => [r.status, r.n]),
    );
    check("by_status: completed=2, active=1", statusMap.get("completed") === 2 && statusMap.get("active") === 1);
    check("scorable split 1/1/1 (scorable/excluded/pending)",
      internal?.sessions?.scorable?.scorable_n === 1 &&
      internal?.sessions?.scorable?.excluded_n === 1 &&
      internal?.sessions?.scorable?.pending_n === 1,
      JSON.stringify(internal?.sessions?.scorable));

    check("cost.total_usd = 0.60", close(internal?.cost?.total_usd, 0.6), `got ${internal?.cost?.total_usd}`);
    check("cost.avg_usd = 0.20", close(internal?.cost?.avg_usd, 0.2), `got ${internal?.cost?.avg_usd}`);
    check("cost.p90_usd = 0.28 (interpolated over [0.1,0.2,0.3])", close(internal?.cost?.p90_usd, 0.28), `got ${internal?.cost?.p90_usd}`);

    // utilization: 0.1, 0.2, 1.0 → avg 0.4333; buckets [2,0,0,0,1]; 1 hit.
    check("budget.avg_utilization = 0.4333", close(internal?.budget?.avg_utilization, 0.4333, 1e-4), `got ${internal?.budget?.avg_utilization}`);
    const buckets = (internal?.budget?.distribution ?? []).map((b: { n: number }) => b.n);
    check("budget.distribution = [2,0,0,0,1]", JSON.stringify(buckets) === JSON.stringify([2, 0, 0, 0, 1]), JSON.stringify(internal?.budget?.distribution));
    check("budget.hit_budget_n = 1", internal?.budget?.hit_budget_n === 1, `got ${internal?.budget?.hit_budget_n}`);

    check("sandbox_hours.total = 3.5", close(internal?.sandbox_hours?.total, 3.5), `got ${internal?.sandbox_hours?.total}`);
    const scen = internal?.sandbox_hours?.by_scenario ?? [];
    check("sandbox_hours.by_scenario: one 'no-scenario' row, 3.5h over 3 sessions",
      scen.length === 1 && scen[0]?.scenario_slug === "no-scenario" && close(scen[0]?.hours, 3.5) && scen[0]?.sessions === 3,
      JSON.stringify(scen));

    const daily = internal?.daily ?? [];
    check("daily trend: single 1997-01-01 row {sessions:3, cost_usd:0.6}",
      daily.length === 1 && daily[0]?.date === "1997-01-01" && daily[0]?.sessions === 3 && close(daily[0]?.cost_usd, 0.6),
      JSON.stringify(daily));

    const orgRow = (internal?.by_org ?? []).find((o: { org_id: string }) => o.org_id === partner.org.id);
    check("by_org: partner org row with sessions=3, cost=0.6 (admin sees all orgs)",
      !!orgRow && orgRow.sessions === 3 && close(orgRow.cost_usd, 0.6) && orgRow.org_name === `costs-p-${run}`,
      JSON.stringify(internal?.by_org));

    // ── [d] overview payload shape + litellm section ─────────────────────────
    console.log(`\n[d] overview shape + litellm section (gateway creds ${litellmIsReal ? "REAL — asserting live" : "stubbed — available:false tolerated"})`);
    const ov = await hit("overview", adminKey, `?from=${encodeURIComponent(WIN_FROM)}&to=${encodeURIComponent(WIN_TO)}`);
    check("overview → 200", ov.statusCode === 200, `status=${ov.statusCode}`);
    const body = ov.json() as Record<string, any>;
    check("overview carries {litellm, internal, fixed_services, generated_at}",
      body.litellm !== undefined && body.internal !== undefined &&
      Array.isArray(body.fixed_services) && typeof body.generated_at === "string");
    check("fixed_services has the 6 static cards with {name, plan, est_monthly_usd, dashboard_url, notes}",
      body.fixed_services?.length === 6 &&
      body.fixed_services.every((s: Record<string, unknown>) =>
        typeof s.name === "string" && typeof s.plan === "string" &&
        typeof s.est_monthly_usd === "number" && typeof s.dashboard_url === "string" && typeof s.notes === "string"),
      JSON.stringify(body.fixed_services?.map((s: { name: string }) => s.name)));

    const ll = body.litellm ?? {};
    check("litellm.available is boolean", typeof ll.available === "boolean", JSON.stringify(ll).slice(0, 200));
    if (litellmIsReal) {
      check("litellm (live gateway): available=true", ll.available === true, `error=${ll.error}`);
      if (ll.available === true) {
        check("litellm.daily_by_model is [{date, model, spend_usd}]",
          Array.isArray(ll.daily_by_model) &&
          ll.daily_by_model.every((r: Record<string, unknown>) =>
            typeof r.date === "string" && typeof r.model === "string" && typeof r.spend_usd === "number"));
        check("litellm.month_to_date_usd is a number", typeof ll.month_to_date_usd === "number", `got ${ll.month_to_date_usd}`);
        check("litellm.top_keys is [{key_alias, key_hash_prefix, spend_usd}]",
          Array.isArray(ll.top_keys) &&
          ll.top_keys.every((k: Record<string, unknown>) =>
            (k.key_alias === null || typeof k.key_alias === "string") && typeof k.spend_usd === "number"));
      }
      check("payload NEVER contains the master key",
        !JSON.stringify(body).includes(process.env.LITELLM_MASTER_KEY!));
    } else {
      check("litellm (stubbed creds): degrades to available:false with an error string",
        ll.available === false && typeof ll.error === "string" && ll.error.length > 0,
        JSON.stringify(ll).slice(0, 200));
    }

    // The standalone refresh endpoint returns the same section wrapper.
    const llRes = await hit("litellm", adminKey);
    const llBody = llRes.json() as Record<string, any>;
    check("/litellm wrapper = {litellm, generated_at}",
      llRes.statusCode === 200 && typeof llBody.litellm?.available === "boolean" && typeof llBody.generated_at === "string");
  } finally {
    console.log("\n[cleanup]");
    await app.close();
    if (seededSessionIds.length > 0) {
      const { error } = await db.from("sessions").delete().in("id", seededSessionIds);
      console.log(error ? `  ✗ sessions cleanup failed: ${error.message}` : `  ✓ removed ${seededSessionIds.length} seeded sessions`);
    }
    for (const id of createdOrgIds) {
      await db.from("orgs").delete().eq("id", id);
    }
    console.log(`  ✓ removed ${createdOrgIds.length} seeded org(s)`);
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-costs-dashboard crashed:", err);
  process.exit(1);
});
