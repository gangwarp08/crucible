// Verification pipeline (slice V9) — BGV (claims verification) HTTP surface.
//
//   POST /api/review/bgv-checks        (org-key guarded; request a check)
//   GET  /api/review/bgv-checks/:id    (org-key guarded; read one)
//   POST /api/bgv/webhook/:provider    (bearer-secret guarded; vendor results)
//
// Registered without a prefix — full paths spelled out (same posture as
// routes/proctoring.ts). Org gate: requests require the org flag
// settings.bgv_enabled (default absent = false) so no org accrues vendor
// spend without opting in; the stub provider is free but the gate keeps the
// semantics identical when a real vendor lands.
//
// Webhook auth: constant-time bearer compare against BGV_WEBHOOK_SECRET
// (same pattern as the outcomes webhook). Secret unset = webhook disabled
// (503) — an unconfigured deploy can't accept unauthenticated result writes.

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../env.js";
import { supabase } from "../services/supabase.js";
import { requireOrg } from "../services/orgs.js";
import {
  requestBgvCheck,
  readBgvCheck,
  applyBgvWebhook,
  BgvError,
  BgvProviderError,
} from "../services/bgv/index.js";

const RequestBodySchema = z.object({
  candidateLabel: z.string().min(1).max(120),
  checks: z.array(z.enum(["employment", "education"])).min(1).max(4),
  sessionLinkId: z.string().uuid().optional(),
});

const IdParamsSchema = z.object({ id: z.string().uuid() });
const ProviderParamsSchema = z.object({ provider: z.string().min(1).max(40) });

function bgvEnabledFromSettings(settings: unknown): boolean {
  return (
    typeof settings === "object" &&
    settings !== null &&
    (settings as Record<string, unknown>)["bgv_enabled"] === true
  );
}

function webhookAuthorized(request: FastifyRequest): boolean {
  const secret = env.BGV_WEBHOOK_SECRET;
  if (!secret) return false;
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function bgvRoutes(server: FastifyInstance) {
  // ── POST /api/review/bgv-checks ────────────────────────────────────────────
  server.post(
    "/api/review/bgv-checks",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      preHandler: [requireOrg],
    },
    async (request, reply) => {
      const org = request.org;
      if (!org) return reply.status(401).send({ error: "org_required" });
      if (!supabase) return reply.status(503).send({ error: "Supabase unavailable" });

      // Org opt-in gate (settings.bgv_enabled) — read fresh, fail closed.
      const { data: orgRow, error: orgErr } = await supabase
        .from("orgs")
        .select("settings")
        .eq("id", org.id)
        .maybeSingle();
      if (orgErr || !bgvEnabledFromSettings((orgRow as { settings?: unknown } | null)?.settings)) {
        return reply.status(403).send({ error: "bgv_disabled" });
      }

      const parsed = RequestBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      try {
        const row = await requestBgvCheck(
          org.id,
          { candidateLabel: parsed.data.candidateLabel, checks: parsed.data.checks },
          parsed.data.sessionLinkId ?? null,
        );
        return reply.status(201).send({ check: row });
      } catch (err) {
        const msg = err instanceof BgvError || err instanceof BgvProviderError ? err.message : "bgv_request_failed";
        request.log.error({ err: msg }, "[bgv] request failed");
        return reply.status(502).send({ error: "bgv_request_failed" });
      }
    },
  );

  // ── GET /api/review/bgv-checks/:id ─────────────────────────────────────────
  server.get<{ Params: { id: string } }>(
    "/api/review/bgv-checks/:id",
    { preHandler: [requireOrg] },
    async (request, reply) => {
      const idParse = IdParamsSchema.safeParse(request.params);
      if (!idParse.success) return reply.status(400).send({ error: "Invalid id" });
      const row = await readBgvCheck(idParse.data.id);
      // Org scoping: a foreign org's check reads as not-found (no existence leak).
      if (!row || (request.org && request.org.role !== "admin" && row.org_id !== request.org.id)) {
        return reply.status(404).send({ error: "not_found" });
      }
      return reply.send({ check: row });
    },
  );

  // ── POST /api/bgv/webhook/:provider ────────────────────────────────────────
  server.post<{ Params: { provider: string } }>(
    "/api/bgv/webhook/:provider",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!env.BGV_WEBHOOK_SECRET) {
        return reply.status(503).send({ error: "webhook_disabled" });
      }
      if (!webhookAuthorized(request)) {
        return reply.status(401).send({ error: "unauthorized" });
      }
      const providerParse = ProviderParamsSchema.safeParse(request.params);
      if (!providerParse.success) return reply.status(400).send({ error: "invalid_provider" });

      try {
        const matched = await applyBgvWebhook(providerParse.data.provider, request.body);
        // Unknown external_ref → 200 {matched:false}: vendors retry on non-2xx
        // and an unmatched ref is terminal, not transient.
        return reply.send({ matched });
      } catch (err) {
        if (err instanceof BgvProviderError) {
          return reply.status(400).send({ error: "unparseable_webhook" });
        }
        request.log.error({ err }, "[bgv] webhook apply failed");
        return reply.status(500).send({ error: "webhook_failed" });
      }
    },
  );
}
