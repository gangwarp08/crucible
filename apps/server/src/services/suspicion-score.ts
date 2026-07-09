// P1.2 — deterministic suspicion score over integrity.* events.
//
// Aggregates the browser-reported integrity channel (integrity.tab_blur,
// integrity.paste_burst, …) into a 0–100 Suspicion Score plus the weighted
// factors that produced it. Pure function, no I/O — same pattern as
// scorability.ts — so it's recomputable on demand over the durable event
// stream and directly testable by verify-suspicion-score.ts.
//
// ISOLATION (spec P1, critical): this score is an INFORMATIONAL recruiter
// signal only. It reads integrity.* events exclusively and MUST NOT feed
// evidence_units, evaluations, or any competency score. The mirror-image
// guard lives in evidence-extractor.ts (integrity.* is hard-filtered out of
// detector input).

/** Bump when weights/thresholds/factor logic change so stored or displayed
 *  scores can be told apart across versions.
 *  "1" → "2": P6.3 added the webcam-presence factors face_absent /
 *  multiple_faces. Inert for every v1 session (those events cannot exist
 *  without recorded v2 consent), but a v2 session's score is not comparable
 *  to a v1 score, hence the bump. NOTE: this is the SUSPICION detector
 *  version — a separate namespace from the evidence DETECTOR_VERSION; P6
 *  touches no competency-scoring version.
 *  "2" → "3": geo/network slice added the ip_change, country_change and
 *  geo_tz_mismatch factors over the new server-authored integrity.geo /
 *  integrity.ip_change events and the client's integrity.client_env timezone
 *  snapshot. Inert for every pre-slice session (those events don't exist), but
 *  scores across the boundary are not comparable, hence the bump. */
export const SUSPICION_DETECTOR_VERSION = "3";

export interface SuspicionFactor {
  kind: string;
  /** How many qualifying occurrences were observed. */
  count: number;
  /** Points per occurrence. */
  weight: number;
  /** min(count * weight, cap) — the points this factor added to the score. */
  contribution: number;
}

export interface SuspicionScore {
  /** 0–100; min(100, sum of factor contributions). */
  score: number;
  factors: SuspicionFactor[];
  version: string;
}

/** Minimal event shape — matches the events-table row subset the review
 *  route selects (seq, type, ts, payload). */
export interface SuspicionEventInput {
  seq: number;
  type: string;
  /** ISO 8601 timestamp (events.ts). */
  ts: string;
  payload: Record<string, unknown> | null;
}

// ── Weights & thresholds ────────────────────────────────────────────────────
// CALIBRATION-PENDING defaults (spec P1 open question): proposed for cohort 1,
// expected to be tuned once real cohort data exists. Each factor contributes
// min(count * weight, cap); the total is clamped to 100.
export const SUSPICION_WEIGHTS = {
  blur:            { weight: 8,  cap: 40 }, // tab_blur + window_blur count
  paste_burst:     { weight: 12, cap: 36 }, // paste_burst with chars > PASTE_CHARS_THRESHOLD
  idle_gap:        { weight: 5,  cap: 20 }, // idle_gap with ms > IDLE_MS_THRESHOLD
  devtools:        { weight: 15, cap: 30 }, // best-effort signal — deliberately capped low-ish
  copy_source:     { weight: 6,  cap: 24 }, // copy from brief/docs (candidate exfiltrating prompt material)
  fullscreen_exit: { weight: 4,  cap: 12 },
  focus_flurry:    { weight: 10, cap: 20 }, // >=5 blur/focus pairs inside 60s (tab-cycling)
  rate_capped:     { weight: 10, cap: 20 }, // server-authored ingest-cap marker — flooding raises suspicion, not hides it
  // P6.3 webcam-presence factors (consented v2 sessions only — the events
  // cannot exist otherwise). Same posture as everything here: informational,
  // recruiter-only, never touches the competency score.
  face_absent:     { weight: 6,  cap: 24 }, // nobody visible for a sustained stretch
  multiple_faces:  { weight: 12, cap: 36 }, // >=2 faces — someone else in frame
  // Geo/network factors (detector v3) — server-authored integrity.geo /
  // integrity.ip_change plus the client's integrity.client_env timezone
  // snapshot. Same posture as everything here: informational, recruiter-only,
  // never touches the competency score.
  ip_change:       { weight: 10, cap: 30 }, // per integrity.ip_change event (session hopped addresses)
  country_change:  { weight: 15, cap: 30 }, // per ip_change with country_changed=true (crossed a border mid-session)
  geo_tz_mismatch: { weight: 8,  cap: 8  }, // browser timezone confidently contradicts the IP country (fires at most once)
} as const;

export const PASTE_CHARS_THRESHOLD = 500;
export const IDLE_MS_THRESHOLD = 120_000;
export const FLURRY_PAIRS = 5;
export const FLURRY_WINDOW_MS = 60_000;

// ── Timezone → country (geo_tz_mismatch, detector v3) ──────────────────────
// DELIBERATELY CONSERVATIVE map of major IANA zones to their ISO-3166 alpha-2
// country (matching geoip-lite's `country`). Known limits, all resolved in
// favor of NOT flagging:
//   - coverage is a curated shortlist of high-population zones, not the full
//     tzdb — an unlisted zone (e.g. Europe/Podgorica) produces NO factor;
//   - zones plausibly used across borders or that carry no country signal
//     (UTC, Etc/*, GMT offsets) are excluded on purpose;
//   - VPN exit vs. real location is indistinguishable at this layer — which
//     is exactly why the factor is worth only 8 points, capped at one firing,
//     informational-never-scored like the whole channel.
// The mismatch NEVER fires on missing data: it needs a known IP country AND a
// mapped browser timezone that confidently disagrees.
const TZ_COUNTRY: Record<string, string> = {
  // United States
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US",
  "America/Los_Angeles": "US", "America/Phoenix": "US", "America/Detroit": "US",
  "America/Anchorage": "US", "Pacific/Honolulu": "US",
  // Canada
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA",
  "America/Winnipeg": "CA", "America/Halifax": "CA", "America/Montreal": "CA",
  // Latin America
  "America/Mexico_City": "MX", "America/Sao_Paulo": "BR",
  "America/Argentina/Buenos_Aires": "AR", "America/Bogota": "CO",
  "America/Santiago": "CL", "America/Lima": "PE",
  // Europe
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR",
  "Europe/Berlin": "DE", "Europe/Madrid": "ES", "Europe/Rome": "IT",
  "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Zurich": "CH",
  "Europe/Vienna": "AT", "Europe/Lisbon": "PT", "Europe/Warsaw": "PL",
  "Europe/Prague": "CZ", "Europe/Budapest": "HU", "Europe/Bucharest": "RO",
  "Europe/Athens": "GR", "Europe/Stockholm": "SE", "Europe/Oslo": "NO",
  "Europe/Copenhagen": "DK", "Europe/Helsinki": "FI", "Europe/Istanbul": "TR",
  "Europe/Kyiv": "UA", "Europe/Kiev": "UA", "Europe/Moscow": "RU",
  // Middle East / Africa
  "Asia/Jerusalem": "IL", "Asia/Dubai": "AE", "Asia/Riyadh": "SA",
  "Africa/Cairo": "EG", "Africa/Lagos": "NG", "Africa/Nairobi": "KE",
  "Africa/Johannesburg": "ZA",
  // Asia-Pacific
  "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Karachi": "PK",
  "Asia/Dhaka": "BD", "Asia/Shanghai": "CN", "Asia/Tokyo": "JP",
  "Asia/Seoul": "KR", "Asia/Singapore": "SG", "Asia/Hong_Kong": "HK",
  "Asia/Taipei": "TW", "Asia/Manila": "PH", "Asia/Jakarta": "ID",
  "Asia/Bangkok": "TH", "Asia/Ho_Chi_Minh": "VN",
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU",
  "Australia/Brisbane": "AU", "Australia/Perth": "AU", "Australia/Adelaide": "AU",
  "Pacific/Auckland": "NZ",
};

/** Country for an IANA timezone name, or null when the map doesn't cover it
 *  (which downstream treats as "uncertain — do not flag"). */
export function countryForTimezone(tzName: string): string | null {
  return TZ_COUNTRY[tzName] ?? null;
}

function factor(kind: keyof typeof SUSPICION_WEIGHTS, count: number): SuspicionFactor {
  const { weight, cap } = SUSPICION_WEIGHTS[kind];
  return { kind, count, weight, contribution: Math.min(count * weight, cap) };
}

/** Count focus-flurries: greedy scan over blur timestamps (ms); every run of
 *  FLURRY_PAIRS blur→focus pairs inside FLURRY_WINDOW_MS counts once. */
function countFlurries(pairTimesMs: number[]): number {
  let flurries = 0;
  let i = 0;
  while (i + FLURRY_PAIRS - 1 < pairTimesMs.length) {
    if (pairTimesMs[i + FLURRY_PAIRS - 1]! - pairTimesMs[i]! <= FLURRY_WINDOW_MS) {
      flurries++;
      i += FLURRY_PAIRS; // consume the pairs of this flurry
    } else {
      i++;
    }
  }
  return flurries;
}

/**
 * Deterministic 0–100 suspicion score. Ignores every non-integrity event, so
 * callers can feed the whole event stream. Factors with zero occurrences are
 * omitted; sum of contributions === score whenever the sum is under the
 * 100-point clamp.
 */
export function computeSuspicionScore(events: SuspicionEventInput[]): SuspicionScore {
  const integrity = events
    .filter((e) => typeof e.type === "string" && e.type.startsWith("integrity."))
    .slice()
    .sort((a, b) => a.seq - b.seq);

  let blurCount = 0;
  let pasteCount = 0;
  let idleCount = 0;
  let devtoolsCount = 0;
  let copyCount = 0;
  let fullscreenCount = 0;
  let rateCappedCount = 0;
  let faceAbsentCount = 0;
  let multipleFacesCount = 0;
  let ipChangeCount = 0;
  let countryChangeCount = 0;
  // geo_tz_mismatch inputs (detector v3): first recorded IP country + first
  // browser-reported IANA timezone. Both are needed; missing either → no factor.
  let geoCountry: string | null = null;
  let clientTzName: string | null = null;

  // blur→focus pairing for the flurry factor: a tab_blur "opens" a pair, the
  // next tab_focus closes it. Pair time = the blur's timestamp.
  const pairTimesMs: number[] = [];
  let openBlurMs: number | null = null;

  for (const e of integrity) {
    const p = e.payload ?? {};
    switch (e.type) {
      case "integrity.tab_blur": {
        blurCount++;
        const t = Date.parse(e.ts);
        openBlurMs = Number.isFinite(t) ? t : null;
        break;
      }
      case "integrity.window_blur":
        blurCount++;
        break;
      case "integrity.tab_focus":
        if (openBlurMs !== null) {
          pairTimesMs.push(openBlurMs);
          openBlurMs = null;
        }
        break;
      case "integrity.paste_burst":
        if (typeof p["chars"] === "number" && p["chars"] > PASTE_CHARS_THRESHOLD) pasteCount++;
        break;
      case "integrity.idle_gap":
        if (typeof p["ms"] === "number" && p["ms"] > IDLE_MS_THRESHOLD) idleCount++;
        break;
      case "integrity.devtools":
        devtoolsCount++;
        break;
      case "integrity.copy":
        if (p["source"] === "brief" || p["source"] === "docs") copyCount++;
        break;
      case "integrity.fullscreen_exit":
        fullscreenCount++;
        break;
      case "integrity.rate_capped":
        rateCappedCount++; // server-authored (one per capped minute window)
        break;
      // P6.3 — signal-only occurrences (the browser heuristic debounces to at
      // most one emission per sustained episode; payloads, when present, are
      // informational and don't gate the count).
      case "integrity.face_absent":
        faceAbsentCount++;
        break;
      case "integrity.multiple_faces":
        multipleFacesCount++;
        break;
      // Geo/network slice (detector v3). integrity.geo / integrity.ip_change
      // are SERVER-authored (services/geo-integrity.ts — derived values only);
      // integrity.client_env is the browser's own timezone snapshot.
      case "integrity.geo":
        if (geoCountry === null && typeof p["country"] === "string") geoCountry = p["country"];
        break;
      case "integrity.ip_change":
        ipChangeCount++;
        if (p["country_changed"] === true) countryChangeCount++;
        break;
      case "integrity.client_env":
        if (clientTzName === null && typeof p["tz_name"] === "string") clientTzName = p["tz_name"];
        break;
      default:
        break; // unknown integrity.* subtype — contributes nothing
    }
  }

  // geo_tz_mismatch: fires (once) ONLY when the IP country is known, the
  // browser timezone maps to a country in the conservative TZ_COUNTRY table,
  // and the two confidently disagree. Missing/unmapped data never flags.
  const tzCountry = clientTzName !== null ? countryForTimezone(clientTzName) : null;
  const tzMismatch = geoCountry !== null && tzCountry !== null && tzCountry !== geoCountry;

  const all: SuspicionFactor[] = [
    factor("blur", blurCount),
    factor("paste_burst", pasteCount),
    factor("idle_gap", idleCount),
    factor("devtools", devtoolsCount),
    factor("copy_source", copyCount),
    factor("fullscreen_exit", fullscreenCount),
    factor("focus_flurry", countFlurries(pairTimesMs)),
    factor("rate_capped", rateCappedCount),
    factor("face_absent", faceAbsentCount),
    factor("multiple_faces", multipleFacesCount),
    factor("ip_change", ipChangeCount),
    factor("country_change", countryChangeCount),
    factor("geo_tz_mismatch", tzMismatch ? 1 : 0),
  ];
  const factors = all.filter((f) => f.count > 0);
  const score = Math.min(100, factors.reduce((s, f) => s + f.contribution, 0));

  return { score, factors, version: SUSPICION_DETECTOR_VERSION };
}

// ── Network summary (geo/network slice — review surface) ───────────────────

/** RECRUITER-ONLY network block for the review suspicion endpoint. Derived
 *  values only — coarse geo strings, counts, and a boolean; ip hashes stay in
 *  the raw event rows. Must NEVER reach the public shared report (the
 *  shared-report allowlist has no network field; verify-geo-integrity.ts
 *  asserts it). */
export interface NetworkSummary {
  /** Geo of the FIRST observed address (session start). */
  country: string | null;
  region: string | null;
  city: string | null;
  /** integrity.ip_change events recorded (capped server-side at 10). */
  ip_changes: number;
  /** Distinct countries observed across the session, in first-seen order. */
  countries: string[];
  /** Browser timezone confidently contradicts the IP country (same
   *  conservative rule as the geo_tz_mismatch factor). */
  tz_mismatch: boolean;
}

/**
 * Pure derivation of the review-surface network block from a session's event
 * stream. Returns null when the session predates the geo/network slice (no
 * integrity.geo / integrity.ip_change rows) so the panel can stay invisible.
 */
export function computeNetworkSummary(events: SuspicionEventInput[]): NetworkSummary | null {
  const sorted = events
    .filter((e) => typeof e.type === "string" && e.type.startsWith("integrity."))
    .slice()
    .sort((a, b) => a.seq - b.seq);

  let geo: { country: string | null; region: string | null; city: string | null } | null = null;
  let ipChanges = 0;
  const countries: string[] = [];
  let clientTzName: string | null = null;
  const seeCountry = (c: unknown): void => {
    if (typeof c === "string" && c.length > 0 && !countries.includes(c)) countries.push(c);
  };

  for (const e of sorted) {
    const p = e.payload ?? {};
    if (e.type === "integrity.geo") {
      if (geo === null) {
        geo = {
          country: typeof p["country"] === "string" ? p["country"] : null,
          region: typeof p["region"] === "string" ? p["region"] : null,
          city: typeof p["city"] === "string" ? p["city"] : null,
        };
      }
      seeCountry(p["country"]);
    } else if (e.type === "integrity.ip_change") {
      ipChanges++;
      seeCountry(p["new_country"]);
    } else if (e.type === "integrity.client_env") {
      if (clientTzName === null && typeof p["tz_name"] === "string") clientTzName = p["tz_name"];
    }
  }

  if (geo === null && ipChanges === 0) return null; // pre-slice session

  const tzCountry = clientTzName !== null ? countryForTimezone(clientTzName) : null;
  return {
    country: geo?.country ?? null,
    region: geo?.region ?? null,
    city: geo?.city ?? null,
    ip_changes: ipChanges,
    countries,
    tz_mismatch: geo?.country != null && tzCountry !== null && tzCountry !== geo.country,
  };
}
