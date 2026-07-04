// Deliverable submission for the four scenario_state.deliverable_spec.components.
//
// The candidate can Save Draft repeatedly and Submit; both flow through the
// same POST and both fire telemetry. Latest-wins on the mirrored state in
// scenarioState.deliverable; the events table retains every draft+submit so
// recruiter timeline shows iteration. SUBMIT now LOCKS the workspace (RD1,
// Slice 6.2): drafts iterate while active, but a 'submitted' POST freezes the
// deliverable, transitions active→submitted, and read-only-locks the rest of the
// workspace so defense questions can't be used as edit hints.

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sessionRegistry } from "../services/registry.js";
import { getOrRehydrateSession } from "../services/session-rehydrate.js";
import { requireSessionToken } from "../services/session-token.js";
import { logEvent } from "../services/telemetry.js";
import { persistScenarioStatePatch } from "../services/db.js";
import { ensureWritable } from "../services/guards.js";
import { transitionSession } from "../services/session-lifecycle.js";
import { destroySandbox } from "../services/sandbox.js";

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
  const requireToken = requireSessionToken((req) => (req.params as { id?: string }).id);

  server.get<{ Params: { id: string } }>(
    "/sessions/:id/deliverable",
    { preHandler: [requireToken] },
    async (request, reply) => {
      const entry = await getOrRehydrateSession(request.params.id);
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
      preHandler: [requireToken],
    },
    async (request, reply) => {
      const parsed = DeliverableBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const { status, data } = parsed.data;

      const sessionId = request.params.id;
      const entry = await getOrRehydrateSession(sessionId);
      // Drafts + the submit itself require an active (writable) session; once
      // submitted/defending/ended, further edits are 409 (RD1).
      if (!ensureWritable(entry, reply)) return;

      const updated_at = new Date().toISOString();
      const persisted: PersistedDeliverable = { status, data, updated_at };

      // Mirror latest into scenario_state for downstream consumers (Analysis
      // Agent + recruiter review). Latest-wins; the events table retains
      // history. In-place mutation + partial patch so concurrent token /
      // compute writes can't clobber the deliverable (the exact bug that
      // surfaced in the first analysis-agent end-to-end run before this
      // race fix).
      entry.scenarioState["deliverable"] = persisted;
      void persistScenarioStatePatch(sessionId, { deliverable: persisted });

      logEvent(
        sessionId,
        status === "submitted" ? "deliverable.submit" : "deliverable.draft",
        "candidate",
        { data, updated_at },
      );

      // Submit is FINAL. The deliverable.submit event above is the immutable
      // snapshot (append-only); transition active→submitted locks the workspace
      // (every mutating route now 409s), then we END the session so it's scored
      // and the candidate lands on the "submitted" screen. (The interactive
      // defense was removed — no `defending` state, no verifier.) Ending runs
      // fire-and-forget so the response returns immediately; teardown + the
      // Analysis Agent run in the background.
      if (status === "submitted") {
        await transitionSession(sessionId, "submitted", { deliverableLockedAt: updated_at });
        void destroySandbox(sessionId, "manual").catch((err) => {
          console.error(
            `[deliverable] end-on-submit failed for ${sessionId}:`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }

      return reply.send({ deliverable: persisted, locked: status === "submitted" });
    },
  );
}
