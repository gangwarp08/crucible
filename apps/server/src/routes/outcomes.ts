// L6 outcome ingestion (Slice 5.5) — the partner outcome webhook + read-back.
//
// POST /api/outcomes accepts a single real-world outcome for a candidate/session
// from a design partner. It is NOT session-scoped, so it can't use the per-
// session JWT; instead it authenticates with a bearer secret:
//
//   P2 (preferred): the PER-ORG webhook secret (orgs.webhook_secret_hash) —
//     the outcome is stamped with the resolved org's id, so partner A can
//     never post outcomes attributed to partner B.
//   Legacy: the global env.OUTCOMES_WEBHOOK_SECRET, attributed to the default
//     'asaya' org. DEPRECATE after partners migrate to per-org secrets.
//
// When neither auth path matches the request is 401 — an unconfigured deploy
// still can't take unauthenticated writes.
//
// GET /api/outcomes/correlation/:outcomeType returns the score↔outcome
// correlation for recruiter/debug inspection. It is org-authenticated too
// (X-Org-Key or Bearer webhook secret; ORG_AUTH_REQUIRED back-compat applies)
// and partner orgs only ever see their own outcomes. Both run service-role
// only.

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../env.js";
import { supabase } from "../services/supabase.js";
import {
  OutcomeInputSchema,
  OUTCOME_TYPES,
  insertOutcome,
  correlateOutcomes,
  assertSessionVisibleToOrg,
  OutcomesError,
} from "../services/outcomes.js";
import {
  resolveOrgByApiKey,
  resolveOrgByWebhookSecret,
  getDefaultOrg,
  type OrgRow,
} from "../services/orgs.js";
import {
  resolveInvite,
  submitInvite,
  OutcomeInviteError,
} from "../services/outcome-invites.js";

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const provided = header.slice("Bearer ".length);
  return provided.length > 0 ? provided : null;
}

/** Constant-time check against the LEGACY global secret. */
function matchesLegacySecret(provided: string): boolean {
  const secret = env.OUTCOMES_WEBHOOK_SECRET;
  if (!secret) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve the attributing org for a webhook bearer. Per-org secret first;
 * legacy global secret falls back to the default org (null org only on a
 * pre-0018 database where the orgs table doesn't exist yet). Returns
 * `unauthorized` when neither path matches — fail closed.
 */
async function resolveWebhookOrg(
  request: FastifyRequest,
): Promise<{ ok: true; org: OrgRow | null } | { ok: false }> {
  const provided = bearerOf(request);
  if (!provided) return { ok: false };

  try {
    const org = await resolveOrgByWebhookSecret(provided);
    if (org) return { ok: true, org };
  } catch (err) {
    // orgs table absent (0018 not applied) or transient read failure — fall
    // through to the legacy secret rather than hard-failing ingestion.
    request.log.warn({ err }, "[outcomes] per-org secret resolution unavailable");
  }

  if (matchesLegacySecret(provided)) {
    return { ok: true, org: await getDefaultOrg() };
  }
  return { ok: false };
}

/**
 * P2 auth for the correlation READ: accepts either credential the P2 seam
 * issues — an X-Org-Key header (the /api/review credential) or a Bearer
 * webhook secret (the ingestion credential, incl. the legacy global secret).
 * No credentials → 401 when ORG_AUTH_REQUIRED, else the review routes'
 * back-compat fallback: resolve to the default 'asaya' org (null only on a
 * pre-0018 database → legacy unscoped behavior).
 */
async function resolveReadOrg(
  request: FastifyRequest,
): Promise<
  | { ok: true; org: OrgRow | null }
  | { ok: false; status: 401 | 503 }
> {
  const keyHeader = request.headers["x-org-key"];
  const rawKey = typeof keyHeader === "string" ? keyHeader.trim() : "";
  if (rawKey) {
    try {
      const org = await resolveOrgByApiKey(rawKey);
      return org ? { ok: true, org } : { ok: false, status: 401 };
    } catch (err) {
      request.log.error({ err }, "[outcomes] api-key resolution failed");
      return { ok: false, status: 503 };
    }
  }

  if (bearerOf(request)) {
    const auth = await resolveWebhookOrg(request);
    return auth.ok ? { ok: true, org: auth.org } : { ok: false, status: 401 };
  }

  if ((env.ORG_AUTH_REQUIRED ?? "").toLowerCase() === "true") {
    return { ok: false, status: 401 };
  }
  return { ok: true, org: await getDefaultOrg() };
}

const CorrelationParams = z.object({ outcomeType: z.enum(OUTCOME_TYPES) });
const CorrelationQuery = z.object({ competency: z.string().min(1).optional() });

export async function outcomesRoutes(server: FastifyInstance) {
  if (!supabase) {
    server.log.warn("[outcomes] supabase client unavailable — /api/outcomes routes will 503");
  }
  if (!env.OUTCOMES_WEBHOOK_SECRET) {
    server.log.warn(
      "[outcomes] OUTCOMES_WEBHOOK_SECRET unset — POST /api/outcomes accepts per-org webhook secrets only",
    );
  }

  // ─── Ingest one outcome (partner webhook) ────────────────────────────────
  server.post("/outcomes", async (request, reply) => {
    if (!supabase) return reply.status(503).send({ error: "Supabase unavailable" });
    const auth = await resolveWebhookOrg(request);
    if (!auth.ok) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const parsed = OutcomeInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid outcome", details: parsed.error.flatten() });
    }

    try {
      // P2: a referenced session must BELONG to the authenticated org (admin
      // bypasses). Missing and foreign sessions raise the identical
      // "session ... not found" 400 — no cross-tenant existence oracle.
      if (parsed.data.session_id) {
        await assertSessionVisibleToOrg(parsed.data.session_id, auth.org);
      }
      // P2: stamp the outcome with the AUTHENTICATED org — never a
      // caller-supplied org — so cross-tenant attribution is impossible.
      const outcome = await insertOutcome(parsed.data, "webhook", auth.org?.id ?? null);
      return reply.status(201).send({ outcome });
    } catch (err) {
      if (err instanceof OutcomesError) {
        // A bad session_id is a client error; everything else is a 500.
        const isClient = /not found/.test(err.message);
        return reply.status(isClient ? 400 : 500).send({ error: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(`[outcomes] insert failed: ${message}`);
      return reply.status(500).send({ error: "Outcome insert failed" });
    }
  });

  // ─── Read-back: score ↔ outcome correlation ──────────────────────────────
  // P2: org-authenticated (X-Org-Key or Bearer webhook secret) and org-scoped —
  // the pairs expose candidate_ref/session_id/scores, so a partner must only
  // ever see its own outcomes. Admin (asaya) correlates across all tenants.
  server.get("/outcomes/correlation/:outcomeType", async (request, reply) => {
    if (!supabase) return reply.status(503).send({ error: "Supabase unavailable" });
    const auth = await resolveReadOrg(request);
    if (!auth.ok) {
      return reply
        .status(auth.status)
        .send({ error: auth.status === 401 ? "Unauthorized" : "org_auth_unavailable" });
    }
    const p = CorrelationParams.safeParse(request.params);
    if (!p.success) {
      return reply.status(400).send({ error: "Unknown outcome_type" });
    }
    const q = CorrelationQuery.safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: "Invalid query" });
    }
    try {
      // Partner orgs are scoped to their own outcomes; admin (and the
      // pre-0018 null org) stay unscoped.
      const scopeOrgId = auth.org && auth.org.role !== "admin" ? auth.org.id : null;
      const result = await correlateOutcomes(
        p.data.outcomeType,
        q.data.competency ?? null,
        null,
        scopeOrgId,
      );
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(`[outcomes] correlation failed: ${message}`);
      return reply.status(500).send({ error: "Correlation failed" });
    }
  });

  // ─── Partner invite flow (token-gated; the token is the auth) ────────────
  // The partner opens <web>/feedback/<token>; the page calls these. No account,
  // no shared secret — possession of a valid, unexpired, unused token is the
  // entire authorization.
  const TokenParam = z.object({ token: z.string().min(20).max(200) });

  server.get("/outcome-invites/:token", async (request, reply) => {
    if (!supabase) return reply.status(503).send({ error: "Supabase unavailable" });
    const p = TokenParam.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: "Invalid link" });
    try {
      const ctx = await resolveInvite(p.data.token);
      return reply.send(ctx);
    } catch (err) {
      if (err instanceof OutcomeInviteError) {
        return reply.status(404).send({ error: "This feedback link is invalid or no longer exists." });
      }
      request.log.error(`[outcomes] invite resolve failed: ${err instanceof Error ? err.message : String(err)}`);
      return reply.status(500).send({ error: "Could not load link" });
    }
  });

  server.post("/outcome-invites/:token/submit", async (request, reply) => {
    if (!supabase) return reply.status(503).send({ error: "Supabase unavailable" });
    const p = TokenParam.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: "Invalid link" });
    const body = (request.body ?? {}) as { values?: Record<string, unknown>; candidate_ref?: string };
    if (!body.values || typeof body.values !== "object") {
      return reply.status(400).send({ error: "Missing outcome values" });
    }
    try {
      const result = await submitInvite(p.data.token, body.values, body.candidate_ref);
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof OutcomeInviteError) {
        const msg = err.message;
        // Expired/revoked/used/empty/invalid-values → client error; unknown → 404.
        const code = /invalid or unknown/.test(msg) ? 404 : 400;
        return reply.status(code).send({ error: msg });
      }
      request.log.error(`[outcomes] invite submit failed: ${err instanceof Error ? err.message : String(err)}`);
      return reply.status(500).send({ error: "Submission failed" });
    }
  });
}
