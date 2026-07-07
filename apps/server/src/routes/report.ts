// PUBLIC shared candidate report — GET /api/report/:token (P4.3).
//
// NO org auth on purpose: the token IS the auth. A recruiter mints a share
// link via /api/review (org-gated), hands the URL to a hiring manager, and
// this endpoint serves the EXTERNAL-SAFE subset (services/shared-report.ts —
// Zod-allowlisted, strict) after checking the token against report_shares:
// sha256 lookup, then expiry + revocation.
//
// Error posture: unknown token → 404 (indistinguishable from never-existed);
// expired/revoked → 410 with the reason — the holder already HAD legitimate
// access, so telling them why the link died is UX, not a leak.

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { supabase } from "../services/supabase.js";
import { resolveReportShare, ReportShareError } from "../services/report-share.js";
import { buildSharedReport } from "../services/shared-report.js";

// Raw tokens are 32 bytes base64url (43 chars) — reject junk before hashing.
const TokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) });

export async function reportRoutes(server: FastifyInstance) {
  if (!supabase) {
    server.log.warn("[report] supabase client unavailable — /api/report will 503");
  }

  server.get<{ Params: { token: string } }>(
    "/:token",
    {
      // Public + unauthenticated → keep brute-force probing expensive.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = TokenSchema.safeParse(request.params);
      if (!parsed.success) return reply.status(404).send({ error: "not_found" });
      if (!supabase) return reply.status(503).send({ error: "unavailable" });

      try {
        const resolved = await resolveReportShare(parsed.data.token);
        if (!resolved) return reply.status(404).send({ error: "not_found" });
        if (resolved.status !== "active") {
          return reply.status(410).send({ error: resolved.status });
        }
        const report = await buildSharedReport(
          resolved.row.session_id,
          resolved.row.expires_at,
        );
        return reply.send(report);
      } catch (err) {
        if (err instanceof ReportShareError && err.code !== "server") {
          return reply.status(404).send({ error: "not_found" });
        }
        server.log.error({ err }, "[report] shared report failed");
        return reply.status(500).send({ error: "report_failed" });
      }
    },
  );
}
