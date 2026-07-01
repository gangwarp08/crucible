// Acceptance verifier for Slice 6.1 — session lifecycle state machine.
// Deterministic, no server/LLM. Seeds a synthetic session and drives it through
// active→submitted→defending→completed via services/session-lifecycle.ts,
// asserting legal transitions apply + persist, illegal ones throw, the new
// lifecycle columns exist, and legacy timed_out rows were backfilled.
// Requires migration 0014 applied. Self-cleans.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-session-lifecycle.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE env"); process.exit(1); }

const lc = await import("../src/services/session-lifecycle.js");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);
async function expectThrow(fn: () => Promise<unknown>, why: string): Promise<void> {
  try { await fn(); fail(`${why} — expected throw`); } catch { pass(why); }
}

const SID = "00000000-0000-4000-8000-00000000a101";
const SID2 = "00000000-0000-4000-8000-00000000a102";

async function seed(id: string, status: string): Promise<string | null> {
  const { error } = await supabase.from("sessions").insert({
    id, status, sandbox_id: "verify-lifecycle", template: "crucible-dev",
    litellm_key_alias: "vl", model: "gemini-flash", budget_usd: 1.0, timeout_min: 60,
    deadline: "2030-01-01T00:00:00.000Z", scenario_state: {},
  });
  return error ? error.message : null;
}
async function statusOf(id: string): Promise<string | undefined> {
  const { data } = await supabase.from("sessions").select("status, deliverable_locked_at, scorable, defense_outcome, exclusion_reason, verification_cap_status").eq("id", id).maybeSingle();
  return (data as { status?: string } | null)?.status;
}
async function rowOf(id: string) {
  const { data } = await supabase.from("sessions").select("status, deliverable_locked_at").eq("id", id).maybeSingle();
  return data as { status?: string; deliverable_locked_at?: string | null } | null;
}
async function cleanup() {
  await supabase.from("sessions").delete().in("id", [SID, SID2]);
}

(async () => {
  console.log("verify-session-lifecycle");
  await cleanup();

  // [a] pure transition legality
  console.log("\n[a] transition legality");
  const legal: Array<[string, string]> = [["active","submitted"],["active","defending"],["active","completed"],["submitted","defending"],["submitted","completed"],["defending","completed"]];
  const illegal: Array<[string, string]> = [["submitted","active"],["defending","submitted"],["defending","active"],["completed","active"],["completed","submitted"]];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ct = (a: string, b: string) => (lc.canTransition as any)(a, b) as boolean;
  if (legal.every(([a,b]) => ct(a,b))) pass(`all ${legal.length} legal transitions allowed`);
  else fail(`legal set wrong: ${JSON.stringify(legal.filter(([a,b]) => !ct(a,b)))}`);
  if (illegal.every(([a,b]) => !ct(a,b))) pass(`all ${illegal.length} illegal transitions rejected`);
  else fail(`illegal set wrong: ${JSON.stringify(illegal.filter(([a,b]) => ct(a,b)))}`);

  // [b] drive a session active→submitted→defending→completed (persisted)
  console.log("\n[b] driven transitions persist");
  const e = await seed(SID, "active");
  if (e) { fail(`seed: ${e}`); await cleanup(); process.exit(1); }
  await lc.transitionSession(SID, "submitted", { deliverableLockedAt: new Date("2026-06-01T00:00:00Z").toISOString() });
  let row = await rowOf(SID);
  if (row?.status === "submitted") pass("active→submitted persisted"); else fail(`status=${row?.status}`);
  if (row?.deliverable_locked_at) pass("deliverable_locked_at stamped on submit"); else fail("deliverable_locked_at not set");
  await lc.transitionSession(SID, "defending");
  if ((await statusOf(SID)) === "defending") pass("submitted→defending persisted"); else fail("not defending");
  await lc.transitionSession(SID, "completed");
  if ((await statusOf(SID)) === "completed") pass("defending→completed persisted"); else fail("not completed");

  // [c] illegal transition throws on a real session
  console.log("\n[c] illegal transition rejected at runtime");
  await seed(SID2, "active");
  await lc.transitionSession(SID2, "submitted");
  await expectThrow(() => lc.transitionSession(SID2, "active"), "submitted→active throws IllegalTransitionError");
  // idempotent no-op
  await lc.transitionSession(SID2, "submitted");
  if ((await statusOf(SID2)) === "submitted") pass("same-state transition is an idempotent no-op"); else fail("idempotency broken");

  // [d] new lifecycle columns exist + readable
  console.log("\n[d] lifecycle columns present");
  const { error: colErr } = await supabase.from("sessions").select("deliverable_locked_at, defense_outcome, scorable, exclusion_reason, verification_cap_status").eq("id", SID2).maybeSingle();
  if (!colErr) pass("all 5 lifecycle columns queryable"); else fail(`columns missing: ${colErr.message}`);

  // [e] legacy timed_out backfilled by migration 0014
  console.log("\n[e] timed_out backfill");
  const { count } = await supabase.from("sessions").select("id", { count: "exact", head: true }).eq("status", "timed_out");
  if ((count ?? 0) === 0) pass("no sessions remain with legacy status='timed_out'"); else fail(`${count} timed_out rows remain (backfill incomplete)`);

  console.log("\n[cleanup]"); await cleanup();
  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
