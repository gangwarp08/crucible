// P6 (proctoring v2, DORMANT) — consent recording, identity verification,
// and the biometric deletion path.
//
// DORMANCY: every entry point is gated on the org flag
// (orgs.settings.proctoring_v2_enabled === true) — absent/false (the default
// everywhere) means the routes refuse and none of this code touches data.
// Skip-graceful pre-0024: when the identity_checks table is absent every
// operation fails soft (recorded=false / null status), never a crash.
//
// DATA MINIMIZATION (the load-bearing property):
//   - The two identity images (ID photo + selfie) are handled IN MEMORY ONLY:
//     they arrive in the request body, go to the LiteLLM gateway for the
//     match, and are garbage-collected with the request. They are NEVER
//     written to Supabase, the events table, the sandbox, disk, or logs.
//   - identity_checks stores DERIVED results only (decision, confidence,
//     verified boolean) and is hard-deletable (deleteIdentityData).
//   - The gateway call below is deliberately NOT routed through
//     litellm.ts#_postChatCompletion: that helper interpolates the gateway's
//     error BODY into thrown Error messages (`LiteLLM chat/completions
//     failed: ${status} ${errBody}`), and provider error bodies can echo the
//     offending request content — i.e. the base64 images — straight into our
//     logs. The dedicated call here surfaces the HTTP status ONLY.

import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { supabase } from "./supabase.js";
import { appendEvent } from "./events-direct.js";
import { sessionRegistry } from "./registry.js";

export class ProctoringV2Error extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ProctoringV2Error";
  }
}

// ── Consent text (versioned) ─────────────────────────────────────────────────

/** Version stamp recorded alongside every consent decision (P6.1 "versioned
 *  consent recording"). Bump whenever CONSENT_TEXT changes so a recorded
 *  consent always identifies the exact text the candidate saw. */
export const CONSENT_TEXT_VERSION = "1";

/** Candidate-facing consent text — honest about exactly what is captured,
 *  what is derived, what is stored, and what declining means. DRAFT — counsel
 *  review required before any org enables the flag (see routes/proctoring.ts
 *  header). Served to the browser via the proctoring-config endpoint so the
 *  candidate sees exactly the version the server records. */
export const CONSENT_TEXT =
  "This assessment uses enhanced proctoring. If you consent, we will ask you " +
  "to photograph a government ID and take a selfie to verify your identity, " +
  "and your webcam will periodically check that you remain present during the " +
  "session. Identity images are processed immediately and are not stored — " +
  "only the verification result (a match confidence and a verified yes/no) is " +
  "kept. Webcam frames never leave your browser; only derived presence " +
  "signals (e.g. “no one visible”) are recorded. These signals are shown to " +
  "reviewers as context and never change your competency score. If you " +
  "decline, the session continues with standard passive checks only (tab " +
  "focus, paste bursts, idle gaps) — no webcam, no ID capture.";

// ── Org flag ─────────────────────────────────────────────────────────────────

/** Pure flag read (testable without I/O): absent / malformed settings —
 *  including a pre-jsonb or foreign shape — are FALSE. Only the literal
 *  boolean `true` enables v2. */
export function proctoringV2EnabledFromSettings(settings: unknown): boolean {
  return (
    typeof settings === "object" &&
    settings !== null &&
    (settings as Record<string, unknown>)["proctoring_v2_enabled"] === true
  );
}

/** Org-scoped dormancy gate: orgs.settings.proctoring_v2_enabled === true. */
export function isProctoringV2Enabled(
  org: { settings?: unknown } | null | undefined,
): boolean {
  return proctoringV2EnabledFromSettings(org?.settings);
}

// ── identity_checks helpers ──────────────────────────────────────────────────

/** Wire decisions (browser contract, lib/proctoring.ts) vs the DB CHECK
 *  values ('accept' | 'decline', migration 0024). */
export type ConsentDecision = "accepted" | "declined";
const DB_DECISION: Record<ConsentDecision, "accept" | "decline"> = {
  accepted: "accept",
  declined: "decline",
};

/** Is this error "identity_checks doesn't exist yet" (0024 not applied)?
 *  PostgREST surfaces that as 42P01 or PGRST205 — same latch pattern as
 *  services/orgs.ts. */
function isMissingIdentityTable(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "PGRST205") return true;
  return /identity_checks.*does not exist|Could not find the table.*identity_checks/i.test(err.message ?? "");
}

interface IdentityCheckRow {
  id: string;
  session_id: string;
  org_id: string;
  consent_text_version: string;
  consented_at: string;
  decision: "accept" | "decline";
  match_confidence: number | string | null;
  verified: boolean | null;
}

/** Latest identity_checks row for a session; null when none / pre-0024. */
async function readIdentityRow(sessionId: string): Promise<IdentityCheckRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("identity_checks")
    .select("id, session_id, org_id, consent_text_version, consented_at, decision, match_confidence, verified")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingIdentityTable(error)) return null; // pre-0024 — dormant
    throw new ProctoringV2Error(`identity_checks read failed: ${error.message}`);
  }
  return (data as unknown as IdentityCheckRow) ?? null;
}

// ── Consent recording (P6.1) ─────────────────────────────────────────────────

/**
 * Record the candidate's consent decision: one identity_checks row per
 * session plus an `identity.consent` event on the append-only stream.
 * Idempotent-ish: a session that already has a consent recording keeps its
 * FIRST decision (a tab refresh re-posting can't flip a recorded decline to
 * accept, or double-insert). Returns the effective recorded decision.
 *
 * `consentTextVersion` is the version the BROWSER says the candidate saw
 * (it renders exactly what the config endpoint served) — recorded as-is so
 * the row always matches the displayed text even across a deploy boundary.
 */
export async function recordConsent(
  sessionId: string,
  org: { id: string },
  decision: ConsentDecision,
  consentTextVersion: string = CONSENT_TEXT_VERSION,
): Promise<{ recorded: boolean; decision: ConsentDecision }> {
  if (!supabase) return { recorded: false, decision };

  const existing = await readIdentityRow(sessionId);
  if (existing) {
    return {
      recorded: true,
      decision: existing.decision === "accept" ? "accepted" : "declined",
    };
  }

  const { error } = await supabase.from("identity_checks").insert({
    id: randomUUID(),
    session_id: sessionId,
    org_id: org.id,
    consent_text_version: consentTextVersion,
    consented_at: new Date().toISOString(),
    decision: DB_DECISION[decision],
  });
  if (error) {
    if (isMissingIdentityTable(error)) return { recorded: false, decision }; // pre-0024
    throw new ProctoringV2Error(`consent insert failed: ${error.message}`);
  }

  // Append-only audit event (recruiter timeline + SuspicionPanel fallback).
  // Wire-format decision ("accepted"/"declined") — the shape the panel reads.
  await appendEvent(sessionId, "identity.consent", "candidate", {
    decision,
    consent_text_version: consentTextVersion,
  });

  return { recorded: true, decision };
}

/** Does this session have a recorded ACCEPT consent? (Hard gate for
 *  identity-verify: no accepted consent on record → no biometric processing.) */
export async function hasAcceptedConsent(sessionId: string): Promise<boolean> {
  const row = await readIdentityRow(sessionId);
  return row?.decision === "accept";
}

// ── Identity verification (P6.2) ─────────────────────────────────────────────

/** verified = confidence >= this. Calibration-pending like the suspicion
 *  weights; informational either way (a failed match never blocks a session). */
export const MATCH_CONFIDENCE_THRESHOLD = 0.8;

/** Compare two images (data-URL JPEGs) and return a same-person confidence in
 *  [0,1]. Injectable so verify-identity-verify.ts can mock the gateway. */
export type IdentityCompareFn = (
  idImage: string,
  selfieImage: string,
  sessionId: string,
) => Promise<number>;

/**
 * Default comparer: LiteLLM gateway vision call (Hard Rule 3 — models are
 * reached ONLY through LITELLM_BASE_URL; provider keys live on the gateway).
 * Authenticates with the session's own minted key so the call is bounded by
 * the session budget like every other model call in the session.
 *
 * The images exist only in this request body — never logged, never stored.
 * On a non-OK response we surface the STATUS ONLY (never the response body,
 * which can echo the request payload — see file header).
 */
export const gatewayVisionCompare: IdentityCompareFn = async (
  idImage,
  selfieImage,
  sessionId,
) => {
  const entry = sessionRegistry.get(sessionId);
  const sessionKey = entry?.litellmKey;
  if (!sessionKey) {
    throw new ProctoringV2Error("session not live — no session key for the vision call");
  }

  const res = await fetch(`${env.LITELLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionKey}`, // session key — never the master key
    },
    body: JSON.stringify({
      model: "gemini-flash",
      response_format: { type: "json_object" },
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "You are verifying a test-taker's identity. The first image is a " +
                "photo of a government ID; the second is a live selfie. Estimate " +
                "the probability that the person on the ID and the person in the " +
                "selfie are the SAME person. Consider face shape, features, and " +
                "obvious mismatches; be conservative when either image is " +
                "unreadable or contains no face (low confidence). Respond with " +
                'ONLY this JSON: {"same_person_confidence": <number 0..1>}',
            },
            { type: "image_url", image_url: { url: idImage } },
            { type: "image_url", image_url: { url: selfieImage } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    // STATUS ONLY — never the body (it can echo the images; see header).
    throw new ProctoringV2Error(`gateway vision call failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  let conf: unknown;
  try {
    conf = (JSON.parse(text) as Record<string, unknown>)["same_person_confidence"];
  } catch {
    throw new ProctoringV2Error("gateway vision call returned non-JSON content");
  }
  if (typeof conf !== "number" || !Number.isFinite(conf)) {
    throw new ProctoringV2Error("gateway vision call returned no numeric confidence");
  }
  return Math.max(0, Math.min(1, conf));
};

export interface IdentityVerifyResult {
  verified: boolean;
  matchConfidence: number;
}

/**
 * Compare the candidate's ID photo + selfie and store the DERIVED result on
 * the session's identity_checks row (+ an `identity.verified` event).
 *
 * The raw images pass through IN MEMORY ONLY (see file header) — nothing in
 * this function persists or logs them; `compare` receives them and they are
 * dropped when the request ends.
 */
export async function verifyIdentity(
  sessionId: string,
  org: { id: string },
  idImage: string,
  selfieImage: string,
  compare: IdentityCompareFn = gatewayVisionCompare,
): Promise<IdentityVerifyResult> {
  if (!supabase) throw new ProctoringV2Error("Supabase unavailable");

  // Re-check the hard gate at the service layer (the route checks it too):
  // no ACCEPTED consent on record → no biometric processing, period.
  const row = await readIdentityRow(sessionId);
  if (!row || row.decision !== "accept") {
    throw new ProctoringV2Error("no accepted consent on record for this session");
  }

  const matchConfidence = await compare(idImage, selfieImage, sessionId);
  const verified = matchConfidence >= MATCH_CONFIDENCE_THRESHOLD;

  const { error } = await supabase
    .from("identity_checks")
    .update({ match_confidence: matchConfidence, verified })
    .eq("id", row.id);
  if (error) {
    throw new ProctoringV2Error(`identity_checks update failed: ${error.message}`);
  }

  // Derived result only — never the images.
  await appendEvent(sessionId, "identity.verified", "system", {
    verified,
    match_confidence: matchConfidence,
  });

  return { verified, matchConfidence };
}

// ── Review surface (P6 + SuspicionPanel contract) ────────────────────────────

/** Shape the web SuspicionPanel expects on the suspicion route (`identity`
 *  key — apps/web/src/lib/api.ts parseSuspicionIdentity). */
export interface IdentityStatus {
  consent: ConsentDecision | null;
  verified: boolean | null;
  matchConfidence: number | null;
}

/** Recruiter-only identity status from identity_checks. Null when nothing is
 *  recorded (every v1 session — the dormant default) or pre-0024. */
export async function readIdentityStatus(sessionId: string): Promise<IdentityStatus | null> {
  let row: IdentityCheckRow | null;
  try {
    row = await readIdentityRow(sessionId);
  } catch {
    return null; // review surface degrades to "no identity block", never a 500
  }
  if (!row) return null;
  const conf = row.match_confidence === null ? null : Number(row.match_confidence);
  return {
    consent: row.decision === "accept" ? "accepted" : "declined",
    verified: row.verified,
    matchConfidence: conf !== null && Number.isFinite(conf) ? conf : null,
  };
}

// ── Deletion path (P6.4 — biometric minimization) ────────────────────────────

/**
 * Hard-delete a session's identity data (org-scoped). Raw frames were never
 * stored, so deleting the identity_checks rows removes everything derived
 * from biometric processing that lives outside the append-only events stream
 * (which itself holds only the consent decision + verified boolean/confidence
 * — no imagery). Partner orgs can delete only their own rows; the admin org
 * (asaya) can delete any — same scoping model as services/orgs.ts.
 *
 * Returns the number of rows removed (0 = nothing there OR foreign org — a
 * non-owner learns nothing about whether the session exists).
 */
export async function deleteIdentityData(
  sessionId: string,
  org: { id: string; role?: "admin" | "partner" } | undefined,
): Promise<number> {
  if (!supabase) throw new ProctoringV2Error("Supabase unavailable");

  let del = supabase
    .from("identity_checks")
    .delete()
    .eq("session_id", sessionId);
  if (org && org.role !== "admin") {
    del = del.eq("org_id", org.id);
  }
  const { data, error } = await del.select("id");
  if (error) {
    if (isMissingIdentityTable(error)) return 0; // pre-0024 — nothing to delete
    throw new ProctoringV2Error(`identity_checks delete failed: ${error.message}`);
  }
  return (data ?? []).length;
}
