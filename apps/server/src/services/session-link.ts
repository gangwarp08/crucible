// RD6 (Slice 6.7): single-use, candidate-bound, time-boxed session links.
//
// The candidate start-gate used to be one shared reusable INVITE_CODE. These
// links replace it (pilot-appropriate identity integrity — no heavy proctoring):
// unguessable token, consumed on FIRST start (atomic, so a shared link can't
// boot two sessions), bound to the session at start, and expiring. Only the
// token HASH is stored — the raw token lives in the URL handed to the candidate.
//
// Status is derived, never stored: revoked_at → revoked, consumed_at → consumed,
// now > expires_at → expired, else active.

import { randomBytes, createHash } from "node:crypto";
import { supabase } from "./supabase.js";

const DEFAULT_TTL_MINUTES = Number(process.env["SESSION_LINK_TTL_MINUTES"]) || 120;
const MIN_MS = 60_000;

export type SessionLinkErrorCode = "invalid" | "expired" | "consumed" | "revoked" | "server";

export class SessionLinkError extends Error {
  code: SessionLinkErrorCode;
  constructor(code: SessionLinkErrorCode, msg: string) {
    super(msg);
    this.name = "SessionLinkError";
    this.code = code;
  }
}

export type SessionLinkStatus = "active" | "consumed" | "expired" | "revoked";

export interface SessionLinkRow {
  id: string;
  candidate_label: string;
  scenario_id: string | null;
  expires_at: string;
  consumed_at: string | null;
  session_id: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface SessionLinkSummary {
  id: string;
  candidate_label: string;
  scenario_id: string | null;
  expires_at: string;
  consumed_at: string | null;
  session_id: string | null;
  status: SessionLinkStatus;
}

const SELECT_COLS =
  "id, candidate_label, scenario_id, expires_at, consumed_at, session_id, revoked_at, created_at";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function deriveStatus(
  row: Pick<SessionLinkRow, "revoked_at" | "consumed_at" | "expires_at">,
): SessionLinkStatus {
  if (row.revoked_at) return "revoked";
  if (row.consumed_at) return "consumed";
  if (Date.parse(row.expires_at) <= Date.now()) return "expired";
  return "active";
}

function toSummary(row: SessionLinkRow): SessionLinkSummary {
  return {
    id: row.id,
    candidate_label: row.candidate_label,
    scenario_id: row.scenario_id,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    session_id: row.session_id,
    status: deriveStatus(row),
  };
}

async function loadByToken(rawToken: string): Promise<SessionLinkRow | null> {
  if (!supabase) throw new SessionLinkError("server", "Supabase service-role client unavailable");
  const { data, error } = await supabase
    .from("session_links")
    .select(SELECT_COLS)
    .eq("token_hash", hashToken(rawToken))
    .maybeSingle();
  if (error) throw new SessionLinkError("server", `session_link read failed: ${error.message}`);
  return (data as unknown as SessionLinkRow) ?? null;
}

// ─── Admin side ──────────────────────────────────────────────────────────────

/** Mint a single-use link. Returns the RAW token (caller shows it once + builds
 *  the URL); only the hash is persisted. */
export async function createSessionLink(opts: {
  candidateLabel: string;
  scenarioId?: string | null;
  ttlMinutes?: number;
}): Promise<{ token: string; link: SessionLinkSummary }> {
  if (!supabase) throw new SessionLinkError("server", "Supabase service-role client unavailable");
  const label = opts.candidateLabel?.trim();
  if (!label) throw new SessionLinkError("invalid", "candidate_label is required");

  const token = randomBytes(32).toString("base64url");
  const ttl = opts.ttlMinutes && opts.ttlMinutes > 0 ? opts.ttlMinutes : DEFAULT_TTL_MINUTES;
  const expiresAt = new Date(Date.now() + ttl * MIN_MS).toISOString();

  const inserted = await supabase
    .from("session_links")
    .insert({
      token_hash: hashToken(token),
      candidate_label: label,
      scenario_id: opts.scenarioId ?? null,
      expires_at: expiresAt,
    })
    .select(SELECT_COLS)
    .single();
  if (inserted.error) {
    throw new SessionLinkError("server", `session_link insert failed: ${inserted.error.message}`);
  }
  return { token, link: toSummary(inserted.data as unknown as SessionLinkRow) };
}

export async function listSessionLinks(): Promise<SessionLinkSummary[]> {
  if (!supabase) throw new SessionLinkError("server", "Supabase service-role client unavailable");
  const { data, error } = await supabase
    .from("session_links")
    .select(SELECT_COLS)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new SessionLinkError("server", `session_links read failed: ${error.message}`);
  return ((data ?? []) as unknown as SessionLinkRow[]).map(toSummary);
}

/** Revoke a link (idempotent). */
export async function revokeSessionLink(id: string): Promise<SessionLinkSummary> {
  if (!supabase) throw new SessionLinkError("server", "Supabase service-role client unavailable");
  const updated = await supabase
    .from("session_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null)
    .is("consumed_at", null)
    .select(SELECT_COLS)
    .maybeSingle();
  if (updated.error) throw new SessionLinkError("server", `revoke failed: ${updated.error.message}`);
  if (updated.data) return toSummary(updated.data as unknown as SessionLinkRow);
  // Already revoked/consumed or unknown — return current state if it exists.
  const { data: cur } = await supabase.from("session_links").select(SELECT_COLS).eq("id", id).maybeSingle();
  if (!cur) throw new SessionLinkError("invalid", `session_link ${id} not found`);
  return toSummary(cur as unknown as SessionLinkRow);
}

// ─── Candidate side (start-gate) ─────────────────────────────────────────────

/** Read-only pre-check used BEFORE spinning up a sandbox — cheap reject of an
 *  invalid / expired / already-used link. The authoritative single-use guard is
 *  consume() (atomic); this just avoids paying for a sandbox on a dead link. */
export async function peekSessionLink(rawToken: string): Promise<SessionLinkSummary> {
  const row = await loadByToken(rawToken);
  if (!row) throw new SessionLinkError("invalid", "invalid or unknown session link");
  const status = deriveStatus(row);
  if (status !== "active") {
    throw new SessionLinkError(status as SessionLinkErrorCode, `session link is ${status}`);
  }
  return toSummary(row);
}

/**
 * Atomically CONSUME a link and bind it to a session. The conditional UPDATE
 * (consumed_at IS NULL AND not revoked AND not expired) is the real single-use
 * guard: two concurrent starts race on the same row and exactly one wins — the
 * loser gets a precise reason code. Idempotent-safe: a re-used link never
 * consumes twice.
 */
export async function consumeSessionLink(
  rawToken: string,
  sessionId: string,
): Promise<SessionLinkSummary> {
  if (!supabase) throw new SessionLinkError("server", "Supabase service-role client unavailable");
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("session_links")
    .update({ consumed_at: nowIso, session_id: sessionId })
    .eq("token_hash", hashToken(rawToken))
    .is("consumed_at", null)
    .is("revoked_at", null)
    .gt("expires_at", nowIso)
    .select(SELECT_COLS)
    .maybeSingle();
  if (error) throw new SessionLinkError("server", `consume failed: ${error.message}`);
  if (data) return toSummary(data as unknown as SessionLinkRow);

  // The atomic update matched nothing — diagnose why for a precise error.
  const row = await loadByToken(rawToken);
  if (!row) throw new SessionLinkError("invalid", "invalid or unknown session link");
  const status = deriveStatus(row);
  // status is one of revoked/consumed/expired here (active would have matched).
  throw new SessionLinkError(
    status === "active" ? "consumed" : (status as SessionLinkErrorCode),
    `session link is ${status} and can no longer start a session`,
  );
}
