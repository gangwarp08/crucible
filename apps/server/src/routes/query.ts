// POST /api/sessions/:id/query — run candidate SQL against the per-session
// SQLite DB inside their E2B sandbox, read-only, with a 500-row cap.
//
// SQL errors are returned as 200 OK with { status: "error", error } so the
// candidate sees their own mistakes inline; only infrastructure failures hit
// the 4xx/5xx paths. Every call emits a db.query telemetry event (this is the
// data_fluency rubric signal — capture every query, ok or not).

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sessionRegistry } from "../services/registry.js";
import { getOrRehydrateSession } from "../services/session-rehydrate.js";
import { runSqliteQuery } from "../services/query-runner.js";
import { logEvent } from "../services/telemetry.js";
import { deductComputeMinutes } from "../services/compute-tracker.js";

// Per-query compute-minutes deduction. Hard-coded for now; future slice can
// read `scenario.constraints.compute_cost_per_query` here.
const COMPUTE_COST_PER_QUERY = 0.25;

const QueryBodySchema = z.object({
  sql: z.string().min(1).max(10_000),
});

const SQL_PREVIEW_MAX = 4_000; // payload bound for the persisted telemetry event

export async function queryRoutes(server: FastifyInstance) {
  server.post<{ Params: { id: string } }>(
    "/sessions/:id/query",
    {
      // Per-SESSION rate limit (not per-IP). Roomy enough for a candidate
      // sustaining ~2 queries/sec; tight enough to catch a runaway client
      // loop on a leaked session ID. Keys on the URL :id since that's
      // always present (no body parsing race like /api/chat).
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
          keyGenerator: (req) => {
            const params = req.params as { id?: string };
            return params.id ? `query:session:${params.id}` : `query:ip:${req.ip}`;
          },
        },
      },
    },
    async (request, reply) => {
      const sessionId = request.params.id;

      const parsed = QueryBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const { sql } = parsed.data;

      const entry = await getOrRehydrateSession(sessionId);
      if (!entry) {
        return reply.status(404).send({ error: "Session not found" });
      }
      if (entry.status === "completed") {
        return reply.status(410).send({
          error: "session_ended",
          message: "This session has ended.",
        });
      }

      try {
        const result = await runSqliteQuery(entry.sandbox, sql);

        // Telemetry: snake_case payload keys per the codebase convention. SQL
        // text is truncated to keep the events row size bounded.
        logEvent(sessionId, "db.query", "candidate", {
          sql: sql.length > SQL_PREVIEW_MAX ? sql.slice(0, SQL_PREVIEW_MAX) + "…[truncated]" : sql,
          status: result.status,
          duration_ms: result.durationMs,
          ...(result.status === "ok"
            ? { row_count: result.rowCount, truncated: result.truncated }
            : { error: result.error }),
        });

        // Soft compute-minutes deduction — counts attempts (SQL errors still
        // run the runner). Emits its own constraint.spend event.
        const scenarioComputeRemaining = deductComputeMinutes(
          sessionId,
          COMPUTE_COST_PER_QUERY,
          "db_query",
        );

        return reply.send({ ...result, scenarioComputeRemaining });
      } catch (err) {
        // Reached only on infra failure (sandbox unreachable, runner missing).
        // SQL errors don't get here — they're returned as data by runSqliteQuery.
        server.log.error({ err, sessionId }, "db.query infra failure");
        logEvent(sessionId, "db.query", "candidate", {
          sql: sql.length > SQL_PREVIEW_MAX ? sql.slice(0, SQL_PREVIEW_MAX) + "…[truncated]" : sql,
          status: "error",
          duration_ms: 0,
          error: `infra: ${(err as Error).message}`,
        });
        return reply.status(500).send({ error: "query infrastructure failure" });
      }
    },
  );
}
