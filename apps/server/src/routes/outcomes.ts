// L6 outcome ingestion (Slice 5.5) — the partner outcome webhook + read-back.
//
// POST /api/outcomes accepts a single real-world outcome for a candidate/session
// from a design partner. It is NOT session-scoped, so it can't use the per-
// session JWT; instead it authenticates with a shared secret carried as a bearer
// token (env.OUTCOMES_WEBHOOK_SECRET). When that secret is unset the endpoint is
// DISABLED (503) so an unconfigured deploy can't take unauthenticated writes.
//
// GET /api/outcomes/correlation/:outcomeType returns the score↔outcome
// correlation for recruiter/debug inspection. Both run service-role only; org
// scoping arrives in Slice 5.7.

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
  OutcomesError,
} from "../services/outcomes.js";

/** Constant-time bearer-secret check. Returns false on any malformed header. */
function authorized(request: FastifyRequest): boolean {
  const secret = env.OUTCOMES_WEBHOOK_SECRET;
  if (!secret) return false;
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length);
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const CorrelationParams = z.object({ outcomeType: z.enum(OUTCOME_TYPES) });
const CorrelationQuery = z.object({ competency: z.string().min(1).optional() });

export async function outcomesRoutes(server: FastifyInstance) {
  if (!supabase) {
    server.log.warn("[outcomes] supabase client unavailable — /api/outcomes routes will 503");
  }
  if (!env.OUTCOMES_WEBHOOK_SECRET) {
    server.log.warn("[outcomes] OUTCOMES_WEBHOOK_SECRET unset — POST /api/outcomes is DISABLED (503)");
  }

  // ─── Ingest one outcome (partner webhook) ────────────────────────────────
  server.post("/outcomes", async (request, reply) => {
    if (!supabase) return reply.status(503).send({ error: "Supabase unavailable" });
    if (!env.OUTCOMES_WEBHOOK_SECRET) {
      return reply.status(503).send({ error: "Outcome webhook not configured" });
    }
    if (!authorized(request)) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const parsed = OutcomeInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid outcome", details: parsed.error.flatten() });
    }

    try {
      const outcome = await insertOutcome(parsed.data, "webhook");
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
  server.get("/outcomes/correlation/:outcomeType", async (request, reply) => {
    if (!supabase) return reply.status(503).send({ error: "Supabase unavailable" });
    const p = CorrelationParams.safeParse(request.params);
    if (!p.success) {
      return reply.status(400).send({ error: "Unknown outcome_type" });
    }
    const q = CorrelationQuery.safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: "Invalid query" });
    }
    try {
      const result = await correlateOutcomes(
        p.data.outcomeType,
        q.data.competency ?? null,
      );
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(`[outcomes] correlation failed: ${message}`);
      return reply.status(500).send({ error: "Correlation failed" });
    }
  });
}
