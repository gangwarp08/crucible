// Validity instrumentation endpoints — /api/admin/validity/* (spec V.1).
//
// ADMIN-ONLY, READ-ONLY. This surface exposes discrimination, outcome
// correlation, and drift — asaya R&D, not partner-facing (that's the P4
// cohort dashboard). Access reuses the existing org resolution: a valid
// X-Org-Key resolving to the admin org (incl. the ORG_ADMIN_KEY env
// credential) passes; partner keys get 403; missing/invalid keys 401. Unlike
// the review surface there is NO back-compat unauthenticated fallback — this
// surface fails closed even with ORG_AUTH_REQUIRED off, because cross-org
// aggregation happens behind it.
//
// Every handler is a GET over the shared read-only aggregation service; there
// are no write paths in this plugin by construction.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireOrg } from "../services/orgs.js";
import {
  loadValidityDataset,
  computeDiscrimination,
  computeNotAssessed,
  computeDistributions,
  computeCorrelation,
  computeExclusions,
  computeVersions,
  ValidityError,
  type ValidityFilters,
} from "../services/validity.js";

const FiltersSchema = z
  .object({
    scenario_id: z.string().uuid().optional(),
    family_id: z.string().min(1).max(200).optional(),
    band: z.enum(["easy", "mid", "hard", "unbanded"]).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/** requireOrg first (401 semantics unchanged), then hard-require the admin
 *  role. Partner orgs and the pre-0018 org-less fallback both land on 403 —
 *  cross-org aggregation is only ever reachable as the admin org.
 *  Exported: routes/costs.ts reuses this exact guard (same fail-closed
 *  semantics) rather than duplicating it. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Fail closed independently of ORG_AUTH_REQUIRED: requireOrg's back-compat
  // branch resolves a KEY-LESS request to the default asaya org (role admin)
  // when the flag is off — acceptable for the review surface's rollout, not
  // for cross-org R&D aggregation. This surface always demands an explicit
  // key.
  const header = request.headers["x-org-key"];
  if (typeof header !== "string" || header.trim() === "") {
    return reply.status(401).send({ error: "org_key_required" });
  }
  // requireOrg is an async preHandler; its `done` third argument is unused on
  // the async path, so calling it with (request, reply) is safe.
  await (requireOrg as unknown as (
    req: FastifyRequest,
    rep: FastifyReply,
  ) => Promise<void>)(request, reply);
  if (reply.sent) return;
  if (request.org?.role !== "admin") {
    reply.status(403).send({ error: "admin_only", message: "This surface requires the asaya admin org." });
  }
}

export async function validityRoutes(server: FastifyInstance): Promise<void> {
  server.addHook("preHandler", requireAdmin);

  const views: Record<
    string,
    (filters: ValidityFilters) => Promise<unknown>
  > = {
    discrimination: async (f) => computeDiscrimination(await loadValidityDataset(f)),
    "not-assessed": async (f) => computeNotAssessed(await loadValidityDataset(f)),
    distributions: async (f) => computeDistributions(await loadValidityDataset(f)),
    correlation: async (f) => computeCorrelation(await loadValidityDataset(f)),
    exclusions: async (f) => computeExclusions(await loadValidityDataset(f)),
    versions: async (f) => computeVersions(await loadValidityDataset(f)),
  };

  for (const [view, compute] of Object.entries(views)) {
    server.get(`/api/admin/validity/${view}`, async (request, reply) => {
      const parsed = FiltersSchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_filters", detail: parsed.error.flatten() });
      }
      try {
        return await compute(parsed.data);
      } catch (err) {
        if (err instanceof ValidityError) {
          request.log.error({ err, view }, "[validity] aggregation failed");
          return reply.status(503).send({ error: "validity_unavailable" });
        }
        throw err;
      }
    });
  }
}
