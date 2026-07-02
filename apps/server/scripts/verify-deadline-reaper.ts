// verify-deadline-reaper.ts — the deadline reaper force-completes overdue,
// non-terminal sessions (the "stuck on defending after a restart" fix).
//
// Seeds a session in each non-terminal status (active / submitted / defending)
// with a deadline in the PAST and ended_at=null (scenario_id=null so no analysis
// fires for the synthetic rows), runs one sweep, and asserts each is now
// completed with end_reason=timeout + ended_at stamped. A future-deadline
// session is left untouched.
//
// Run: pnpm exec tsx scripts/verify-deadline-reaper.ts
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const url = process.env.SUPABASE_URL ?? (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);

async function main(): Promise<void> {
  console.log("verify-deadline-reaper");
  if (!url || !key) { console.log("  ⚠ SKIP — Supabase creds absent"); process.exit(0); }

  const { createClient } = await import("@supabase/supabase-js");
  const { WebSocket } = await import("undici");
  const { sweepOverdueSessions } = await import("../src/services/deadline-reaper.js");
  const supabase = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, realtime: { transport: WebSocket as unknown as never } });

  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const seed = (status: string, deadline: string) => ({
    id: randomUUID(), status, sandbox_id: "reaper-seed", template: "seed", litellm_key_alias: "reaper-seed",
    model: "seed", budget_usd: 1, timeout_min: 30, deadline, created_at: past,
  });
  const overdue = ["active", "submitted", "defending"].map((s) => seed(s, past));
  const fresh = seed("defending", future); // NOT overdue — must be left alone
  const all = [...overdue, fresh];

  const insErr = (await supabase.from("sessions").insert(all)).error;
  if (insErr) { console.error("seed failed:", insErr.message); process.exit(1); }
  const ids = all.map((r) => r.id);

  try {
    const reaped = await sweepOverdueSessions();
    console.log(`  sweep reaped ${reaped} session(s) (includes any other overdue live sessions)`);

    const { data: rows } = await supabase.from("sessions").select("id, status, end_reason, ended_at, deadline").in("id", ids);
    const byId = new Map((rows ?? []).map((r) => [r.id as string, r]));

    for (const r of overdue) {
      const row = byId.get(r.id) as { status?: string; end_reason?: string; ended_at?: string } | undefined;
      const ok = row?.status === "completed" && row?.end_reason === "timeout" && !!row?.ended_at;
      if (ok) pass(`overdue '${r.status}' → completed + end_reason=timeout + ended_at`);
      else fail(`overdue '${r.status}' not reaped: ${JSON.stringify(row)}`);
    }
    const freshRow = byId.get(fresh.id) as { status?: string } | undefined;
    if (freshRow?.status === "defending") pass("future-deadline session left untouched (still defending)");
    else fail(`future-deadline session was wrongly reaped: ${JSON.stringify(freshRow)}`);
  } finally {
    await supabase.from("sessions").delete().in("id", ids);
  }

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
}

void main();
