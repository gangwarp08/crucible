// Acceptance verifier for the partner outcome-invite flow (deterministic, no
// LLM / no HTTP server). Seeds a synthetic session, then exercises the real
// services/outcome-invites.ts: create → resolve → submit → single-use →
// revoke → expiry, asserting outcomes land as source='partner_form'. Self-cleans.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-outcome-invites.ts
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
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const inv = await import("../src/services/outcome-invites.js");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);
async function expectThrow(fn: () => Promise<unknown>, why: string): Promise<void> {
  try { await fn(); fail(`${why} — expected throw`); }
  catch { pass(why); }
}

const SID = "00000000-0000-4000-8000-0000000d1001";

async function cleanup(): Promise<void> {
  await supabase.from("outcomes").delete().eq("session_id", SID);
  await supabase.from("outcome_invites").delete().eq("session_id", SID);
  await supabase.from("sessions").delete().eq("id", SID);
}

(async () => {
  console.log("verify-outcome-invites");

  const { data: scen } = await supabase.from("scenarios").select("id").eq("slug", "fde-db-triage").single();
  const scenarioId = (scen as { id: string }).id;

  console.log("\n[setup] seeding synthetic session…");
  await cleanup();
  const { error: sErr } = await supabase.from("sessions").insert({
    id: SID, status: "completed", sandbox_id: "verify-invites", template: "crucible-dev",
    litellm_key_alias: "vi-0", model: "gemini-flash", budget_usd: 1.0, timeout_min: 60,
    deadline: "2030-01-01T00:00:00.000Z", scenario_id: scenarioId,
    ended_at: "2026-06-01T00:00:00.000Z", end_reason: "manual", scenario_state: {},
  });
  if (sErr) { fail(`session seed: ${sErr.message}`); await cleanup(); process.exit(1); }

  // [a] create → active, scenario backfilled
  console.log("\n[a] create");
  const { token, invite } = await inv.createInvite(SID);
  if (invite.status === "active") pass("new invite is active");
  else fail(`status=${invite.status}`);
  if (token && token.length >= 20) pass(`raw token returned (${token.length} chars)`);
  else fail("token missing/short");

  // [b] resolve returns context (status + types + scenario title)
  console.log("\n[b] resolve");
  const ctx = await inv.resolveInvite(token);
  if (ctx.status === "active") pass("resolve: active");
  else fail(`resolve status=${ctx.status}`);
  if (ctx.outcome_types.length === 4) pass(`resolve: 4 outcome types`);
  else fail(`outcome_types=${JSON.stringify(ctx.outcome_types)}`);
  if (ctx.scenario_title) pass(`resolve: scenario title present ("${ctx.scenario_title}")`);
  else fail("scenario title missing");
  await expectThrow(() => inv.resolveInvite("not-a-real-token-xxxxxxxx"), "resolve unknown token throws");

  // [c] submit writes outcomes as partner_form + flips status
  console.log("\n[c] submit");
  const res = await inv.submitInvite(token, { hired: true, ramp_weeks: 6, manager_rating_90d: 4, retained_90d: true });
  if (res.written.length === 4) pass("submit wrote 4 outcomes");
  else fail(`written=${JSON.stringify(res.written)}`);
  const { data: rows } = await supabase
    .from("outcomes").select("outcome_type, source, session_id, outcome_value").eq("session_id", SID);
  const outcomes = (rows ?? []) as Array<{ outcome_type: string; source: string; outcome_value: { value: unknown } }>;
  if (outcomes.length === 4 && outcomes.every((o) => o.source === "partner_form"))
    pass("4 outcome rows persisted with source=partner_form");
  else fail(`outcomes=${JSON.stringify(outcomes.map((o) => [o.outcome_type, o.source]))}`);
  const hired = outcomes.find((o) => o.outcome_type === "hired");
  if (hired && (hired.outcome_value.value === true)) pass("hired value stored as boolean true");
  else fail(`hired value=${JSON.stringify(hired?.outcome_value)}`);

  // [d] single-use: status submitted, resubmit refused
  console.log("\n[d] single-use");
  const ctx2 = await inv.resolveInvite(token);
  if (ctx2.status === "submitted") pass("resolve after submit: submitted");
  else fail(`status=${ctx2.status}`);
  await expectThrow(() => inv.submitInvite(token, { hired: false }), "resubmit on used link throws");

  // [e] boundary validation rejected (and nothing extra written)
  console.log("\n[e] validation");
  const { token: t2 } = await inv.createInvite(SID);
  await expectThrow(() => inv.submitInvite(t2, { manager_rating_90d: 9 }), "out-of-range rating rejected");
  await expectThrow(() => inv.submitInvite(t2, {}), "empty submission rejected");

  // [f] revoke blocks use
  console.log("\n[f] revoke");
  const { token: t3, invite: i3 } = await inv.createInvite(SID);
  const revoked = await inv.revokeInvite(i3.id);
  if (revoked.status === "revoked") pass("revoke: status revoked");
  else fail(`status=${revoked.status}`);
  await expectThrow(() => inv.submitInvite(t3, { hired: true }), "submit on revoked link throws");

  // [g] expiry blocks use (force expires_at into the past)
  console.log("\n[g] expiry");
  const { token: t4, invite: i4 } = await inv.createInvite(SID);
  await supabase.from("outcome_invites").update({ expires_at: "2000-01-01T00:00:00.000Z" }).eq("id", i4.id);
  const ctx4 = await inv.resolveInvite(t4);
  if (ctx4.status === "expired") pass("resolve: expired");
  else fail(`status=${ctx4.status}`);
  await expectThrow(() => inv.submitInvite(t4, { hired: true }), "submit on expired link throws");

  console.log("\n[cleanup] removing synthetic rows…");
  await cleanup();

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
