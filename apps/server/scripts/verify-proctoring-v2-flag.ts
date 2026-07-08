/**
 * verify-proctoring-v2-flag.ts — P6.1 acceptance (org flag + consent gate).
 *
 * Infra-light (Supabase service-role + in-process Fastify inject — no E2B, no
 * LLM, no listening socket): exercises the DORMANCY contract end-to-end
 * against the real routes:
 *   [a] pure flag read — only the literal boolean true enables v2;
 *   [b] proctoring-config: flag off / unknown token → { v2Enabled: false };
 *       flag on → consent text + version served;
 *   [c] flag OFF → consent + identity-verify endpoints REFUSE (403) and
 *       ZERO identity rows / identity.* events exist ("no capture when off");
 *   [d] flag ON → identity-verify refuses BEFORE a recorded consent;
 *       accept → consent recorded (row + identity.consent event) and the
 *       consent gate opens; DECLINE → recorded, identity-verify still
 *       refuses (decline downgrades to v1 — signed-off policy).
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; clean SKIP (exit 0)
 * without Supabase creds or before migrations 0018/0024.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-proctoring-v2-flag.ts
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
const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");

async function main(): Promise<void> {
  console.log("verify-proctoring-v2-flag — P6.1");
  if (!url || !key) {
    console.log("  ⚠ SKIP — Supabase creds absent");
    process.exit(0);
  }

  // Dynamic imports AFTER dotenv — these modules transitively import env.ts.
  const { supabase } = await import("../src/services/supabase.js");
  if (!supabase) {
    console.log("  ⚠ SKIP — service-role client unavailable");
    process.exit(0);
  }
  const { createOrg } = await import("../src/services/orgs.js");
  const {
    proctoringV2EnabledFromSettings,
    CONSENT_TEXT,
    CONSENT_TEXT_VERSION,
  } = await import("../src/services/proctoring-v2.js");
  const { proctoringRoutes } = await import("../src/routes/proctoring.js");
  const { signToken } = await import("../src/services/session-token.js");
  const { default: Fastify } = await import("fastify");

  // ── [a] pure flag read (runs even pre-0024 — no I/O) ──────────────────────
  console.log("\n[a] flag read (only literal true enables)");
  check("absent settings → false", !proctoringV2EnabledFromSettings(undefined));
  check("empty settings → false", !proctoringV2EnabledFromSettings({}));
  check("string 'true' → false", !proctoringV2EnabledFromSettings({ proctoring_v2_enabled: "true" }));
  check("literal true → true", proctoringV2EnabledFromSettings({ proctoring_v2_enabled: true }));
  check("non-object → false", !proctoringV2EnabledFromSettings("proctoring_v2_enabled"));

  // Skip-graceful gates: 0018 (orgs) and 0024 (identity_checks) must exist.
  const orgsProbe = await supabase.from("orgs").select("id").limit(1);
  if (orgsProbe.error && /42P01|PGRST205|does not exist|Could not find the table/i.test(`${orgsProbe.error.code} ${orgsProbe.error.message}`)) {
    console.log("\n  ⚠ SKIP remainder — orgs table absent (migration 0018 not applied)");
    process.exit(failed === 0 ? 0 : 1);
  }
  const idProbe = await supabase.from("identity_checks").select("id").limit(1);
  if (idProbe.error && /42P01|PGRST205|does not exist|Could not find the table/i.test(`${idProbe.error.code} ${idProbe.error.message}`)) {
    console.log("\n  ⚠ SKIP remainder — identity_checks absent (migration 0024 not applied; P6 dormant)");
    console.log(failed === 0 ? "\nPASS (pure checks) + SKIP (db-backed checks)" : `\nFAIL — ${failed} check(s) failed`);
    process.exit(failed === 0 ? 0 : 1);
  }

  // ── Seed: two orgs (flag off / on), sessions, session links ───────────────
  const run = randomUUID().slice(0, 8);
  const off = await createOrg(`pv2-flag-off-${run}`, `pv2-flag-off-${run}`);
  const on = await createOrg(`pv2-flag-on-${run}`, `pv2-flag-on-${run}`);
  const seededOrgIds = [off.org.id, on.org.id];
  {
    const { error } = await supabase
      .from("orgs")
      .update({ settings: { proctoring_v2_enabled: true } })
      .eq("id", on.org.id);
    if (error) throw new Error(`org flag update failed: ${error.message}`);
  }

  const S_OFF = randomUUID(); // session in the flag-off org
  const S_ON = randomUUID();  // session in the flag-on org (accept path)
  const S_DEC = randomUUID(); // session in the flag-on org (decline path)
  const sessionIds = [S_OFF, S_ON, S_DEC];
  const seedSession = async (id: string, orgId: string) => {
    const { error } = await supabase.from("sessions").insert({
      id, status: "active", sandbox_id: `pv2-${run}`, template: "crucible-dev",
      litellm_key_alias: `pv2-${id.slice(0, 8)}`, model: "gemini-flash",
      budget_usd: 1.0, timeout_min: 60, deadline: "2030-01-01T00:00:00.000Z",
      scenario_state: {}, org_id: orgId,
    });
    if (error) throw new Error(`seed session failed: ${error.message}`);
  };
  await seedSession(S_OFF, off.org.id);
  await seedSession(S_ON, on.org.id);
  await seedSession(S_DEC, on.org.id);

  const tokenOff = randomBytes(32).toString("base64url");
  const tokenOn = randomBytes(32).toString("base64url");
  const linkIds: string[] = [];
  for (const [token, orgId] of [[tokenOff, off.org.id], [tokenOn, on.org.id]] as const) {
    const linkId = randomUUID();
    linkIds.push(linkId);
    const { error } = await supabase.from("session_links").insert({
      id: linkId, token_hash: sha256(token), candidate_label: `pv2-${run}`,
      expires_at: "2030-01-01T00:00:00.000Z", org_id: orgId,
    });
    if (error) throw new Error(`seed session_link failed: ${error.message}`);
  }

  const app = Fastify();
  await app.register(proctoringRoutes);
  const deadlineMs = Date.now() + 60 * 60 * 1000;
  const bearer = (sid: string) => ({ authorization: `Bearer ${signToken(sid, deadlineMs)}` });
  const IMAGES = {
    idImage: `data:image/jpeg;base64,${"QQ==".repeat(16)}`,
    selfieImage: `data:image/jpeg;base64,${"Ug==".repeat(16)}`,
  };

  const cleanup = async () => {
    await app.close();
    for (const sid of sessionIds) {
      await supabase.from("events").delete().eq("session_id", sid);
      await supabase.from("identity_checks").delete().eq("session_id", sid);
      await supabase.from("sessions").delete().eq("id", sid);
    }
    for (const id of linkIds) await supabase.from("session_links").delete().eq("id", id);
    for (const id of seededOrgIds) await supabase.from("orgs").delete().eq("id", id);
  };

  try {
    // ── [b] proctoring-config ─────────────────────────────────────────────
    console.log("\n[b] proctoring-config (link → org flag)");
    const cfgOff = await app.inject({ method: "GET", url: `/api/session-links/${tokenOff}/proctoring-config` });
    check("flag off → v2Enabled false", cfgOff.statusCode === 200 && cfgOff.json().v2Enabled === false, cfgOff.body);
    check("flag off → NO consent text served", cfgOff.json().consentText === undefined);
    const cfgUnknown = await app.inject({ method: "GET", url: `/api/session-links/${randomBytes(32).toString("base64url")}/proctoring-config` });
    check("unknown token → v2Enabled false", cfgUnknown.json().v2Enabled === false);
    const cfgOn = await app.inject({ method: "GET", url: `/api/session-links/${tokenOn}/proctoring-config` });
    const onBody = cfgOn.json() as { v2Enabled: boolean; consentText?: string; consentTextVersion?: string };
    check("flag on → v2Enabled true", onBody.v2Enabled === true, cfgOn.body);
    check("flag on → consent text + version served",
      onBody.consentText === CONSENT_TEXT && onBody.consentTextVersion === CONSENT_TEXT_VERSION);

    // ── [c] flag OFF → endpoints refuse, zero capture ─────────────────────
    console.log("\n[c] flag off → refuse + zero identity data");
    const consentOff = await app.inject({
      method: "POST", url: `/sessions/${S_OFF}/consent`, headers: bearer(S_OFF),
      payload: { decision: "accepted", consentTextVersion: CONSENT_TEXT_VERSION },
    });
    check("consent refused (403) when flag off", consentOff.statusCode === 403, `status=${consentOff.statusCode}`);
    const verifyOff = await app.inject({
      method: "POST", url: `/sessions/${S_OFF}/identity-verify`, headers: bearer(S_OFF),
      payload: IMAGES,
    });
    check("identity-verify refused (403) when flag off", verifyOff.statusCode === 403, `status=${verifyOff.statusCode}`);
    const rowsOff = await supabase.from("identity_checks").select("id").eq("session_id", S_OFF);
    check("zero identity_checks rows for the flag-off session", (rowsOff.data ?? []).length === 0);
    const eventsOff = await supabase.from("events").select("id").eq("session_id", S_OFF).like("type", "identity.%");
    check("zero identity.* events for the flag-off session", (eventsOff.data ?? []).length === 0);

    // ── [d] flag ON → consent gate ────────────────────────────────────────
    console.log("\n[d] flag on → consent required before verify; decline downgrades");
    const verifyEarly = await app.inject({
      method: "POST", url: `/sessions/${S_ON}/identity-verify`, headers: bearer(S_ON),
      payload: IMAGES,
    });
    check("identity-verify refused (403 consent_required) BEFORE consent",
      verifyEarly.statusCode === 403 && verifyEarly.json().error === "consent_required", verifyEarly.body);

    const noToken = await app.inject({
      method: "POST", url: `/sessions/${S_ON}/consent`,
      payload: { decision: "accepted" },
    });
    check("consent without session token → 401", noToken.statusCode === 401, `status=${noToken.statusCode}`);

    const consentOn = await app.inject({
      method: "POST", url: `/sessions/${S_ON}/consent`, headers: bearer(S_ON),
      payload: { decision: "accepted", consentTextVersion: CONSENT_TEXT_VERSION },
    });
    check("accept recorded (200)", consentOn.statusCode === 200 && consentOn.json().recorded === true, consentOn.body);
    const rowOn = await supabase
      .from("identity_checks")
      .select("decision, consent_text_version, org_id")
      .eq("session_id", S_ON).maybeSingle();
    check("identity_checks row: decision 'accept', versioned, org-stamped",
      rowOn.data?.decision === "accept" &&
      rowOn.data?.consent_text_version === CONSENT_TEXT_VERSION &&
      rowOn.data?.org_id === on.org.id,
      JSON.stringify(rowOn.data));
    const consentEvt = await supabase
      .from("events").select("type, actor, payload").eq("session_id", S_ON).eq("type", "identity.consent").maybeSingle();
    const evtPayload = (consentEvt.data?.payload ?? {}) as Record<string, unknown>;
    check("identity.consent event appended (decision 'accepted')",
      consentEvt.data?.actor === "candidate" && evtPayload.decision === "accepted",
      JSON.stringify(consentEvt.data));
    // After accepted consent the CONSENT gate opens: identity-verify must get
    // PAST 403 (it then fails later — no live registry key in this harness —
    // which is exactly the boundary we want: gate logic, no gateway call).
    const verifyAfter = await app.inject({
      method: "POST", url: `/sessions/${S_ON}/identity-verify`, headers: bearer(S_ON),
      payload: IMAGES,
    });
    check("after accept, identity-verify passes the consent gate (not 403)",
      verifyAfter.statusCode !== 403, `status=${verifyAfter.statusCode} ${verifyAfter.body}`);

    const decline = await app.inject({
      method: "POST", url: `/sessions/${S_DEC}/consent`, headers: bearer(S_DEC),
      payload: { decision: "declined", consentTextVersion: CONSENT_TEXT_VERSION },
    });
    check("decline recorded (200)", decline.statusCode === 200 && decline.json().decision === "declined", decline.body);
    const rowDec = await supabase
      .from("identity_checks").select("decision").eq("session_id", S_DEC).maybeSingle();
    check("declined row stored as 'decline'", rowDec.data?.decision === "decline");
    const verifyDeclined = await app.inject({
      method: "POST", url: `/sessions/${S_DEC}/identity-verify`, headers: bearer(S_DEC),
      payload: IMAGES,
    });
    check("after DECLINE, identity-verify refused (decline → v1 downgrade)",
      verifyDeclined.statusCode === 403 && verifyDeclined.json().error === "consent_required",
      verifyDeclined.body);
    const reconsent = await app.inject({
      method: "POST", url: `/sessions/${S_DEC}/consent`, headers: bearer(S_DEC),
      payload: { decision: "accepted", consentTextVersion: CONSENT_TEXT_VERSION },
    });
    check("re-posting consent cannot flip a recorded decline",
      reconsent.statusCode === 200 && reconsent.json().decision === "declined", reconsent.body);
  } finally {
    console.log("\n[cleanup]");
    await cleanup();
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-proctoring-v2-flag crashed:", err);
  process.exit(1);
});
