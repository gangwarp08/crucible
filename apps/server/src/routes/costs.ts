// Costs dashboard endpoints — /api/admin/costs/* (operator billing cockpit).
//
// ADMIN-ONLY, READ-ONLY. Same guard semantics as the validity surface — the
// requireAdmin preHandler is IMPORTED from routes/validity.ts, not duplicated:
// an explicit X-Org-Key is required (key-less requests 401 even with
// ORG_AUTH_REQUIRED off), partner keys 403, only the asaya admin org passes.
//
// GET /api/admin/costs/overview  — all three sections in one payload
//                                  { litellm, internal, fixed_services, generated_at }
// GET /api/admin/costs/litellm   — gateway section alone   { litellm, generated_at }
// GET /api/admin/costs/internal  — DB section alone        { internal, generated_at }
// The section endpoints exist so the web UI can refresh one card without
// re-aggregating everything. litellm is NEVER a failure mode for the payload:
// gateway-down surfaces as litellm.available=false, HTTP stays 200.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./validity.js";
import {
  litellmSpend,
  internalUsage,
  fixedServices,
  CostsError,
} from "../services/costs.js";

const FiltersSchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export async function costsRoutes(server: FastifyInstance): Promise<void> {
  server.addHook("preHandler", requireAdmin);

  server.get("/api/admin/costs/overview", async (request, reply) => {
    const parsed = FiltersSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_filters", detail: parsed.error.flatten() });
    }
    try {
      // litellmSpend never throws (degrades to available:false); internalUsage
      // is the only section that can fail hard.
      const [litellm, internal] = await Promise.all([
        litellmSpend(),
        internalUsage(parsed.data),
      ]);
      return {
        litellm,
        internal,
        fixed_services: fixedServices(),
        generated_at: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof CostsError) {
        request.log.error({ err }, "[costs] overview aggregation failed");
        return reply.status(503).send({ error: "costs_unavailable" });
      }
      throw err;
    }
  });

  server.get("/api/admin/costs/litellm", async () => ({
    litellm: await litellmSpend(),
    generated_at: new Date().toISOString(),
  }));

  server.get("/api/admin/costs/internal", async (request, reply) => {
    const parsed = FiltersSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_filters", detail: parsed.error.flatten() });
    }
    try {
      return {
        internal: await internalUsage(parsed.data),
        generated_at: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof CostsError) {
        request.log.error({ err }, "[costs] internal aggregation failed");
        return reply.status(503).send({ error: "costs_unavailable" });
      }
      throw err;
    }
  });
}
