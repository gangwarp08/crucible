// Deliverable submission for the four scenario_state.deliverable_spec.components.
//
// The candidate can Save Draft repeatedly and Submit; both flow through the
// same POST and both fire telemetry. Latest-wins on the mirrored state in
// scenarioState.deliverable; the events table retains every draft+submit so
// recruiter timeline shows iteration. Submitting does NOT end the session —
// the candidate can keep iterating after submission if they want.

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sessionRegistry } from "../services/registry.js";
import { logEvent } from "../services/telemetry.js";
import { persistScenarioState } from "../services/db.js";

const DeliverableDataSchema = z.object({
  corrected_monthly_revenue: z.string().max(20_000),
  root_cause_finding:        z.string().max(20_000),
  client_facing_summary:     z.string().max(20_000),
  decisions_and_tradeoffs:   z.string().max(20_000),
});

const DeliverableBodySchema = z.object({
  status: z.enum(["draft", "submitted"]),
  data:   DeliverableDataSchema,
});

interface PersistedDeliverable {
  status: "draft" | "submitted";
  data: z.infer<typeof DeliverableDataSchema>;
  updated_at: string;
}

export async function deliverableRoutes(server: FastifyInstance) {
  server.get<{ Params: { id: string } }>(
    "/sessions/:id/deliverable",
    async (request, reply) => {
      const entry = sessionRegistry.get(request.params.id);
      if (!entry) return reply.status(404).send({ error: "Session not found" });
      const current = (entry.scenarioState["deliverable"] ?? null) as PersistedDeliverable | null;
      return reply.send({ deliverable: current });
    },
  );

  server.post<{ Params: { id: string } }>(
    "/sessions/:id/deliverable",
    {
      // Drafts may auto-save frequently; 60/min is comfortable for a 1-2
      // saves-per-minute cadence with headroom.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = DeliverableBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const { status, data } = parsed.data;

      const sessionId = request.params.id;
      const entry = sessionRegistry.get(sessionId);
      if (!entry) return reply.status(404).send({ error: "Session not found" });
      if (entry.status === "completed") {
        return reply.status(410).send({ error: "session_ended" });
      }

      const updated_at = new Date().toISOString();
      const persisted: PersistedDeliverable = { status, data, updated_at };

      // Mirror latest into scenario_state for downstream consumers (Analysis
      // Agent + recruiter review). Latest-wins; the events table retains
      // history.
      entry.scenarioState = { ...entry.scenarioState, deliverable: persisted };
      void persistScenarioState(sessionId, entry.scenarioState);

      logEvent(
        sessionId,
        status === "submitted" ? "deliverable.submit" : "deliverable.draft",
        "candidate",
        { data, updated_at },
      );

      // NOTE: submission does NOT auto-end the session. Candidate can keep
      // iterating and resubmit; latest wins.

      return reply.send({ deliverable: persisted });
    },
  );
}
