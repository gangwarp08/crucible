// Partner outcome-invite links (post-5.7 feature).
//
// An admin generates a per-session, single-use, expiring link from the review
// UI; the hiring partner opens it (no account, no shared key) and submits
// real-world outcomes for that one candidate. The raw token lives only in the
// URL — we store its SHA-256 hash. The token is the auth boundary; the public
// resolve/submit endpoints are gated solely by possession of a valid token.
//
// Status is derived, never stored: revoked_at → revoked, submitted_at →
// submitted, now > expires_at → expired, else active. Single-use: once
// submitted_at is set, resubmission is refused (generate a fresh link instead).

import { randomBytes, createHash } from "node:crypto";
import { supabase } from "./supabase.js";
import { scopeToOrg, type OrgRow } from "./orgs.js";
import {
  OutcomeInputSchema,
  OUTCOME_TYPES,
  insertOutcome,
  type OutcomeType,
} from "./outcomes.js";

const TTL_DAYS = Number(process.env["OUTCOME_INVITE_TTL_DAYS"]) || 14;
const DAY_MS = 86_400_000;

export class OutcomeInviteError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "OutcomeInviteError";
  }
}

export type InviteStatus = "active" | "submitted" | "expired" | "revoked";

export interface InviteRow {
  id: string;
  session_id: string;
  scenario_id: string | null;
  outcome_types: string[];
  expires_at: string;
  submitted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  // P2: owning tenant. Outcomes submitted through this invite inherit it.
  org_id: string | null;
}

const INVITE_COLS =
  "id, session_id, scenario_id, outcome_types, expires_at, submitted_at, revoked_at, created_at, org_id";

export interface InviteSummary {
  id: string;
  session_id: string;
  outcome_types: string[];
  expires_at: string;
  submitted_at: string | null;
  status: InviteStatus;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function deriveStatus(row: Pick<InviteRow, "revoked_at" | "submitted_at" | "expires_at">): InviteStatus {
  if (row.revoked_at) return "revoked";
  if (row.submitted_at) return "submitted";
  if (Date.parse(row.expires_at) <= Date.now()) return "expired";
  return "active";
}

function toSummary(row: InviteRow): InviteSummary {
  return {
    id: row.id,
    session_id: row.session_id,
    outcome_types: row.outcome_types,
    expires_at: row.expires_at,
    submitted_at: row.submitted_at,
    status: deriveStatus(row),
  };
}

// ─── Admin side ──────────────────────────────────────────────────────────────

/** Create a single-use invite for a session. Returns the RAW token (caller
 *  builds the URL + shows it once); only the hash is persisted. */
export async function createInvite(
  sessionId: string,
  opts: { outcomeTypes?: OutcomeType[]; orgId?: string | null } = {},
): Promise<{ token: string; invite: InviteSummary }> {
  if (!supabase) throw new OutcomeInviteError("Supabase service-role client unavailable");

  // Validate the session exists + backfill scenario_id from it.
  const { data: sess, error: sErr } = await supabase
    .from("sessions")
    .select("id, scenario_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (sErr) throw new OutcomeInviteError(`session lookup failed: ${sErr.message}`);
  if (!sess) throw new OutcomeInviteError(`session ${sessionId} not found`);
  const scenarioId = (sess as { scenario_id: string | null }).scenario_id;

  const types: OutcomeType[] =
    opts.outcomeTypes && opts.outcomeTypes.length > 0 ? opts.outcomeTypes : [...OUTCOME_TYPES];

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_DAYS * DAY_MS).toISOString();

  const inserted = await supabase
    .from("outcome_invites")
    .insert({
      token_hash: hashToken(token),
      session_id: sessionId,
      scenario_id: scenarioId,
      outcome_types: types,
      expires_at: expiresAt,
      // P2: invite belongs to the requesting org; partner_form outcomes
      // submitted through it inherit this org_id. Omitted only on the
      // pre-0018 back-compat path.
      ...(opts.orgId ? { org_id: opts.orgId } : {}),
    })
    .select()
    .single();
  if (inserted.error) throw new OutcomeInviteError(`invite insert failed: ${inserted.error.message}`);
  return { token, invite: toSummary(inserted.data as unknown as InviteRow) };
}

/** List invites for a session, newest first, with derived status.
 *  P2: partner orgs see only their own invites. */
export async function listInvites(sessionId: string, org?: OrgRow): Promise<InviteSummary[]> {
  if (!supabase) throw new OutcomeInviteError("Supabase service-role client unavailable");
  const { data, error } = await scopeToOrg(
    supabase.from("outcome_invites").select(INVITE_COLS).eq("session_id", sessionId),
    org,
  ).order("created_at", { ascending: false });
  if (error) throw new OutcomeInviteError(`invites read failed: ${error.message}`);
  return ((data ?? []) as unknown as InviteRow[]).map(toSummary);
}

/** Revoke an invite (idempotent — already-revoked stays revoked).
 *  P2: partner orgs can only revoke their own invites (foreign → not found). */
export async function revokeInvite(inviteId: string, org?: OrgRow): Promise<InviteSummary> {
  if (!supabase) throw new OutcomeInviteError("Supabase service-role client unavailable");
  const updated = await scopeToOrg(
    supabase
      .from("outcome_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", inviteId)
      .is("revoked_at", null),
    org,
  )
    .select()
    .maybeSingle();
  if (updated.error) throw new OutcomeInviteError(`invite revoke failed: ${updated.error.message}`);
  if (!updated.data) {
    // Either unknown id or already revoked — return current state if it exists.
    const { data: cur } = await scopeToOrg(
      supabase.from("outcome_invites").select(INVITE_COLS).eq("id", inviteId),
      org,
    ).maybeSingle();
    if (!cur) throw new OutcomeInviteError(`invite ${inviteId} not found`);
    return toSummary(cur as unknown as InviteRow);
  }
  return toSummary(updated.data as unknown as InviteRow);
}

// ─── Partner side (token-gated) ──────────────────────────────────────────────

export interface InviteContext {
  status: InviteStatus;
  session_id: string;
  scenario_title: string | null;
  outcome_types: string[];
  expires_at: string;
}

async function loadByToken(rawToken: string): Promise<InviteRow | null> {
  if (!supabase) throw new OutcomeInviteError("Supabase service-role client unavailable");
  const { data, error } = await supabase
    .from("outcome_invites")
    .select(INVITE_COLS)
    .eq("token_hash", hashToken(rawToken))
    .maybeSingle();
  if (error) throw new OutcomeInviteError(`invite read failed: ${error.message}`);
  return (data as unknown as InviteRow) ?? null;
}

/** Resolve a token to its form context. Throws if the token is unknown; returns
 *  the derived status (the route decides whether a non-active status is usable). */
export async function resolveInvite(rawToken: string): Promise<InviteContext> {
  const row = await loadByToken(rawToken);
  if (!row) throw new OutcomeInviteError("invalid or unknown link");

  let scenarioTitle: string | null = null;
  if (row.scenario_id && supabase) {
    const { data: scen } = await supabase
      .from("scenarios")
      .select("title")
      .eq("id", row.scenario_id)
      .maybeSingle();
    scenarioTitle = (scen as { title: string } | null)?.title ?? null;
  }

  return {
    status: deriveStatus(row),
    session_id: row.session_id,
    scenario_title: scenarioTitle,
    outcome_types: row.outcome_types,
    expires_at: row.expires_at,
  };
}

export interface SubmitResult {
  written: string[]; // outcome_types written
  status: InviteStatus;
}

/** Submit outcomes against a token. Validates each value with the shared
 *  OutcomeInputSchema, writes them as source='partner_form', and marks the
 *  invite submitted (single-use). `values` is keyed by outcome_type. */
export async function submitInvite(
  rawToken: string,
  values: Record<string, unknown>,
  candidateRef?: string,
): Promise<SubmitResult> {
  if (!supabase) throw new OutcomeInviteError("Supabase service-role client unavailable");
  const row = await loadByToken(rawToken);
  if (!row) throw new OutcomeInviteError("invalid or unknown link");

  const status = deriveStatus(row);
  if (status !== "active") {
    throw new OutcomeInviteError(`link is ${status} and can no longer be used`);
  }

  // Build + validate one outcome per requested type that has a provided value.
  const candidate = (candidateRef && candidateRef.trim()) || row.session_id;
  const allowed = new Set(row.outcome_types);
  const toWrite: Array<ReturnType<typeof OutcomeInputSchema.parse>> = [];
  const errors: Record<string, unknown> = {};
  let provided = 0;

  for (const [type, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    provided++;
    if (!allowed.has(type)) {
      errors[type] = "outcome type not requested by this link";
      continue;
    }
    const parsed = OutcomeInputSchema.safeParse({
      candidate_ref: candidate,
      session_id: row.session_id,
      ...(row.scenario_id ? { scenario_id: row.scenario_id } : {}),
      outcome_type: type,
      value,
    });
    if (!parsed.success) {
      errors[type] = parsed.error.flatten().fieldErrors;
      continue;
    }
    toWrite.push(parsed.data);
  }

  if (provided === 0) throw new OutcomeInviteError("no outcome values provided");
  if (Object.keys(errors).length > 0) {
    throw new OutcomeInviteError(`invalid values: ${JSON.stringify(errors)}`);
  }

  const written: string[] = [];
  for (const input of toWrite) {
    // P2: partner_form outcomes inherit the INVITE's org — the invite row is
    // the tenant authority for this submission, not any ambient default.
    await insertOutcome(input, "partner_form", row.org_id);
    written.push(input.outcome_type);
  }

  // Mark single-use. Guard on still-active so two concurrent submits can't both win.
  const { error: upErr } = await supabase
    .from("outcome_invites")
    .update({ submitted_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("submitted_at", null);
  if (upErr) throw new OutcomeInviteError(`invite finalize failed: ${upErr.message}`);

  return { written, status: "submitted" };
}
