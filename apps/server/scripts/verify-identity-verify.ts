/**
 * verify-identity-verify.ts — P6.2 acceptance (identity match, derived-only).
 *
 * Infra-light (Supabase service-role only — no E2B, no LLM: the gateway
 * vision call is MOCKED via verifyIdentity's injectable comparer). Asserts:
 *   [a] match (confidence ≥ threshold) → verified=true stored + event;
 *       no-match → verified=false stored; confidence round-trips;
 *   [b] DERIVED-ONLY STORAGE: the raw images (tagged with a unique marker)
 *       appear NOWHERE — not in identity_checks columns, not in any events
 *       payload, not in console output produced during verification;
 *   [c] consent gate at the service layer: no accepted consent → refused;
 *   [d] the PUBLIC shared report (services/shared-report.ts) contains ZERO
 *       identity material — no consent/verified/confidence, no identity keys,
 *       no marker (the P4.3 allowlist excludes the whole channel).
 *
 * Cleans up everything it seeds. Exit 0 PASS / 1 FAIL; clean SKIP (exit 0)
 * without Supabase creds or before migrations 0018/0024.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-identity-verify.ts
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

// Unique, unmistakable marker embedded in the fake "raw biometric" images —
// if this string lands ANYWHERE durable or logged, storage is not derived-only.
const RAW_MARKER = `RAWBIOMETRIC${randomUUID().replace(/-/g, "")}`;
const ID_IMAGE = `data:image/jpeg;base64,${RAW_MARKER}AAAA`;
const SELFIE_IMAGE = `data:image/jpeg;base64,${RAW_MARKER}BBBB`;

async function main(): Promise<void> {
  console.log("verify-identity-verify — P6.2");
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
  const {
    recordConsent,
    verifyIdentity,
    readIdentityStatus,
    MATCH_CONFIDENCE_THRESHOLD,
    ProctoringV2Error,
  } = await import("../src/services/proctoring-v2.js");
  const { buildSharedReport } = await import("../src/services/shared-report.js");

  // ── Seed: flag-on org + two sessions (accepted / declined consent) ────────
  const run = randomUUID().slice(0, 8);
  const a = await createOrg(`pv2-idv-${run}`, `pv2-idv-${run}`);
  await supabase.from("orgs").update({ settings: { proctoring_v2_enabled: true } }).eq("id", a.org.id);

  const SID = randomUUID();
  const SID_DECLINED = randomUUID();
  const seedSession = async (id: string) => {
    const { error } = await supabase.from("sessions").insert({
      id, status: "completed", sandbox_id: `pv2-idv-${run}`, template: "crucible-dev",
      litellm_key_alias: `idv-${id.slice(0, 8)}`, model: "gemini-flash",
      budget_usd: 1.0, timeout_min: 60, deadline: "2030-01-01T00:00:00.000Z",
      scenario_state: {}, org_id: a.org.id,
    });
    if (error) throw new Error(`seed session failed: ${error.message}`);
  };
  await seedSession(SID);
  await seedSession(SID_DECLINED);

  const cleanup = async () => {
    for (const sid of [SID, SID_DECLINED]) {
      await supabase.from("events").delete().eq("session_id", sid);
      await supabase.from("identity_checks").delete().eq("session_id", sid);
      await supabase.from("sessions").delete().eq("id", sid);
    }
    await supabase.from("orgs").delete().eq("id", a.org.id);
  };

  try {
    await recordConsent(SID, a.org, "accepted");
    await recordConsent(SID_DECLINED, a.org, "declined");

    // Capture ALL console output during verification — the raw images must
    // never be logged (data-minimization posture; see proctoring-v2.ts header).
    const logged: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    console.warn = console.log as typeof console.warn;
    console.error = console.log as typeof console.error;

    let matchRes: { verified: boolean; matchConfidence: number };
    let noMatchRes: { verified: boolean; matchConfidence: number };
    let comparerSawRaws = false;
    try {
      // MOCKED gateway comparer (the injectable seam): sees the raw images in
      // memory — as the real gateway call does — and returns a confidence.
      matchRes = await verifyIdentity(SID, a.org, ID_IMAGE, SELFIE_IMAGE,
        async (idImg, selfieImg) => {
          comparerSawRaws = idImg.includes(RAW_MARKER) && selfieImg.includes(RAW_MARKER);
          return 0.93;
        });
      noMatchRes = await verifyIdentity(SID, a.org, ID_IMAGE, SELFIE_IMAGE, async () => 0.42);
    } finally {
      console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
    }

    // ── [a] match / no-match, derived result stored ────────────────────────
    console.log("\n[a] match / no-match");
    check("comparer received the raw images in memory", comparerSawRaws);
    check(`match: 0.93 ≥ ${MATCH_CONFIDENCE_THRESHOLD} → verified=true`,
      matchRes.verified === true && matchRes.matchConfidence === 0.93, JSON.stringify(matchRes));
    check("no-match: 0.42 → verified=false",
      noMatchRes.verified === false && noMatchRes.matchConfidence === 0.42, JSON.stringify(noMatchRes));
    const status = await readIdentityStatus(SID);
    check("stored status reflects the LAST attempt (declined? no — accepted, unverified, 0.42)",
      status?.consent === "accepted" && status.verified === false && status.matchConfidence === 0.42,
      JSON.stringify(status));
    const verifiedEvts = await supabase
      .from("events").select("payload, actor").eq("session_id", SID).eq("type", "identity.verified")
      .order("seq", { ascending: true });
    const evts = (verifiedEvts.data ?? []) as Array<{ actor: string; payload: Record<string, unknown> }>;
    check("identity.verified events appended (derived payload, actor system)",
      evts.length === 2 && evts[0]!.actor === "system" &&
      evts[0]!.payload.verified === true && evts[0]!.payload.match_confidence === 0.93,
      JSON.stringify(evts));

    // ── [b] DERIVED-ONLY: no raw base64 anywhere ───────────────────────────
    console.log("\n[b] derived-only storage (no raws in db / events / logs)");
    const rowFull = await supabase.from("identity_checks").select("*").eq("session_id", SID);
    const rowJson = JSON.stringify(rowFull.data ?? []);
    check("identity_checks columns carry NO image data",
      !rowJson.includes(RAW_MARKER) && !rowJson.includes("data:image"), rowJson.slice(0, 200));
    const allEvts = await supabase.from("events").select("type, payload").eq("session_id", SID);
    const evtsJson = JSON.stringify(allEvts.data ?? []);
    check("events payloads carry NO image data",
      !evtsJson.includes(RAW_MARKER) && !evtsJson.includes("data:image"));
    const logJson = logged.join("\n");
    check("nothing logged during verification contains image data",
      !logJson.includes(RAW_MARKER) && !logJson.includes("data:image"),
      logJson.slice(0, 200));

    // ── [c] consent gate at the service layer ──────────────────────────────
    console.log("\n[c] service-layer consent gate");
    let refused = false;
    try {
      await verifyIdentity(SID_DECLINED, a.org, ID_IMAGE, SELFIE_IMAGE, async () => 0.99);
    } catch (err) {
      refused = err instanceof ProctoringV2Error;
    }
    check("declined-consent session refused even with a direct service call", refused);
    const declinedRows = await supabase
      .from("identity_checks").select("verified, match_confidence").eq("session_id", SID_DECLINED).maybeSingle();
    check("declined session's row untouched (no verification result)",
      declinedRows.data?.verified === null && declinedRows.data?.match_confidence === null,
      JSON.stringify(declinedRows.data));

    // ── [d] public shared report excludes ALL identity data ────────────────
    console.log("\n[d] shared report exclusion (P4.3 allowlist)");
    const report = await buildSharedReport(SID, "2030-01-01T00:00:00.000Z");
    const reportJson = JSON.stringify(report);
    check("report has no 'identity' keys/values", !reportJson.toLowerCase().includes("identity"), reportJson.slice(0, 200));
    check("report has no consent material", !reportJson.toLowerCase().includes("consent"));
    check("report has no match confidence", !reportJson.includes("match_confidence") && !reportJson.includes("matchConfidence") && !reportJson.includes("0.42"));
    check("report has no raw image material", !reportJson.includes(RAW_MARKER) && !reportJson.includes("data:image"));
    check("report still carries the (allowlisted) suspicion score+version only",
      typeof report.suspicion.score === "number" && typeof report.suspicion.version === "string");
  } finally {
    console.log("\n[cleanup]");
    await cleanup();
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-identity-verify crashed:", err);
  process.exit(1);
});
