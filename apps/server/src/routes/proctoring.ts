// P6 (proctoring v2, DORMANT) — proctoring HTTP surface.
//
//   GET  /api/session-links/:token/proctoring-config    (pre-session, link-scoped)
//   POST /sessions/:id/consent                          (session-token guarded)
//   POST /sessions/:id/identity-verify                  (session-token guarded)
//   POST /api/review/sessions/:id/identity-delete       (org-key guarded)
//
// The consent gate must render BEFORE the session starts, but the proctoring
// tier is an ORG decision (orgs.settings.proctoring_v2_enabled) and no session
// exists yet on the start screen. A candidate arriving via a single-use
// session link (?link=…) carries the org implicitly: link → org_id → settings.
// The config endpoint resolves exactly that and nothing else.
//
// DORMANCY (hard): `proctoring_v2_enabled` lives in orgs.settings jsonb and
// defaults to ABSENT = false. Every failure path — unknown token, missing
// Supabase, org read error, pre-migration schema — fails CLOSED to
// { v2Enabled: false }, i.e. v1 passive proctoring. When the flag is off the
// browser renders no consent prompt and runs no capture code, and the consent
// / identity-verify endpoints below refuse with 403.
//
// ⚠ COUNSEL GATE (operational, not code): the consent text (see
// services/proctoring-v2.ts) is a DRAFT. Biometric + government-ID capture
// (BIPA / GDPR-class data) requires counsel sign-off on the consent language
// and data-handling for the target jurisdiction BEFORE any org sets
// proctoring_v2_enabled=true. Enabling the flag without that review is an
// operational-policy violation, not a code path this server can detect.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { supabase } from "../services/supabase.js";
import { requireSessionToken } from "../services/session-token.js";
import { requireOrg } from "../services/orgs.js";
import {
  CONSENT_TEXT,
  CONSENT_TEXT_VERSION,
  proctoringV2EnabledFromSettings,
  isProctoringV2Enabled,
  recordConsent,
  hasAcceptedConsent,
  verifyIdentity,
  deleteIdentityData,
  ProctoringV2Error,
} from "../services/proctoring-v2.js";

// Back-compat aliases (the config endpoint predates services/proctoring-v2.ts;
// the constants now live there as the single source of truth).
export const PROCTORING_CONSENT_TEXT_VERSION = CONSENT_TEXT_VERSION;
export const PROCTORING_CONSENT_TEXT = CONSENT_TEXT;
export { proctoringV2EnabledFromSettings };

const TokenParamsSchema = z.object({
  // base64url session-link tokens are 43 chars; allow headroom, reject junk.
  token: z.string().min(8).max(200),
});

const IdParamsSchema = z.object({ id: z.string().uuid() });

/** Response shape shared with the web client (lib/proctoring.ts). */
export interface ProctoringConfigResponse {
  v2Enabled: boolean;
  consentText?: string;
  consentTextVersion?: string;
}

const DISABLED: ProctoringConfigResponse = { v2Enabled: false };

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Resolve the org row (id + settings) that owns a session — the per-session
 *  dormancy gate for the consent / identity-verify endpoints. Fails CLOSED:
 *  any miss (no Supabase, unknown session, pre-0018 schema, org read error)
 *  returns null, which the callers turn into a 403 refusal. */
async function orgForSession(
  sessionId: string,
): Promise<{ id: string; settings: unknown } | null> {
  if (!supabase) return null;
  const { data: sess, error: sessErr } = await supabase
    .from("sessions")
    .select("org_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessErr) return null;
  const orgId = (sess as { org_id?: string | null } | null)?.org_id;
  if (!orgId) return null;
  const { data: org, error: orgErr } = await supabase
    .from("orgs")
    .select("id, settings")
    .eq("id", orgId)
    .eq("status", "active")
    .maybeSingle();
  if (orgErr) return null;
  return (org as { id: string; settings: unknown } | null) ?? null;
}

// ── Consent body (browser contract — lib/proctoring.ts) ─────────────────────
const ConsentBodySchema = z.object({
  decision: z.enum(["accepted", "declined"]),
  // The version of the consent text the candidate actually saw (served by the
  // config endpoint). Optional for wire-tolerance; defaults server-side.
  consentTextVersion: z.string().min(1).max(100).optional(),
});

// ── Identity-verify body (two data-URL JPEGs, ≤2MB each) ────────────────────
// The client downscales to stay well under this; the cap bounds worst-case
// memory for the in-memory-only handling (nothing here is ever persisted).
const MAX_IMAGE_CHARS = 2 * 1024 * 1024;
const dataUrlImage = z
  .string()
  .min(32)
  .max(MAX_IMAGE_CHARS)
  .regex(/^data:image\/(jpeg|png|webp);base64,/, "must be a base64 image data URL");
const IdentityVerifyBodySchema = z.object({
  idImage: dataUrlImage,
  selfieImage: dataUrlImage,
});

export async function proctoringRoutes(server: FastifyInstance) {
  // ── GET /api/session-links/:token/proctoring-config ───────────────────────
  server.get<{ Params: { token: string } }>(
    "/api/session-links/:token/proctoring-config",
    // Unauthenticated (token-bearing) endpoint → keep it un-enumerable and
    // cheap: modest rate limit, constant-shape response on every miss.
    //
    // KNOWN EXPOSURE (review LOW, accepted): the link token rides in the URL
    // PATH here, so it can land in server/proxy access logs and browser
    // history — unlike POST /sessions, which carries it in the body. Risk is
    // bounded: the token is single-use for session creation, this endpoint
    // reveals only { v2Enabled } for the owning org (no link metadata), and
    // our own logging doesn't record full request URLs for this route's
    // responses. Moving it to a POST body would break the deployed web
    // client's GET contract — revisit if tokens ever become long-lived.
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = TokenParamsSchema.safeParse(request.params);
      if (!parsed.success) return reply.send(DISABLED);

      if (!supabase) {
        request.log.warn("[proctoring] config lookup with no Supabase client — answering dormant");
        return reply.send(DISABLED);
      }

      try {
        // Link → owning org. Status is deliberately NOT checked here: this
        // endpoint reveals only the org's proctoring tier, and the link's
        // single-use/expiry enforcement stays where it belongs (POST /sessions).
        const { data: link, error: linkErr } = await supabase
          .from("session_links")
          .select("org_id")
          .eq("token_hash", sha256(parsed.data.token))
          .maybeSingle();
        if (linkErr) {
          request.log.warn({ err: linkErr.message }, "[proctoring] session_link read failed — answering dormant");
          return reply.send(DISABLED);
        }
        const orgId = (link as { org_id?: string | null } | null)?.org_id;
        if (!orgId) return reply.send(DISABLED); // unknown token or pre-0018 link

        const { data: org, error: orgErr } = await supabase
          .from("orgs")
          .select("settings")
          .eq("id", orgId)
          .eq("status", "active")
          .maybeSingle();
        if (orgErr) {
          request.log.warn({ err: orgErr.message }, "[proctoring] org settings read failed — answering dormant");
          return reply.send(DISABLED);
        }

        if (!proctoringV2EnabledFromSettings((org as { settings?: unknown } | null)?.settings)) {
          return reply.send(DISABLED);
        }

        const enabled: ProctoringConfigResponse = {
          v2Enabled: true,
          consentText: CONSENT_TEXT,
          consentTextVersion: CONSENT_TEXT_VERSION,
        };
        return reply.send(enabled);
      } catch (err) {
        // Fail CLOSED to the dormant tier — a broken lookup must never turn
        // into a consent prompt (or block a start screen). Logged, not thrown.
        request.log.error({ err }, "[proctoring] config lookup failed — answering dormant");
        return reply.send(DISABLED);
      }
    },
  );

  const requireToken = requireSessionToken(
    (req) => (req.params as { id?: string }).id,
  );

  // ── POST /sessions/:id/consent (P6.1) ──────────────────────────────────────
  // Records the candidate's decision with the consent-text version they saw.
  // 403 unless the session's org has the v2 flag on — with the flag off (the
  // dormant default) NOTHING is recorded, matching "no capture when off".
  // A DECLINE is recorded and that's the end of v2 for the session (signed-off
  // policy: decline → downgrade to v1 passive; identity-verify refuses below).
  server.post<{ Params: { id: string } }>(
    "/sessions/:id/consent",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      preHandler: [requireToken],
    },
    async (request, reply) => {
      const idParse = IdParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({ error: "Invalid session id (must be uuid)" });
      }
      const bodyParse = ConsentBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ error: bodyParse.error.flatten() });
      }
      const sessionId = idParse.data.id;

      const org = await orgForSession(sessionId);
      if (!isProctoringV2Enabled(org)) {
        return reply.status(403).send({ error: "proctoring_v2_disabled" });
      }

      try {
        const result = await recordConsent(
          sessionId,
          org!,
          bodyParse.data.decision,
          bodyParse.data.consentTextVersion ?? CONSENT_TEXT_VERSION,
        );
        if (!result.recorded) {
          // Pre-0024 schema (or no Supabase): nothing recorded → the browser
          // must keep capture OFF, so this cannot be a 2xx.
          return reply.status(503).send({ error: "consent_not_recorded" });
        }
        return reply.send({ recorded: true, decision: result.decision });
      } catch (err) {
        request.log.error(
          { err, sessionId },
          "[proctoring] consent recording failed",
        );
        return reply.status(500).send({ error: "consent_not_recorded" });
      }
    },
  );

  // ── POST /sessions/:id/identity-verify (P6.2) ──────────────────────────────
  // The ONLY place raw identity images ever touch the server — and they are
  // handled IN MEMORY ONLY (services/proctoring-v2.ts): compared through the
  // LiteLLM gateway, derived result stored, raws discarded with the request.
  // NEVER log request.body on this route.
  server.post<{ Params: { id: string } }>(
    "/sessions/:id/identity-verify",
    {
      config: { rateLimit: { max: 3, timeWindow: "1 minute" } }, // vision calls cost real money
      bodyLimit: 5 * 1024 * 1024, // two ≤2MB data URLs + JSON overhead
      preHandler: [requireToken],
    },
    async (request, reply) => {
      const idParse = IdParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({ error: "Invalid session id (must be uuid)" });
      }
      const sessionId = idParse.data.id;

      // Gate 1: org flag on. Gate 2: an ACCEPTED consent on record (a decline
      // — or no decision — means no biometric processing, hard stop).
      const org = await orgForSession(sessionId);
      if (!isProctoringV2Enabled(org)) {
        return reply.status(403).send({ error: "proctoring_v2_disabled" });
      }
      let accepted = false;
      try {
        accepted = await hasAcceptedConsent(sessionId);
      } catch (err) {
        request.log.error({ err, sessionId }, "[proctoring] consent lookup failed");
        return reply.status(500).send({ error: "identity_verify_failed" });
      }
      if (!accepted) {
        return reply.status(403).send({ error: "consent_required" });
      }

      const bodyParse = IdentityVerifyBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        // Zod flatten only — never echo the (image-bearing) body back.
        return reply.status(400).send({
          error: "invalid_images",
          detail: bodyParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }

      try {
        const result = await verifyIdentity(
          sessionId,
          org!,
          bodyParse.data.idImage,
          bodyParse.data.selfieImage,
        );
        return reply.send({
          verified: result.verified,
          matchConfidence: result.matchConfidence,
        });
      } catch (err) {
        // Message only (ProctoringV2Error messages carry status codes, never
        // payloads) — the browser treats any failure as informational-null.
        const msg = err instanceof ProctoringV2Error ? err.message : "identity_verify_failed";
        request.log.error({ err: msg, sessionId }, "[proctoring] identity verify failed");
        return reply.status(502).send({ error: "identity_verify_failed" });
      }
    },
  );

  // ── POST /api/review/sessions/:id/identity-delete (P6.4) ───────────────────
  // Org-guarded hard deletion of a session's stored identity data (biometric
  // minimization / delete-on-request). Same auth posture as routes/review.ts
  // (requireOrg: X-Org-Key → org; scoping in deleteIdentityData — partner
  // orgs delete only their own rows, so a foreign org deletes nothing and
  // learns nothing). Full path spelled out because this plugin is registered
  // without a prefix.
  server.post<{ Params: { id: string } }>(
    "/api/review/sessions/:id/identity-delete",
    { preHandler: [requireOrg] },
    async (request, reply) => {
      const idParse = IdParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({ error: "Invalid session id (must be uuid)" });
      }
      try {
        const deleted = await deleteIdentityData(idParse.data.id, request.org);
        return reply.send({ deleted });
      } catch (err) {
        request.log.error({ err, id: idParse.data.id }, "[proctoring] identity delete failed");
        return reply.status(500).send({ error: "identity_delete_failed" });
      }
    },
  );
}
