/**
 * verify-geo-integrity.ts — geo/network integrity slice acceptance.
 *
 * Infra-light (Supabase service-role + in-process Fastify inject — no E2B, no
 * LLM, no listening server). Asserts:
 *   [a] recordNetworkObservation: integrity.geo appended ONCE on the first
 *       observation (geoip country + per-session-salted ip_hash, actor
 *       "system"); same-IP repeats are no-ops; a distinct IP appends
 *       integrity.ip_change with correct change_count / prev/new hashes /
 *       country_changed; concurrent same-IP observations don't double-append.
 *   [b] restart statelessness (state rebuilt from event rows after
 *       resetGeoIntegrityState) + the 10-ip_change cap + PRIVACY: the raw IP
 *       literal appears in NO event payload; unknown-geo changes are
 *       conservatively country_changed=false.
 *   [c] suspicion detector v3 factors (hand-computed) over the persisted rows.
 *   [d] ingest route: client-posted integrity.geo / integrity.ip_change →
 *       explicit 400; integrity.client_env accepted; each authenticated POST
 *       also records a network observation.
 *   [e] review suspicion endpoint returns the recruiter-only `network` block
 *       with the agreed shape.
 *   [f] the PUBLIC shared report contains no geo/network material at all.
 * Self-cleans. Exit 0 on PASS, 1 on FAIL.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-geo-integrity.ts
 */
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

// Dynamic imports AFTER dotenv — src modules transitively import env.ts.
const geoip = (await import("geoip-lite")).default;
const {
  recordNetworkObservation,
  resetGeoIntegrityState,
  hashSessionIp,
  IP_CHANGE_EVENT_CAP,
} = await import("../src/services/geo-integrity.js");
const {
  computeSuspicionScore,
  computeNetworkSummary,
  SUSPICION_WEIGHTS,
} = await import("../src/services/suspicion-score.js");
type SuspicionEventInput = import("../src/services/suspicion-score.js").SuspicionEventInput;
const { integrityRoutes, resetIntegrityLimiter } = await import("../src/routes/integrity.js");
const { reviewRoutes } = await import("../src/routes/review.js");
const { sessionRegistry } = await import("../src/services/registry.js");
const { flushTelemetry } = await import("../src/services/telemetry.js");
const { signToken } = await import("../src/services/session-token.js");
const { buildSharedReport } = await import("../src/services/shared-report.js");
const { default: Fastify } = await import("fastify");
type SessionEntry = import("../src/services/registry.js").SessionEntry;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);
const check = (m: string, ok: boolean, detail?: string) =>
  ok ? pass(m) : fail(`${m}${detail ? ` — ${detail}` : ""}`);

const SID_A = "00000000-0000-4000-8000-00000000b201"; // service-level tests (NOT in registry → direct path)
const SID_B = "00000000-0000-4000-8000-00000000b202"; // route-inject tests (fake registry entry)

// Fixed public IPs with stable geoip-lite results (8.8.8.8 → US, 1.1.1.1 → AU,
// 81.2.69.142 → GB) + TEST-NET-3 addresses that geoip-lite cannot resolve.
const IP1 = "8.8.8.8";
const IP2 = "1.1.1.1";
const IP3 = "81.2.69.142";
const capIps = Array.from({ length: 12 }, (_, i) => `203.0.113.${i + 1}`);
const ALL_IPS = [IP1, IP2, IP3, ...capIps, "127.0.0.1"];

async function lookupSeedOrgId(): Promise<string | null> {
  const { data, error } = await supabase.from("orgs").select("id").eq("slug", "asaya").maybeSingle();
  if (error) {
    if (/42P01|PGRST205|does not exist|Could not find the table/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) {
      return null;
    }
    throw new Error(`orgs lookup failed: ${error.message}`);
  }
  return (data as { id: string } | null)?.id ?? null;
}

async function seedSession(id: string): Promise<string | null> {
  const orgId = await lookupSeedOrgId();
  const { error } = await supabase.from("sessions").insert({
    id, status: "active", sandbox_id: "verify-geo", template: "crucible-dev",
    litellm_key_alias: "vg", model: "gemini-flash", budget_usd: 1.0, timeout_min: 60,
    deadline: "2030-01-01T00:00:00.000Z", scenario_state: {},
    ...(orgId ? { org_id: orgId } : {}),
  });
  return error ? error.message : null;
}

async function cleanup(): Promise<void> {
  for (const id of [SID_A, SID_B]) {
    await supabase.from("events").delete().eq("session_id", id);
    await supabase.from("sessions").delete().eq("id", id);
  }
  resetGeoIntegrityState();
  resetIntegrityLimiter();
}

interface EventRow { seq: number; type: string; actor: string; ts: string; payload: Record<string, unknown> }
async function readEvents(id: string): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("events").select("seq, type, actor, ts, payload")
    .eq("session_id", id).order("seq", { ascending: true });
  if (error) throw new Error(`events read failed: ${error.message}`);
  return (data ?? []) as unknown as EventRow[];
}

(async () => {
  console.log("verify-geo-integrity — geo/network integrity slice");
  await cleanup();
  for (const id of [SID_A, SID_B]) {
    const err = await seedSession(id);
    if (err) { fail(`seed session ${id}: ${err}`); await cleanup(); process.exit(1); }
  }

  // ── [a] recordNetworkObservation — first geo + ip changes ────────────────
  console.log("\n[a] recordNetworkObservation");
  await recordNetworkObservation(SID_A, IP1, "session_create");
  let rows = await readEvents(SID_A);
  const geoRows = rows.filter((r) => r.type === "integrity.geo");
  check("first observation appends exactly one integrity.geo", geoRows.length === 1 && rows.length === 1);
  const g = geoRows[0];
  const expectGeo1 = geoip.lookup(IP1);
  check("geo actor is 'system'", g?.actor === "system", g?.actor);
  check(`geo country matches geoip-lite (${expectGeo1?.country})`,
    g?.payload["country"] === (expectGeo1?.country || null), JSON.stringify(g?.payload));
  check("geo ip_hash = sha256(sessionId+ip)[0:16]",
    g?.payload["ip_hash"] === hashSessionIp(SID_A, IP1), String(g?.payload["ip_hash"]));
  check("geo payload has exactly the agreed keys",
    JSON.stringify(Object.keys(g?.payload ?? {}).sort()) === JSON.stringify(["city", "country", "ip_hash", "region"]));

  await recordNetworkObservation(SID_A, IP1, "integrity_batch");
  await recordNetworkObservation(SID_A, IP1, "integrity_batch");
  rows = await readEvents(SID_A);
  check("same-IP repeats append nothing", rows.length === 1, `rows=${rows.length}`);

  await recordNetworkObservation(SID_A, IP2, "integrity_batch");
  rows = await readEvents(SID_A);
  const change1 = rows.find((r) => r.type === "integrity.ip_change");
  const expectGeo2 = geoip.lookup(IP2);
  const expectChanged12 =
    (expectGeo1?.country || null) !== null && (expectGeo2?.country || null) !== null &&
    expectGeo1!.country !== expectGeo2!.country;
  check("distinct IP appends integrity.ip_change", change1 !== undefined && rows.length === 2);
  check("ip_change actor is 'system'", change1?.actor === "system");
  check("ip_change change_count=1", change1?.payload["change_count"] === 1);
  check("ip_change prev/new hashes correct",
    change1?.payload["prev_ip_hash"] === hashSessionIp(SID_A, IP1) &&
    change1?.payload["new_ip_hash"] === hashSessionIp(SID_A, IP2));
  check(`ip_change country_changed=${expectChanged12} (US→AU)`,
    change1?.payload["country_changed"] === expectChanged12, JSON.stringify(change1?.payload));
  check("ip_change new_country matches geoip-lite",
    change1?.payload["new_country"] === (expectGeo2?.country || null));

  // Concurrent observations of the SAME new IP → serialized → ONE ip_change.
  await Promise.all([
    recordNetworkObservation(SID_A, IP3, "integrity_batch"),
    recordNetworkObservation(SID_A, IP3, "integrity_batch"),
    recordNetworkObservation(SID_A, IP3, "integrity_batch"),
  ]);
  rows = await readEvents(SID_A);
  check("concurrent same-IP observations append exactly one ip_change (serialized)",
    rows.filter((r) => r.type === "integrity.ip_change").length === 2, `rows=${rows.length}`);

  // ── [b] restart statelessness + cap + privacy ────────────────────────────
  console.log("\n[b] restart statelessness, cap, privacy");
  resetGeoIntegrityState(); // simulate a server restart — state must reload from rows
  await recordNetworkObservation(SID_A, capIps[0]!, "integrity_batch");
  rows = await readEvents(SID_A);
  const change3 = rows.filter((r) => r.type === "integrity.ip_change").at(-1);
  check("after restart, change_count continues from persisted rows (3)",
    change3?.payload["change_count"] === 3, JSON.stringify(change3?.payload));
  check("unknown-geo change is conservatively country_changed=false",
    change3?.payload["country_changed"] === false && change3?.payload["new_country"] === null);

  for (const ip of capIps.slice(1)) {
    await recordNetworkObservation(SID_A, ip, "integrity_batch");
  }
  rows = await readEvents(SID_A);
  const changes = rows.filter((r) => r.type === "integrity.ip_change");
  check(`ip_change events capped at ${IP_CHANGE_EVENT_CAP} despite ${capIps.length + 2} distinct IPs`,
    changes.length === IP_CHANGE_EVENT_CAP, `changes=${changes.length}`);
  check("still exactly one integrity.geo",
    rows.filter((r) => r.type === "integrity.geo").length === 1);
  check("every geo/ip_change row is system-authored", rows.every((r) => r.actor === "system"));

  const serializedRows = JSON.stringify(rows);
  const leaked = ALL_IPS.filter((ip) => serializedRows.includes(ip));
  check("PRIVACY: no raw IP literal in any event row", leaked.length === 0, leaked.join(","));

  // ── [c] suspicion detector v3 over the persisted rows (hand-computed) ────
  console.log("\n[c] suspicion factors (detector v3)");
  const suspicionInput = rows as unknown as SuspicionEventInput[];
  const expectedCountryChanges = changes.filter((c) => c.payload["country_changed"] === true).length;
  const s = computeSuspicionScore(suspicionInput);
  check("suspicion version is 3", s.version === "3", s.version);
  const fIp = s.factors.find((f) => f.kind === "ip_change");
  const fCc = s.factors.find((f) => f.kind === "country_change");
  check(`ip_change factor: count 10 → contribution capped at ${SUSPICION_WEIGHTS.ip_change.cap}`,
    fIp?.count === 10 && fIp.contribution === SUSPICION_WEIGHTS.ip_change.cap, JSON.stringify(fIp));
  check(`country_change factor: count ${expectedCountryChanges}, contribution min(count*15, 30)`,
    fCc?.count === expectedCountryChanges &&
    fCc.contribution === Math.min(expectedCountryChanges * SUSPICION_WEIGHTS.country_change.weight, SUSPICION_WEIGHTS.country_change.cap),
    JSON.stringify(fCc));
  check("no geo_tz_mismatch without a client_env event",
    !s.factors.some((f) => f.kind === "geo_tz_mismatch"));
  const handScore = Math.min(100, s.factors.reduce((t, f) => t + f.contribution, 0));
  check("score equals hand-computed factor sum (under clamp)", s.score === handScore,
    `score=${s.score} sum=${handScore}`);
  check("computeNetworkSummary returns null for a pre-slice event stream",
    computeNetworkSummary([]) === null);

  // ── [d] ingest route — server-authored types 400, client_env accepted ────
  console.log("\n[d] ingest route (in-process inject)");
  // Minimal fake registry entry — only the fields the route + logEvent +
  // flushTelemetry touch. SID_B is live in the registry, so logEvent buffers
  // on this entry and flushTelemetry drains it to Supabase.
  const fakeEntry = {
    status: "active", nextSeq: 0, eventBuffer: [], flushTimer: null,
    ptyOutputBuffer: [], ptyInputBuffer: [], ptyOutputFlushTimer: null,
    ptyInputFlushTimer: null, ptyOutputBytes: 0, ptyInputBytes: 0,
    lastFileHashes: new Map<string, string>(),
  } as unknown as SessionEntry;
  sessionRegistry.set(SID_B, fakeEntry);
  const token = signToken(SID_B, Date.now() + 60 * 60 * 1000);
  const app = Fastify();
  await app.register(integrityRoutes);
  const post = (events: unknown[]) =>
    app.inject({
      method: "POST",
      url: `/sessions/${SID_B}/integrity`,
      headers: { authorization: `Bearer ${token}` },
      payload: { events },
    });

  const spoofGeo = await post([
    { type: "integrity.geo", payload: { country: "US", region: null, city: null, ip_hash: "deadbeefdeadbeef" } },
  ]);
  check("client-posted integrity.geo → 400", spoofGeo.statusCode === 400, `status=${spoofGeo.statusCode}`);
  check("…with the explicit server_authored error",
    (spoofGeo.json() as { error?: string }).error === "server_authored_integrity_type", spoofGeo.body);
  const spoofChange = await post([
    { type: "integrity.tab_blur" },
    { type: "integrity.ip_change", payload: { change_count: 1, prev_ip_hash: "a", new_ip_hash: "b", country_changed: true, new_country: "RU" } },
  ]);
  check("client-posted integrity.ip_change (even mid-batch) → 400", spoofChange.statusCode === 400);
  const badEnv = await post([{ type: "integrity.client_env", payload: { tz_offset_minutes: 1.5, tz_name: "Europe/London" } }]);
  check("malformed client_env → 400 (Zod)", badEnv.statusCode === 400);
  const goodEnv = await post([{ type: "integrity.client_env", ts: Date.now(), payload: { tz_offset_minutes: -330, tz_name: "Asia/Kolkata" } }]);
  check("valid client_env accepted", goodEnv.statusCode === 200 &&
    (goodEnv.json() as { accepted?: number }).accepted === 1, goodEnv.body);

  // Each authenticated POST is also a network observation. Inject uses
  // 127.0.0.1 → geoip null → a geo marker with null fields but a real hash.
  await recordNetworkObservation(SID_B, "127.0.0.1", "integrity_batch"); // awaits the serialized chain tail
  await flushTelemetry(SID_B);
  const rowsB = await readEvents(SID_B);
  const geoB = rowsB.filter((r) => r.type === "integrity.geo");
  check("ingest POSTs recorded exactly one network observation (integrity.geo, unresolvable ip → nulls)",
    geoB.length === 1 && geoB[0]?.payload["country"] === null &&
    geoB[0]?.payload["ip_hash"] === hashSessionIp(SID_B, "127.0.0.1"),
    JSON.stringify(geoB.map((r) => r.payload)));
  check("accepted client_env persisted with candidate actor",
    rowsB.some((r) => r.type === "integrity.client_env" && r.actor === "candidate" &&
      r.payload["tz_name"] === "Asia/Kolkata"));
  check("PRIVACY: no raw IP literal in SID_B rows either",
    !JSON.stringify(rowsB).includes("127.0.0.1"));
  sessionRegistry.delete(SID_B);
  await app.close();

  // ── [e] review suspicion endpoint — recruiter-only network block ─────────
  console.log("\n[e] review endpoint network block");
  const reviewApp = Fastify();
  await reviewApp.register(reviewRoutes, { prefix: "/api/review" });
  const suspRes = await reviewApp.inject({ method: "GET", url: `/api/review/sessions/${SID_A}/suspicion` });
  check("suspicion endpoint 200", suspRes.statusCode === 200, `status=${suspRes.statusCode}`);
  const suspBody = suspRes.json() as {
    suspicion?: { version?: string };
    network?: {
      country?: unknown; region?: unknown; city?: unknown;
      ip_changes?: unknown; countries?: unknown; tz_mismatch?: unknown;
    } | null;
  };
  const net = suspBody.network;
  check("network block present", net !== null && typeof net === "object", JSON.stringify(suspBody.network));
  check("network.country = first observed country",
    net?.country === (expectGeo1?.country || null), JSON.stringify(net));
  check("network.ip_changes = 10", net?.ip_changes === 10);
  const expectedCountries = [expectGeo1?.country, expectGeo2?.country, geoip.lookup(IP3)?.country]
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .filter((c, i, a) => a.indexOf(c) === i);
  const gotCountries = net && Array.isArray(net.countries) ? net.countries : null;
  check("network.countries lists the distinct countries in first-seen order",
    gotCountries !== null && JSON.stringify(gotCountries) === JSON.stringify(expectedCountries),
    JSON.stringify(gotCountries));
  check("network.tz_mismatch=false (SID_A has no client_env)", net?.tz_mismatch === false);
  check("shape has exactly the agreed keys",
    JSON.stringify(Object.keys(net ?? {}).sort()) ===
    JSON.stringify(["city", "countries", "country", "ip_changes", "region", "tz_mismatch"]));
  check("reported detector version is 3", suspBody.suspicion?.version === "3");
  await reviewApp.close();

  // ── [f] public shared report — zero geo/network material ─────────────────
  console.log("\n[f] shared report exclusion");
  try {
    const report = await buildSharedReport(SID_A, "2030-01-01T00:00:00.000Z");
    const serialized = JSON.stringify(report);
    const forbidden = [
      ...ALL_IPS,
      hashSessionIp(SID_A, IP1), hashSessionIp(SID_A, IP2), hashSessionIp(SID_A, IP3),
      "ip_hash", "ip_change", "new_country", "country_changed", "tz_name",
      "tz_mismatch", "ip_changes", "integrity.geo", "client_env", "network",
    ];
    const leakedReport = forbidden.filter((f) => serialized.includes(f));
    check("serialized shared report contains NO geo/network material",
      leakedReport.length === 0, leakedReport.join(","));
    check("shared report still carries score+version only",
      typeof report.suspicion.score === "number" && report.suspicion.version === "3");
  } catch (err) {
    fail(`buildSharedReport threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n[cleanup]");
  await cleanup();
  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
