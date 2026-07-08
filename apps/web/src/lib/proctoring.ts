"use client";
// P6 (proctoring v2, DORMANT) — client plumbing for the consent gate,
// identity verification, and the per-session capture switch.
//
// DORMANCY CONTRACT (mirrors the server): everything here is inert unless
//   1. the candidate arrived via a session link (?link=…),  AND
//   2. that link's org has settings.proctoring_v2_enabled = true, AND
//   3. the candidate EXPLICITLY accepted the consent prompt, AND
//   4. the server successfully RECORDED that consent.
// Any failure anywhere degrades to v1 passive proctoring — never an error the
// candidate sees, never a webcam prompt, never a blocked session.

import { SERVER_URL, getSessionToken } from "./api";

// ── Config (pre-session, link-scoped) ────────────────────────────────────────

export interface ProctoringConfig {
  v2Enabled: true;
  consentText: string;
  consentTextVersion: string;
}

/** Resolve the proctoring tier for a session link BEFORE any session exists
 *  (GET /api/session-links/:token/proctoring-config). Returns a config object
 *  ONLY when v2 is enabled for the link's org and the payload is well-formed;
 *  null on disabled / unknown token / older server / any failure — the caller
 *  renders the ordinary v1 start screen in every null case. */
export async function getProctoringConfig(linkToken: string): Promise<ProctoringConfig | null> {
  try {
    const res = await fetch(
      `${SERVER_URL}/api/session-links/${encodeURIComponent(linkToken)}/proctoring-config`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      v2Enabled?: unknown; consentText?: unknown; consentTextVersion?: unknown;
    };
    if (
      body.v2Enabled === true &&
      typeof body.consentText === "string" &&
      typeof body.consentTextVersion === "string"
    ) {
      return {
        v2Enabled: true,
        consentText: body.consentText,
        consentTextVersion: body.consentTextVersion,
      };
    }
    return null;
  } catch {
    return null; // fail closed to v1 — dormancy over diagnostics here
  }
}

// ── Consent recording (post-session-creation, pre-workspace) ────────────────

export type ConsentDecision = "accepted" | "declined";

/** Record the candidate's consent decision (POST /sessions/:id/consent) with
 *  the version of the text they actually saw. Returns true only when the
 *  server confirmed the recording — the caller must treat false as "consent
 *  not on record" and keep all capture OFF (hard gate: no recorded consent →
 *  no webcam, no identity step). Never throws. */
export async function postProctoringConsent(
  sessionId: string,
  decision: ConsentDecision,
  consentTextVersion: string,
): Promise<boolean> {
  try {
    const token = getSessionToken(sessionId);
    const res = await fetch(`${SERVER_URL}/sessions/${sessionId}/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ decision, consentTextVersion }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Identity verification (ID photo + selfie, candidate-initiated) ──────────

export interface IdentityVerifyResult {
  verified: boolean;
  /** 0–1 match confidence when the server provides one. */
  matchConfidence: number | null;
}

/** Submit the two identity images the candidate explicitly captured
 *  (POST /sessions/:id/identity-verify). These are the ONLY frames that ever
 *  leave the browser; the server processes them ephemerally and stores only
 *  the derived result. Returns null on any failure — identity verification is
 *  informational and never blocks the session. Never throws. */
export async function postIdentityVerify(
  sessionId: string,
  images: { idImage: string; selfieImage: string }, // JPEG data URLs
): Promise<IdentityVerifyResult | null> {
  try {
    const token = getSessionToken(sessionId);
    const res = await fetch(`${SERVER_URL}/sessions/${sessionId}/identity-verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(images),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { verified?: unknown; matchConfidence?: unknown };
    if (typeof body.verified !== "boolean") return null;
    return {
      verified: body.verified,
      matchConfidence: typeof body.matchConfidence === "number" ? body.matchConfidence : null,
    };
  } catch {
    return null;
  }
}

// ── Per-session capture switch ───────────────────────────────────────────────
// Set ONLY after the server confirmed an "accepted" consent recording; read by
// useWebcamPresence before it ever touches getUserMedia. sessionStorage (same
// posture as the session token): survives a tab refresh mid-session, dies with
// the tab. Absent key = capture OFF — which is the state for every session
// that never saw a consent prompt (the entire dormant default).

const CONSENT_KEY_PREFIX = "crucible.proctoring.v2.";

export function markProctoringV2Accepted(sessionId: string): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(`${CONSENT_KEY_PREFIX}${sessionId}`, "accepted"); } catch { /* ignore */ }
}

export function isProctoringV2Accepted(sessionId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(`${CONSENT_KEY_PREFIX}${sessionId}`) === "accepted";
  } catch {
    return false;
  }
}
