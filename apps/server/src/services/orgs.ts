// P2 — tenant orgs (API-key-per-org; no Supabase Auth users, no login UI).
//
// An org row is the tenant boundary: sessions / outcomes / session_links /
// outcome_invites carry org_id (NOT NULL after 0018). Scenarios stay GLOBAL
// (asaya IP). Two secrets hang off each org, both stored as SHA-256 hashes
// with the raw value returned exactly once at mint time (the session-link
// token pattern):
//   api_key_hash        — authenticates /api/review/* via the X-Org-Key header
//   webhook_secret_hash — authenticates POST /api/outcomes (Bearer)
//
// ISOLATION MODEL: RLS is enabled with zero policies (deny-all backstop for
// anon/authenticated); ALL app traffic uses the service role which bypasses
// RLS — so isolation is enforced HERE, at the app layer: requireOrg() gates
// the routes, and every query is scoped by org_id unless the caller org has
// role 'admin' (the internal asaya org, which sees everything).

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { supabase } from "./supabase.js";
import { env } from "../env.js";

export class OrgError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "OrgError";
  }
}

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  role: "admin" | "partner";
}

const ORG_COLS = "id, name, slug, status, role";
export const DEFAULT_ORG_SLUG = "asaya";

// ── Post-migration safety latch ──────────────────────────────────────────────
// Once ANY org lookup has succeeded we KNOW the orgs table exists (0018 is
// applied). From then on, a null/failed default-org resolution must be a HARD
// error in the write paths (persistSessionCreated / insertOutcome / session
// creation) — silently omitting org_id there would trip the NOT NULL insert
// downstream and the row would vanish without a trace.
let orgsTableSeen = false;

/** True once any org lookup has succeeded in this process — i.e. the orgs
 *  table is known to exist and legacy "omit org_id" fallbacks are no longer
 *  acceptable. */
export function orgsTableKnownToExist(): boolean {
  return orgsTableSeen;
}

/** Does this error mean the orgs table itself is absent (migration 0018 not
 *  applied)? PostgREST surfaces that as 42P01 ("relation ... does not exist")
 *  or PGRST205 ("Could not find the table ... in the schema cache"). */
function isMissingOrgsTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /42P01|relation .*orgs.* does not exist|Could not find the table/i.test(msg);
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// ── In-memory TTL cache ──────────────────────────────────────────────────────
// One review page load fires many /api/review/* calls; a 60s cache keeps that
// from becoming a DB hit per request. Keyed by the secret's sha256 (never the
// raw). Only HITS are cached — misses (bad key / orgs table not migrated yet)
// always re-query, so a freshly minted key works immediately. Constant-time
// compare is NOT needed here: the caller-supplied value is hashed and used as
// an exact-match lookup key, so there is no byte-by-byte secret comparison to
// time-attack.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { org: OrgRow; at: number }>();

function cacheGet(key: string): OrgRow | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.org;
}

/** Test/ops escape hatch (used after minting rotates a secret). */
export function clearOrgCache(): void {
  cache.clear();
}

async function lookupOrgBy(column: "api_key_hash" | "webhook_secret_hash" | "slug", value: string): Promise<OrgRow | null> {
  if (!supabase) throw new OrgError("Supabase service-role client unavailable");
  const { data, error } = await supabase
    .from("orgs")
    .select(ORG_COLS)
    .eq(column, value)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new OrgError(`org lookup failed: ${error.message}`);
  orgsTableSeen = true; // the query succeeded → the orgs table exists
  return (data as unknown as OrgRow) ?? null;
}

// ── Operator-set admin credential (ORG_ADMIN_KEY) ────────────────────────────
// The internal asaya org's credential can be a plain env var instead of a
// minted secret: operators set/rotate it by editing the Railway variable. It is
// accepted anywhere an org API key OR org webhook secret is presented — one
// variable to manage — and always resolves to the default asaya org (role
// admin). Minted admin secrets, if any, continue to work via the hash lookup.
// This is a direct raw-secret comparison (unlike the hash-keyed lookups above),
// so it MUST be constant-time: timingSafeEqual on equal-length buffers.
function matchesOrgAdminKey(raw: string): boolean {
  const adminKey = env.ORG_ADMIN_KEY;
  if (!adminKey) return false;
  const a = Buffer.from(raw);
  const b = Buffer.from(adminKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Resolve an org from a raw API key (X-Org-Key). Active orgs only. */
export async function resolveOrgByApiKey(raw: string): Promise<OrgRow | null> {
  if (matchesOrgAdminKey(raw)) {
    const def = await getDefaultOrg();
    if (def) return def;
  }
  const hash = sha256(raw);
  const cached = cacheGet(`api:${hash}`);
  if (cached) return cached;
  const org = await lookupOrgBy("api_key_hash", hash);
  if (org) cache.set(`api:${hash}`, { org, at: Date.now() });
  return org;
}

/** Resolve an org from a raw per-org webhook secret (Bearer on /api/outcomes). */
export async function resolveOrgByWebhookSecret(raw: string): Promise<OrgRow | null> {
  if (matchesOrgAdminKey(raw)) {
    const def = await getDefaultOrg();
    if (def) return def;
  }
  const hash = sha256(raw);
  const cached = cacheGet(`whk:${hash}`);
  if (cached) return cached;
  const org = await lookupOrgBy("webhook_secret_hash", hash);
  if (org) cache.set(`whk:${hash}`, { org, at: Date.now() });
  return org;
}

/** Cached lookup of the default 'asaya' org (the pre-P2 backfill target and
 *  internal admin tenant). Returns null — rather than throwing — ONLY when the
 *  orgs table doesn't exist yet (0018 not applied), so pre-migration deploys
 *  keep working with the legacy unscoped behavior. Any OTHER failure after the
 *  table is known to exist (orgsTableKnownToExist) is rethrown: post-migration,
 *  "couldn't resolve the default org" must fail loudly, not silently degrade
 *  to omitting org_id (the NOT NULL insert would fail downstream anyway). */
export async function getDefaultOrg(): Promise<OrgRow | null> {
  const cached = cacheGet("slug:asaya");
  if (cached) return cached;
  try {
    const org = await lookupOrgBy("slug", DEFAULT_ORG_SLUG);
    if (org) cache.set("slug:asaya", { org, at: Date.now() });
    return org;
  } catch (err) {
    if (isMissingOrgsTable(err)) return null; // legacy pre-0018 mode
    if (orgsTableSeen) throw err; // table exists → transient failure is HARD
    return null; // never seen the table + ambiguous failure → legacy fallback
  }
}

// ── Minting (raw returned ONCE; only the hash is stored) ─────────────────────

async function mintSecret(orgId: string, column: "api_key_hash" | "webhook_secret_hash"): Promise<string> {
  if (!supabase) throw new OrgError("Supabase service-role client unavailable");
  const raw = randomBytes(32).toString("base64url");
  const { data, error } = await supabase
    .from("orgs")
    .update({ [column]: sha256(raw) })
    .eq("id", orgId)
    .select("id")
    .maybeSingle();
  if (error) throw new OrgError(`${column} mint failed: ${error.message}`);
  orgsTableSeen = true;
  if (!data) throw new OrgError(`org ${orgId} not found`);
  // Rotation caveat: a previously cached resolution of the OLD secret can live
  // for up to CACHE_TTL_MS (60s). Acceptable for ops rotation; clearOrgCache()
  // exists for immediate revocation in-process.
  return raw;
}

/** Rotate + return the org's raw API key (shown once). */
export function mintOrgApiKey(orgId: string): Promise<string> {
  return mintSecret(orgId, "api_key_hash");
}

/** Rotate + return the org's raw webhook secret (shown once). */
export function mintOrgWebhookSecret(orgId: string): Promise<string> {
  return mintSecret(orgId, "webhook_secret_hash");
}

/** Create a partner org and mint both secrets. Raws are returned ONCE. */
export async function createOrg(
  name: string,
  slug: string,
): Promise<{ org: OrgRow; apiKey: string; webhookSecret: string }> {
  if (!supabase) throw new OrgError("Supabase service-role client unavailable");
  const { data, error } = await supabase
    .from("orgs")
    .insert({ name, slug })
    .select(ORG_COLS)
    .single();
  if (error) throw new OrgError(`org insert failed: ${error.message}`);
  orgsTableSeen = true;
  const org = data as unknown as OrgRow;
  const apiKey = await mintOrgApiKey(org.id);
  const webhookSecret = await mintOrgWebhookSecret(org.id);
  return { org, apiKey, webhookSecret };
}

// ── App-layer scoping helpers (THE isolation mechanism — see header) ─────────

/** May `org` see a row stamped with `rowOrgId`?
 *  - admin org (asaya's key) → everything;
 *  - partner org → only its own rows;
 *  - org undefined (pre-0018 back-compat fallback when the orgs table doesn't
 *    exist yet) → unscoped, preserving today's behavior. */
export function orgCanAccess(org: OrgRow | undefined, rowOrgId: string | null | undefined): boolean {
  if (!org) return true;
  if (org.role === "admin") return true;
  return rowOrgId === org.id;
}

/** Apply org scoping to a PostgREST filter builder: partner orgs get
 *  .eq("org_id", org.id); admin (and the pre-migration undefined org) see all.
 *
 *  Typing note: constraining T structurally to `{ eq(...): T }` sends tsc into
 *  PostgrestFilterBuilder's recursive generics (TS2589), so the .eq call goes
 *  through a narrow documented cast instead — .eq returns the same builder at
 *  runtime, making the round-trip cast safe. */
export function scopeToOrg<T>(query: T, org: OrgRow | undefined): T {
  if (!org || org.role === "admin") return query;
  const scoped = (query as { eq(column: string, value: string): unknown }).eq("org_id", org.id);
  return scoped as T;
}

/** Which org does a session started from a link belong to? Pure so the tenant
 *  gate (verify-tenant-isolation.ts) can test inheritance without HTTP:
 *  link's org wins; link-less (or pre-0018 link) starts fall to the default. */
export function sessionOrgIdFromLink(
  linkOrgId: string | null | undefined,
  defaultOrgId: string | null | undefined,
): string | undefined {
  return linkOrgId ?? defaultOrgId ?? undefined;
}

// ── Fastify guard ────────────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved by requireOrg. Undefined only on the pre-0018 back-compat path
     *  (ORG_AUTH_REQUIRED off + orgs table not migrated yet). */
    org?: OrgRow;
  }
}

/**
 * preHandler: resolve the requesting org from the X-Org-Key header.
 *
 *   - header present  → must resolve to an active org, else 401;
 *   - header absent   → 401 when ORG_AUTH_REQUIRED === "true";
 *   - header absent + ORG_AUTH_REQUIRED off (the default) → BACK-COMPAT
 *     SWITCH: resolve to the default 'asaya' org (role admin → sees all), so
 *     the current unauthenticated review UI keeps working until org keys are
 *     distributed. Flip ORG_AUTH_REQUIRED=true to close the surface.
 */
export const requireOrg: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const header = request.headers["x-org-key"];
  const raw = typeof header === "string" ? header.trim() : "";

  if (raw) {
    let org: OrgRow | null = null;
    try {
      org = await resolveOrgByApiKey(raw);
    } catch (err) {
      request.log.error({ err }, "[orgs] api-key resolution failed");
      return reply.status(503).send({ error: "org_auth_unavailable" });
    }
    if (!org) return reply.status(401).send({ error: "invalid_org_key" });
    request.org = org;
    return;
  }

  if ((env.ORG_AUTH_REQUIRED ?? "").toLowerCase() === "true") {
    return reply.status(401).send({ error: "org_key_required", message: "X-Org-Key header is required." });
  }

  // Back-compat fallback (see doc comment). getDefaultOrg() returns null when
  // 0018 hasn't been applied — request.org stays undefined and routes behave
  // exactly as before P2 (unscoped).
  const def = await getDefaultOrg();
  if (def) request.org = def;
};
