/**
 * verify-budget-failclosed.ts — H2 (Slice 6.8b) acceptance.
 *
 * The global daily spend circuit breaker: seed today's cost_ledger ABOVE the
 * ceiling, then assert POST /sessions is refused with 503 BEFORE any sandbox is
 * created. Cleans up immediately (cascade delete) so it can't wedge other
 * session creation.
 *
 * Fail-closed contract (deny when spend can't be measured) is enforced in
 * routes/sessions.ts: sumTodaySpendUsd() THROWS on a Supabase error and the
 * handler returns 503 — verified by code review; not force-triggerable live
 * without breaking the shared DB.
 *
 * Exit 0 on PASS, non-zero on FAIL. SKIPs without Supabase creds / server.
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const INVITE_CODE = process.env.INVITE_CODE;
const CEILING = Number(process.env.GLOBAL_DAILY_SPEND_CEILING_USD ?? "50");

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

async function main(): Promise<void> {
  console.log("verify-budget-failclosed — H2 (Slice 6.8b)");
  const url =
    process.env.SUPABASE_URL ??
    (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("  ⚠ SKIP — Supabase creds absent");
    process.exit(0);
  }
  try {
    const h = await fetch(`${SERVER_URL}/health`);
    if (!h.ok) throw new Error("bad health");
  } catch {
    console.log(`  ⚠ SKIP — server not reachable at ${SERVER_URL}`);
    process.exit(0);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: WebSocket as any },
  });

  // Seed a throwaway session + a cost_ledger row that pushes today's total
  // OVER the ceiling. cost_ledger cascades on session delete → clean teardown.
  const seedSessionId = randomUUID();
  const overCeiling = CEILING + 100;
  const sErr = (
    await supabase.from("sessions").insert({
      id: seedSessionId,
      status: "completed",
      sandbox_id: "seed",
      template: "seed",
      litellm_key_alias: "seed",
      model: "seed",
      budget_usd: 1,
      timeout_min: 30,
      deadline: new Date(Date.now() + 60_000).toISOString(),
    })
  ).error;
  if (sErr) {
    console.log(`  ✗ seed session failed: ${sErr.message}`);
    process.exit(1);
  }
  const cErr = (
    await supabase.from("cost_ledger").insert({
      session_id: seedSessionId,
      cost_usd: overCeiling,
      model: "seed",
    })
  ).error;
  if (cErr) {
    await supabase.from("sessions").delete().eq("id", seedSessionId);
    console.log(`  ✗ seed cost_ledger failed: ${cErr.message}`);
    process.exit(1);
  }

  try {
    const r = await fetch(`${SERVER_URL}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(INVITE_CODE ? { inviteCode: INVITE_CODE } : {}) }),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    check("over-ceiling → POST /sessions 503", r.status === 503, `got ${r.status} ${JSON.stringify(body)}`);
    check("503 error code = global_spend_ceiling", body.error === "global_spend_ceiling", String(body.error));
    // No session id should be returned when the breaker trips.
    check("no session created when breaker trips", body.sessionId === undefined);
  } finally {
    // Cascade: deleting the session removes the seeded cost_ledger row, so the
    // breaker is disarmed for everyone again.
    await supabase.from("sessions").delete().eq("id", seedSessionId);
  }

  console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed} check(s))`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
