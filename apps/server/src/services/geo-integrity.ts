// Geo/network integrity observations — recruiter-only, informational.
//
// recordNetworkObservation() is called with the connecting IP at session
// creation (routes/sessions.ts) and on every integrity-batch POST
// (routes/integrity.ts). It derives:
//
//   - coarse geo (country ONLY) via the `maxmind` reader over a vendored
//     GeoLite2-Country mmdb (apps/server/data/, ~9MB) — an in-process lookup,
//     NO external calls, so no IP ever leaves this process. The integrity.geo
//     payload keeps its {country, region, city, ip_hash} shape for stability,
//     but region/city are now ALWAYS null: we deliberately ship the
//     country-only database (~9MB disk / ~9MB RSS) instead of the city one
//     (geoip-lite was ~110MB disk / 60-120MB RSS), because nothing downstream
//     uses sub-country precision — the suspicion factors and network summary
//     only ever compare countries.
//   - an "ip identity": sha256(sessionId + ip) truncated to 16 hex chars. The
//     sessionId acts as a per-session salt, so the same IP hashes differently
//     in different sessions — cross-session correlation is impossible and the
//     hash can't be reversed to the /24 by brute force without the session id.
//
// DERIVED VALUES ONLY leave this module. The raw IP is NEVER persisted,
// NEVER put in an event payload, and NEVER logged (error paths log the
// session id + source, not the address).
//
// Events appended (actor "system", via events-direct so they work for both
// live-registry and direct-DB sessions):
//   - integrity.geo        — ONCE, on the first observation:
//                            {country, region, city, ip_hash}
//   - integrity.ip_change  — on each observation whose ip hash differs from
//                            the previous one: {change_count, prev_ip_hash,
//                            new_ip_hash, country_changed, new_country}.
//                            Capped at IP_CHANGE_EVENT_CAP per session.
//
// State is derived from the session's own integrity.geo / integrity.ip_change
// event rows (memoized in-process), so it survives server restarts. Every
// failure is swallowed + logged: this channel must never break the candidate
// flow. Same isolation posture as all integrity.*: informational for the
// recruiter, NEVER feeds evidence/evaluations.

import { createHash } from "crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import maxmind, { type CountryResponse, type Reader } from "maxmind";
import { appendEvent } from "./events-direct.js";
import { supabase } from "./supabase.js";

// ── Country lookup (vendored GeoLite2-Country mmdb) ─────────────────────────
// Resolved relative to this module so it works from both src/ (tsx) and dist/
// (tsc build): {src|dist}/services → ../../data. Same pattern as
// dataset-seed.ts's REPO_ROOT resolver.
const here = dirname(fileURLToPath(import.meta.url));
const MMDB_PATH = resolve(here, "../../data/GeoLite2-Country.mmdb");

// Lazy-opened once, shared across all observations. `null` after a failed
// open ⇒ we retry on the next observation rather than caching the failure
// forever (the file could appear after a deploy fix).
let readerPromise: Promise<Reader<CountryResponse>> | null = null;

function getReader(): Promise<Reader<CountryResponse>> {
  if (readerPromise === null) {
    readerPromise = maxmind.open<CountryResponse>(MMDB_PATH);
    readerPromise.catch(() => { readerPromise = null; });
  }
  return readerPromise;
}

/** Country ISO code for an IP, or null when unresolvable (private/unroutable
 *  addresses, gaps in the DB). Falls back to registered_country when the
 *  located country is absent (e.g. 1.1.1.1 carries only AU registration) —
 *  matching geoip-lite's previous behavior. Throws only if the mmdb itself
 *  can't be opened; callers treat that as "observation failed" (logged,
 *  session unaffected). */
async function lookupCountry(ip: string): Promise<string | null> {
  const reader = await getReader();
  const hit = reader.get(ip);
  return hit?.country?.iso_code ?? hit?.registered_country?.iso_code ?? null;
}

/** Stop appending integrity.ip_change after this many per session — a
 *  rotating-proxy client can't grow the events table unboundedly. (The
 *  suspicion factor caps at 3 changes anyway; reviewers see "10+" as the
 *  degenerate case.) */
export const IP_CHANGE_EVENT_CAP = 10;

export type NetworkObservationSource = "session_create" | "integrity_batch";

/** Per-session-salted ip identity: sha256(sessionId + ip), first 16 hex. */
export function hashSessionIp(sessionId: string, ip: string): string {
  return createHash("sha256").update(sessionId + ip).digest("hex").slice(0, 16);
}

interface NetState {
  hasGeo: boolean;            // integrity.geo already appended?
  lastHash: string | null;    // ip hash of the most recent observation
  lastCountry: string | null; // country of the most recent observation (null = unknown)
  changeCount: number;        // integrity.ip_change events appended so far
}

// sessionId → derived state. Sessions are bounded per process; the cache is
// pruned FIFO past a generous ceiling so a long-lived process can't leak.
const stateCache = new Map<string, NetState>();
const STATE_CACHE_MAX = 2000;

// sessionId → tail of the in-flight observation chain. Observations for one
// session are serialized so a session-create + first-batch race can't append
// integrity.geo twice.
const chains = new Map<string, Promise<void>>();

/** Test/lifecycle helper — forget derived state so the next observation
 *  reloads it from the event rows (simulates a server restart). */
export function resetGeoIntegrityState(sessionId?: string): void {
  if (sessionId) stateCache.delete(sessionId);
  else stateCache.clear();
}

/** Rebuild NetState from the session's own event rows — the restart path. */
async function loadStateFromEvents(sessionId: string): Promise<NetState> {
  const state: NetState = { hasGeo: false, lastHash: null, lastCountry: null, changeCount: 0 };
  if (!supabase) return state; // no persistence → behave as a fresh session
  const { data, error } = await supabase
    .from("events")
    .select("seq, type, payload")
    .eq("session_id", sessionId)
    .in("type", ["integrity.geo", "integrity.ip_change"])
    .order("seq", { ascending: true })
    .limit(IP_CHANGE_EVENT_CAP + 2);
  if (error) throw new Error(`geo-state read failed: ${error.message}`);
  for (const row of (data ?? []) as Array<{ type: string; payload: Record<string, unknown> | null }>) {
    const p = row.payload ?? {};
    if (row.type === "integrity.geo") {
      state.hasGeo = true;
      state.lastHash = typeof p["ip_hash"] === "string" ? p["ip_hash"] : null;
      state.lastCountry = typeof p["country"] === "string" ? p["country"] : null;
    } else {
      state.changeCount++;
      state.lastHash = typeof p["new_ip_hash"] === "string" ? p["new_ip_hash"] : state.lastHash;
      state.lastCountry = typeof p["new_country"] === "string" ? p["new_country"] : null;
    }
  }
  return state;
}

async function observe(sessionId: string, ip: string, _source: NetworkObservationSource): Promise<void> {
  const ipHash = hashSessionIp(sessionId, ip);

  let state = stateCache.get(sessionId);
  if (!state) {
    state = await loadStateFromEvents(sessionId);
    if (stateCache.size >= STATE_CACHE_MAX) {
      // FIFO prune — Map iterates in insertion order.
      const oldest = stateCache.keys().next().value;
      if (oldest !== undefined) stateCache.delete(oldest);
    }
    stateCache.set(sessionId, state);
  }

  // Common case: same address as last time — nothing to record.
  if (state.hasGeo && state.lastHash === ipHash) return;

  // Unresolvable addresses (localhost, LAN, DB gaps) → country null, same
  // conservative semantics as before. A reader-open failure throws here and
  // the observation is skipped + logged by the chain's catch — never breaks
  // the candidate flow.
  const country = await lookupCountry(ip);

  if (!state.hasGeo) {
    // First observation → the one-time integrity.geo marker. Appended even
    // when the lookup came back empty: the ip_hash still anchors ip-change
    // detection for the rest of the session. region/city are permanently
    // null — country-only DB (see header).
    await appendEvent(sessionId, "integrity.geo", "system", {
      country,
      region: null,
      city: null,
      ip_hash: ipHash,
    });
    state.hasGeo = true;
    state.lastHash = ipHash;
    state.lastCountry = country;
    return;
  }

  if (state.lastHash === null) {
    // Defensive: a malformed prior geo row left us without an anchor hash.
    // Adopt this observation as the anchor rather than fabricating a change.
    state.lastHash = ipHash;
    state.lastCountry = country;
    return;
  }

  // Different ip hash → an ip change. country_changed is CONSERVATIVE: only
  // true when both the previous and new country are known and differ — an
  // unknown lookup never counts as a country change.
  const changed = country !== null && state.lastCountry !== null && country !== state.lastCountry;
  const prevHash = state.lastHash;
  const underCap = state.changeCount < IP_CHANGE_EVENT_CAP;
  // Track state even past the cap so post-cap flip-flops don't distort what
  // "previous" means if the cap were ever raised mid-session.
  state.lastHash = ipHash;
  state.lastCountry = country;
  if (!underCap) return;
  state.changeCount++;
  await appendEvent(sessionId, "integrity.ip_change", "system", {
    change_count: state.changeCount,
    prev_ip_hash: prevHash,
    new_ip_hash: ipHash,
    country_changed: changed,
    new_country: country,
  });
}

/**
 * Record one network observation for a session. Fire-and-forget safe: never
 * rejects, never throws, never logs the raw IP. Observations for the same
 * session are serialized (see `chains`).
 */
export function recordNetworkObservation(
  sessionId: string,
  ip: string | undefined,
  source: NetworkObservationSource,
): Promise<void> {
  if (!ip || typeof ip !== "string") return Promise.resolve();
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(
    () => observe(sessionId, ip, source),
  ).catch((err) => {
    // NEVER include the ip in this log line.
    console.error(
      `[geo-integrity] observation failed (session=${sessionId} source=${source}):`,
      err instanceof Error ? err.message : err,
    );
  });
  chains.set(sessionId, next);
  void next.then(() => {
    if (chains.get(sessionId) === next) chains.delete(sessionId);
  });
  return next;
}
