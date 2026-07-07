// P4.3 — tokenized shareable candidate-report links (report_shares, 0021).
//
// Same token discipline as session-link.ts: unguessable raw 32-byte base64url
// token returned ONCE at mint; only the SHA-256 is stored. Status is derived,
// never stored: revoked_at → revoked, now > expires_at → expired, else active.
// Unlike session links, report shares are NOT single-use — the same link can
// be opened many times until it expires or is revoked (it's a read-only
// report, not a start gate).
//
// org_id stamps the OWNING tenant (the session's org — routes/review.ts uses
// sessionOrgGate's sessionOrgId, so an admin minting for a partner's session
// does not pull the share into the admin org).

import { randomBytes, createHash } from "node:crypto";
import { supabase } from "./supabase.js";
import { scopeToOrg, type OrgRow } from "./orgs.js";

export const DEFAULT_SHARE_TTL_HOURS = 168; // 7 days
export const MAX_SHARE_TTL_HOURS = 720;     // 30 days — spec P4.3 hard cap
const HOUR_MS = 3_600_000;

export type ReportShareErrorCode = "invalid" | "not_found" | "server";

export class ReportShareError extends Error {
  code: ReportShareErrorCode;
  constructor(code: ReportShareErrorCode, msg: string) {
    super(msg);
    this.name = "ReportShareError";
    this.code = code;
  }
}

export type ReportShareStatus = "active" | "expired" | "revoked";

export interface ReportShareRow {
  id: string;
  session_id: string;
  org_id: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/** External summary — never includes token_hash. */
export interface ReportShareSummary {
  id: string;
  session_id: string;
  expires_at: string;
  created_at: string;
  status: ReportShareStatus;
}

// token_hash is deliberately NOT selected anywhere — even server-internal
// callers only ever need the row identity + lifecycle columns.
const SELECT_COLS = "id, session_id, org_id, expires_at, revoked_at, created_at";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function deriveShareStatus(
  row: Pick<ReportShareRow, "revoked_at" | "expires_at">,
): ReportShareStatus {
  if (row.revoked_at) return "revoked";
  if (Date.parse(row.expires_at) <= Date.now()) return "expired";
  return "active";
}

function toSummary(row: ReportShareRow): ReportShareSummary {
  return {
    id: row.id,
    session_id: row.session_id,
    expires_at: row.expires_at,
    created_at: row.created_at,
    status: deriveShareStatus(row),
  };
}

/** Mint a share link for a session. Returns the RAW token once; only the
 *  sha256 is persisted. ttlHours is validated here as well as at the route
 *  boundary — the 720h cap is a spec invariant, not just an API shape. */
export async function createReportShare(opts: {
  sessionId: string;
  /** Owning tenant — the SESSION's org (sessionOrgGate), required (0021 NOT NULL). */
  orgId: string | null | undefined;
  ttlHours?: number;
}): Promise<{ token: string; share: ReportShareSummary }> {
  if (!supabase) throw new ReportShareError("server", "Supabase service-role client unavailable");
  if (!opts.orgId) {
    throw new ReportShareError("invalid", "report share requires an owning org (orgs not migrated?)");
  }
  const ttl = opts.ttlHours ?? DEFAULT_SHARE_TTL_HOURS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_SHARE_TTL_HOURS) {
    throw new ReportShareError("invalid", `ttlHours must be 1..${MAX_SHARE_TTL_HOURS}`);
  }

  const token = randomBytes(32).toString("base64url");
  const { data, error } = await supabase
    .from("report_shares")
    .insert({
      token_hash: hashToken(token),
      session_id: opts.sessionId,
      org_id: opts.orgId,
      expires_at: new Date(Date.now() + ttl * HOUR_MS).toISOString(),
    })
    .select(SELECT_COLS)
    .single();
  if (error) throw new ReportShareError("server", `report_share insert failed: ${error.message}`);
  return { token, share: toSummary(data as unknown as ReportShareRow) };
}

/** All share links for one session, newest first. P2: partner orgs see only
 *  their own org's shares (defense in depth — the route already gates the
 *  session); admin sees all. */
export async function listReportShares(
  sessionId: string,
  org?: OrgRow,
): Promise<ReportShareSummary[]> {
  if (!supabase) throw new ReportShareError("server", "Supabase service-role client unavailable");
  const { data, error } = await scopeToOrg(
    supabase.from("report_shares").select(SELECT_COLS).eq("session_id", sessionId),
    org,
  )
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new ReportShareError("server", `report_shares read failed: ${error.message}`);
  return ((data ?? []) as unknown as ReportShareRow[]).map(toSummary);
}

/** Revoke a share link (idempotent). Org-scoped: a foreign org's share reads
 *  as not-found — no existence leak. */
export async function revokeReportShare(id: string, org?: OrgRow): Promise<ReportShareSummary> {
  if (!supabase) throw new ReportShareError("server", "Supabase service-role client unavailable");
  const updated = await scopeToOrg(
    supabase
      .from("report_shares")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .is("revoked_at", null),
    org,
  )
    .select(SELECT_COLS)
    .maybeSingle();
  if (updated.error) throw new ReportShareError("server", `revoke failed: ${updated.error.message}`);
  if (updated.data) return toSummary(updated.data as unknown as ReportShareRow);
  // Already revoked or unknown — return current state if visible to this org.
  const { data: cur } = await scopeToOrg(
    supabase.from("report_shares").select(SELECT_COLS).eq("id", id),
    org,
  ).maybeSingle();
  if (!cur) throw new ReportShareError("not_found", `report_share ${id} not found`);
  return toSummary(cur as unknown as ReportShareRow);
}

/** Public-endpoint lookup: raw token → row + derived status, or null when the
 *  token matches nothing. The CALLER enforces status (routes/report.ts maps
 *  expired/revoked to 410) — returning the row for dead links lets the route
 *  give the recruiter-shared URL a precise, non-leaky error. */
export async function resolveReportShare(
  rawToken: string,
): Promise<{ row: ReportShareRow; status: ReportShareStatus } | null> {
  if (!supabase) throw new ReportShareError("server", "Supabase service-role client unavailable");
  const { data, error } = await supabase
    .from("report_shares")
    .select(SELECT_COLS)
    .eq("token_hash", hashToken(rawToken))
    .maybeSingle();
  if (error) throw new ReportShareError("server", `report_share read failed: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as ReportShareRow;
  return { row, status: deriveShareStatus(row) };
}
