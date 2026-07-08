// Deterministic synthetic dataset generator for the fde-api-integration-iso
// ISOMORPH (family 2, P3.1 — seeded DORMANT by migration 0023).
//
// Same RADICAL structure as fde-api-integration (cursor-pagination contract
// drift + non-idempotent retry, 401 red herring, native hardcode-workaround
// product-sense fork) but a DIFFERENT seed → different INCIDENTAL values
// (contact counts, page size, which pages are skipped). Used by
// verify-family2-isomorph.ts.
//
// Radical task structure (shared by every isomorph of the family):
//   A nightly CRM-contacts sync against a third-party provider quietly drops
//   records. Root cause: the provider's /contacts endpoint moved from offset
//   to CURSOR pagination (contract drift) and the client's retry wrapper is
//   non-idempotent — on a retry it re-sends a stale cursor, so one page is
//   fetched twice and its successor page silently skipped. Red herrings: a
//   handful of 401s (token expiry — every one retried successfully) and the
//   429s that trigger the buggy retries.
//
// Content contract (scripts/family2-content.ts):
//   api_requests(id, endpoint, method, status_code, cursor, next_cursor,
//                retry_of, requested_at)
//   provider_contacts(external_id, name, email, updated_at)
//   local_contacts(id, external_id, name, email, updated_at)
//   ground_truth.json ⊇ { provider_record_count, synced_record_count,
//                         missing_record_count, edge_case_record_count,
//                         root_cause }
//
// Run: pnpm exec tsx fixtures/fde-api-integration-iso/generate.ts
//
// Writes (overwrites) into this directory:
//   schema.sql        — runs in SQLite (sandbox customer.db) via executescript
//   seed.sql          — INSERT statements, byte-identical on re-run
//   ground_truth.json — provider/synced/missing counts + root cause
//   queries.sql       — the discriminator SQL (mirrors family2-content.ts)
//
// All randomness flows through a single mulberry32 PRNG seeded from a FNV-1a
// hash of the SEED_LABEL — re-running yields byte-identical output. Date
// arithmetic uses fixed reference timestamps (no `new Date()`), so the files
// do not drift with the wall clock.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Variant config (the ONLY block that differs between isomorphs) ─────────

const SEED_LABEL = "fde-api-integration-iso-v1";
const COMPANY = "Solstice Retail";
const PROVIDER = "ContactHub";
const TARGET_CONTACTS = 6100;   // provider-side contact count (± jitter)
const PAGE_SIZE = 50;           // provider page size for /v2/contacts
const SKIP_INCIDENT_COUNT = 7;  // stale-cursor retries → pages silently skipped
const AUTH_401_COUNT = 4;       // expired-token 401s (red herring — all retried OK)
const AUTH_DROP_COUNT = 0;      // pro-only: 401s whose retry ALSO fails (pages lost)
const SYNC_RUN_AT = "2026-06-12 02:00:00"; // nightly full-sync run (UTC)
const CONTACT_WINDOW_START = "2025-06-12T00:00:00Z";
const CONTACT_WINDOW_END = "2026-06-11T23:59:59Z";
const ROOT_CAUSE = "cursor_pagination_contract_drift";

// ─── Determinism primitives ─────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(fnv1a(SEED_LABEL));

function rngInt(min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

function rngPick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// ─── Time helpers (fixed reference — no wall clock) ─────────────────────────

const WINDOW_START_MS = Date.parse(CONTACT_WINDOW_START);
const WINDOW_END_MS = Date.parse(CONTACT_WINDOW_END);

function fmtUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

// ─── Contacts (the provider export — source of truth) ───────────────────────

const FIRST = [
  "Ava", "Liam", "Maya", "Noah", "Iris", "Owen", "Zara", "Eli", "Nora", "Kai",
  "Lena", "Theo", "Ruth", "Jude", "Esme", "Axel", "Faye", "Hugo", "Isla", "Milo",
  "Rhea", "Silas", "Tessa", "Victor", "Wren", "Yusuf", "Amara", "Bodhi", "Celia", "Darius",
  "Elena", "Felix", "Greta", "Harvey", "Imani", "Jonas", "Keira", "Lucas", "Mona", "Nikhil",
] as const;
const LAST = [
  "Alvarez", "Bennett", "Castillo", "Delacroix", "Eastman", "Fitzgerald", "Gagnon", "Hollis",
  "Ibrahim", "Jorgensen", "Kapoor", "Lindqvist", "Moreau", "Nakamura", "Okafor", "Petrov",
  "Quintana", "Rosales", "Sandoval", "Takahashi", "Ueda", "Vasquez", "Whitfield", "Xu",
  "Yamamoto", "Zielinski", "Ashford", "Brennan", "Corwin", "Duval", "Ellery", "Fontaine",
] as const;
const DOMAIN = [
  "voltmail.com", "hexworks.io", "bluefern.co", "maplebay.com", "quartzlabs.io",
  "silvercrest.net", "orchidpoint.com", "granitepeak.io", "lunarco.com", "fernwood.dev",
  "coppervale.com", "brightmoor.io", "cedarline.net", "harborlight.co", "willowrun.com",
] as const;

interface Contact {
  external_id: string;
  name: string;
  email: string;
  updated_at: string;
}

// Timestamps first (then sorted) so the provider export pages in updated_at
// order — the skipped pages therefore CLUSTER at cursor-page boundaries.
const timestamps: number[] = [];
const nContacts = TARGET_CONTACTS + rngInt(-30, 30);
for (let i = 0; i < nContacts; i++) {
  timestamps.push(WINDOW_START_MS + Math.floor(rng() * (WINDOW_END_MS - WINDOW_START_MS)));
}
timestamps.sort((a, b) => a - b);

const contacts: Contact[] = timestamps.map((ts, i) => {
  const first = rngPick(FIRST);
  const last = rngPick(LAST);
  return {
    external_id: `ct_${String(i + 1).padStart(5, "0")}`,
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${rngInt(1, 999)}@${rngPick(DOMAIN)}`,
    updated_at: fmtUtc(ts),
  };
});

// ─── Page structure + failure injection ─────────────────────────────────────

const nPages = Math.ceil(contacts.length / PAGE_SIZE);
if (nPages < 20) throw new Error(`dataset too small for failure injection: ${nPages} pages`);

/** Cursor token for page p (1-based). Page 1 is requested WITHOUT a cursor.
 *  Tokens look sequential — the provider documents them as opaque, which is
 *  exactly what the buggy retry wrapper violates by synthesising them. */
function tok(p: number): string | null {
  if (p <= 1 || p > nPages) return null;
  return `cur_${String(p).padStart(4, "0")}`;
}

/** Sample distinct pages from [lo, hi] keeping pairwise distance ≥ minGap and
 *  avoiding an exclusion set (with its ±1 neighbours). */
function samplePages(
  count: number,
  lo: number,
  hi: number,
  minGap: number,
  exclude: Set<number>,
): number[] {
  const out: number[] = [];
  let guard = 0;
  while (out.length < count) {
    if (++guard > 100_000) throw new Error("samplePages: cannot satisfy constraints");
    const p = rngInt(lo, hi);
    if (exclude.has(p) || exclude.has(p - 1) || exclude.has(p + 1)) continue;
    if (out.some((q) => Math.abs(q - p) < minGap)) continue;
    out.push(p);
  }
  return out.sort((a, b) => a - b);
}

// Stale-cursor incidents skip page p entirely. Interior full pages only
// (p ≤ nPages-2 keeps them full; p ≥ 3 keeps the duplicated predecessor a
// real cursor-bearing page).
const skipPages = samplePages(SKIP_INCIDENT_COUNT, 3, nPages - 2, 2, new Set());
const skipSet = new Set(skipPages);

// Token-expiry 401s (red herring): retried successfully, no records lost.
const authPages = samplePages(AUTH_401_COUNT, 2, nPages - 1, 2, skipSet);
const authSet = new Set(authPages);

// Pro-only: 401s whose refresh+retry ALSO fails (token rotation race) — these
// pages are lost too, so "it's just the tokens" is partially true and harder
// to reject. Empty for the mid-band isomorphs.
const authDropExclude = new Set([...skipSet, ...authSet]);
const authDropPages = AUTH_DROP_COUNT > 0
  ? samplePages(AUTH_DROP_COUNT, 3, nPages - 2, 2, authDropExclude)
  : [];
const authDropSet = new Set(authDropPages);

// ─── Local synced copy (what our integration ended up with) ─────────────────

const localContacts: Array<Contact & { id: string }> = [];
for (let p = 1; p <= nPages; p++) {
  if (skipSet.has(p) || authDropSet.has(p)) continue; // silently skipped pages
  const start = (p - 1) * PAGE_SIZE;
  for (const c of contacts.slice(start, start + PAGE_SIZE)) {
    localContacts.push({ ...c, id: `loc_${String(localContacts.length + 1).padStart(5, "0")}` });
  }
}

// ─── API request log (the sync run, chronological) ──────────────────────────

interface ApiRequest {
  id: string;
  endpoint: string;
  method: string;
  status_code: number;
  cursor: string | null;
  next_cursor: string | null;
  retry_of: string | null;
  requested_at: string;
}

const requests: ApiRequest[] = [];
let reqTs = Date.parse(SYNC_RUN_AT.replace(" ", "T") + "Z");
function pushReq(r: Omit<ApiRequest, "id" | "requested_at">): ApiRequest {
  const row: ApiRequest = {
    id: `req_${String(requests.length + 1).padStart(4, "0")}`,
    requested_at: fmtUtc(reqTs),
    ...r,
  };
  requests.push(row);
  reqTs += rngInt(1, 3) * 1000;
  return row;
}

// Initial token mint for the run.
pushReq({ endpoint: "/v2/auth/token", method: "POST", status_code: 200, cursor: null, next_cursor: null, retry_of: null });

for (let p = 1; p <= nPages; p++) {
  if (skipSet.has(p)) {
    // Rate-limited attempt at page p…
    const failed = pushReq({ endpoint: "/v2/contacts", method: "GET", status_code: 429, cursor: tok(p), next_cursor: null, retry_of: null });
    // …and the NON-IDEMPOTENT retry: the wrapper rebuilds the cursor from its
    // own page counter (offset-era behaviour), re-sending the PREVIOUS page's
    // token. The provider duly returns page p-1 again (next_cursor → page p),
    // but the client's counter says page p is done — page p is never fetched.
    pushReq({ endpoint: "/v2/contacts", method: "GET", status_code: 200, cursor: tok(p - 1), next_cursor: tok(p), retry_of: failed.id });
    continue;
  }
  if (authSet.has(p)) {
    // Expired token (red herring): refresh + retry succeed, nothing lost.
    const failed = pushReq({ endpoint: "/v2/contacts", method: "GET", status_code: 401, cursor: tok(p), next_cursor: null, retry_of: null });
    pushReq({ endpoint: "/v2/auth/token", method: "POST", status_code: 200, cursor: null, next_cursor: null, retry_of: null });
    pushReq({ endpoint: "/v2/contacts", method: "GET", status_code: 200, cursor: tok(p), next_cursor: tok(p + 1), retry_of: failed.id });
    continue;
  }
  if (authDropSet.has(p)) {
    // Pro-only: token rotation race — the refresh is rejected and the retry
    // 401s again; the wrapper gives up and moves on. Page p lost to AUTH.
    const failed = pushReq({ endpoint: "/v2/contacts", method: "GET", status_code: 401, cursor: tok(p), next_cursor: null, retry_of: null });
    pushReq({ endpoint: "/v2/auth/token", method: "POST", status_code: 401, cursor: null, next_cursor: null, retry_of: null });
    pushReq({ endpoint: "/v2/contacts", method: "GET", status_code: 401, cursor: tok(p), next_cursor: null, retry_of: failed.id });
    continue;
  }
  pushReq({ endpoint: "/v2/contacts", method: "GET", status_code: 200, cursor: tok(p), next_cursor: tok(p + 1), retry_of: null });
}

// ─── Ground truth (computed from the generated rows, never assumed) ─────────

const providerCount = contacts.length;
const syncedDistinct = new Set(localContacts.map((c) => c.external_id)).size;
const missingCount = providerCount - syncedDistinct;
const cursorSkippedCount = skipPages.reduce(
  (s, p) => s + Math.min(PAGE_SIZE, providerCount - (p - 1) * PAGE_SIZE), 0);
const authDroppedCount = authDropPages.reduce(
  (s, p) => s + Math.min(PAGE_SIZE, providerCount - (p - 1) * PAGE_SIZE), 0);
if (missingCount !== cursorSkippedCount + authDroppedCount) {
  throw new Error(`ground-truth mismatch: missing=${missingCount} vs skipped=${cursorSkippedCount}+${authDroppedCount}`);
}

const groundTruth = {
  seed_label: SEED_LABEL,
  company: COMPANY,
  provider: PROVIDER,
  sync_run_at: SYNC_RUN_AT,
  page_size: PAGE_SIZE,
  // ── family2-content.ts REQUIRED contract keys ──
  provider_record_count: providerCount,
  synced_record_count: syncedDistinct,
  missing_record_count: missingCount,
  edge_case_record_count: cursorSkippedCount,
  root_cause: ROOT_CAUSE,
  // ── extras (welcome per contract) ──
  cursor_skipped_record_count: cursorSkippedCount,
  auth_dropped_record_count: authDroppedCount,
  skipped_pages: skipPages,
  auth_dropped_pages: authDropPages,
  duplicate_cursor_pages: skipPages.map((p) => p - 1),
  auth_401_count: AUTH_401_COUNT + AUTH_DROP_COUNT,
  auth_401_all_retried_ok: AUTH_DROP_COUNT === 0,
  totals: {
    provider_contacts: providerCount,
    local_contacts: localContacts.length,
    api_requests: requests.length,
  },
  ps_fork: {
    // Matches the P3.2 detector default (evidence-extractor.ts) — stated
    // explicitly so the binding is auditable per fixture.
    curveball_id: "hardcode_workaround",
  },
  root_cause_narrative:
    `${PROVIDER} moved /v2/contacts from offset to cursor pagination (contract drift). ` +
    `Our retry wrapper is non-idempotent: on a retry it rebuilds the page token from its own ` +
    `counter and re-sends the PREVIOUS page's cursor, so the retried page is fetched twice ` +
    `(duplicate-cursor fingerprint: GROUP BY cursor HAVING COUNT(*) > 1 on the 200s) and its ` +
    `successor page is silently skipped — the ${missingCount} missing contacts cluster exactly at ` +
    `those page boundaries. The 401s are a red herring${AUTH_DROP_COUNT === 0
      ? ": every one was retried successfully after a token refresh, so token expiry cannot explain the gap."
      : ` for the BULK of the gap: most were retried successfully, but ${authDroppedCount} records on ` +
        `${AUTH_DROP_COUNT} pages were also lost to a token-rotation race (refresh rejected, retry 401'd) — ` +
        `a real but SECONDARY issue that must be quantified separately from the dominant cursor bug.`}`,
};

// ─── Emit files ──────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const qn = (s: string | null): string => (s === null ? "NULL" : q(s));

const schemaSql = `-- ${SEED_LABEL} synthetic schema (GENERATED — do not edit by hand)
-- Runs in SQLite (the sandbox customer.db is built with python sqlite3).
-- Regenerate via:  pnpm exec tsx fixtures/${SEED_LABEL.replace(/-v\d+$/, "")}/generate.ts

DROP TABLE IF EXISTS api_requests;
DROP TABLE IF EXISTS provider_contacts;
DROP TABLE IF EXISTS local_contacts;

-- Request log of the nightly ${PROVIDER} sync run (client side).
CREATE TABLE api_requests (
  id           TEXT PRIMARY KEY,
  endpoint     TEXT NOT NULL,
  method       TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  cursor       TEXT,
  next_cursor  TEXT,
  retry_of     TEXT,
  requested_at TEXT NOT NULL
);
CREATE INDEX api_requests_status ON api_requests (status_code);
CREATE INDEX api_requests_cursor ON api_requests (cursor);

-- The provider's full contact export (source of truth).
CREATE TABLE provider_contacts (
  external_id TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX provider_contacts_updated_at ON provider_contacts (updated_at);

-- Our synced local copy (what the integration actually wrote).
CREATE TABLE local_contacts (
  id          TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX local_contacts_external_id ON local_contacts (external_id);
`;

const seedLines: string[] = [
  `-- ${SEED_LABEL} synthetic seed (GENERATED — do not edit by hand)`,
  `-- Regenerate via: pnpm exec tsx fixtures/${SEED_LABEL.replace(/-v\d+$/, "")}/generate.ts`,
  "BEGIN;",
  "",
  "-- provider_contacts",
];
for (const c of contacts) {
  seedLines.push(
    `INSERT INTO provider_contacts (external_id, name, email, updated_at) VALUES (${q(c.external_id)}, ${q(c.name)}, ${q(c.email)}, ${q(c.updated_at)});`,
  );
}
seedLines.push("", "-- local_contacts");
for (const c of localContacts) {
  seedLines.push(
    `INSERT INTO local_contacts (id, external_id, name, email, updated_at) VALUES (${q(c.id)}, ${q(c.external_id)}, ${q(c.name)}, ${q(c.email)}, ${q(c.updated_at)});`,
  );
}
seedLines.push("", "-- api_requests");
for (const r of requests) {
  seedLines.push(
    `INSERT INTO api_requests (id, endpoint, method, status_code, cursor, next_cursor, retry_of, requested_at) VALUES (${q(r.id)}, ${q(r.endpoint)}, ${q(r.method)}, ${r.status_code}, ${qn(r.cursor)}, ${qn(r.next_cursor)}, ${qn(r.retry_of)}, ${q(r.requested_at)});`,
  );
}
seedLines.push("", "COMMIT;", "");

const queriesSql = `-- Discriminator queries for ${SEED_LABEL} (GENERATED — do not edit by hand).
-- Mirrors the strong-playthrough SQL in apps/server/scripts/family2-content.ts.

-- [1] HTTP status distribution — surfaces the 401/429 red herring.
SELECT status_code, COUNT(*) AS n
FROM api_requests
GROUP BY status_code
ORDER BY n DESC;

-- [2] The gap: provider count vs distinct local count.
SELECT
  (SELECT COUNT(*) FROM provider_contacts) AS provider_n,
  (SELECT COUNT(DISTINCT external_id) FROM local_contacts) AS local_n,
  (SELECT COUNT(*) FROM provider_contacts)
    - (SELECT COUNT(DISTINCT external_id) FROM local_contacts) AS missing_n;

-- [3] Characterize the missing records (they cluster at cursor-page boundaries).
SELECT p.external_id, p.updated_at
FROM provider_contacts p
LEFT JOIN local_contacts l ON l.external_id = p.external_id
WHERE l.external_id IS NULL
ORDER BY p.updated_at
LIMIT 25;

-- [4] Pagination fingerprint: a retried request re-used a stale cursor, so a
-- page was fetched twice (and its successor skipped).
SELECT cursor, COUNT(*) AS n
FROM api_requests
WHERE endpoint LIKE '%/contacts%' AND status_code = 200
GROUP BY cursor
HAVING COUNT(*) > 1
ORDER BY n DESC
LIMIT 10;

-- [5] Retry paths (which requests were retries, of what).
SELECT retry_of, COUNT(*) AS n
FROM api_requests
WHERE retry_of IS NOT NULL
GROUP BY retry_of
ORDER BY n DESC
LIMIT 10;
`;

writeFileSync(resolve(here, "schema.sql"), schemaSql);
writeFileSync(resolve(here, "seed.sql"), seedLines.join("\n"));
writeFileSync(resolve(here, "ground_truth.json"), JSON.stringify(groundTruth, null, 2) + "\n");
writeFileSync(resolve(here, "queries.sql"), queriesSql);

console.log(`[${SEED_LABEL}] provider=${providerCount} synced=${syncedDistinct} missing=${missingCount} ` +
  `(cursor-skipped=${cursorSkippedCount}, auth-dropped=${authDroppedCount}) pages=${nPages} ` +
  `skip_pages=[${skipPages.join(",")}] auth_pages=[${authPages.join(",")}] auth_drop=[${authDropPages.join(",")}] ` +
  `requests=${requests.length}`);
console.log("OK — schema.sql, seed.sql, ground_truth.json, queries.sql written");
