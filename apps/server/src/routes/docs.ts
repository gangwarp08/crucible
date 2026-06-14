// Scenario docs: list endpoint + view-event endpoint.
//
// The docs themselves live on scenarios.docs (jsonb on Supabase) and are
// served as-is. Each "open this doc" interaction fires a doc.view telemetry
// event so the recruiter timeline + future Analysis Agent can see what
// reference material the candidate consulted (a soft signal toward
// problem_framing / customer_engagement).

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sessionRegistry } from "../services/registry.js";
import { getOrRehydrateSession } from "../services/session-rehydrate.js";
import { requireSessionToken } from "../services/session-token.js";
import { loadScenarioById } from "../services/scenarios.js";
import { logEvent } from "../services/telemetry.js";

interface ScenarioDoc {
  id: string;
  title: string;
  body: string;
}

const DocViewBody = z.object({}).optional();

async function loadDocs(sessionId: string): Promise<ScenarioDoc[] | null> {
  const entry = await getOrRehydrateSession(sessionId);
  if (!entry?.scenarioId) return null;
  const scenario = await loadScenarioById(entry.scenarioId);
  if (!scenario) return null;
  const raw = (scenario.docs ?? []) as unknown[];
  return raw.filter(
    (d): d is ScenarioDoc =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as ScenarioDoc).id === "string" &&
      typeof (d as ScenarioDoc).title === "string" &&
      typeof (d as ScenarioDoc).body === "string",
  );
}

export async function docsRoutes(server: FastifyInstance) {
  const requireToken = requireSessionToken((req) => (req.params as { id?: string }).id);

  server.get<{ Params: { id: string } }>("/sessions/:id/docs", {
    preHandler: [requireToken],
  }, async (request, reply) => {
    const sessionId = request.params.id;
    const entry = await getOrRehydrateSession(sessionId);
    if (!entry) return reply.status(404).send({ error: "Session not found" });

    const docs = await loadDocs(sessionId);
    if (docs === null) return reply.send({ docs: [] });
    return reply.send({ docs });
  });

  server.post<{ Params: { id: string; docId: string } }>(
    "/sessions/:id/docs/:docId/view",
    { preHandler: [requireToken] },
    async (request, reply) => {
      const { id: sessionId, docId } = request.params;

      // Body is optional + always {} today; future-proof for { panel_size_ms } etc.
      const parsed = DocViewBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const entry = await getOrRehydrateSession(sessionId);
      if (!entry) return reply.status(404).send({ error: "Session not found" });
      if (entry.status === "completed") {
        return reply.status(410).send({ error: "session_ended" });
      }

      const docs = await loadDocs(sessionId);
      const doc = docs?.find((d) => d.id === docId);
      if (!doc) return reply.status(404).send({ error: "Doc not found" });

      logEvent(sessionId, "doc.view", "candidate", {
        doc_id: doc.id,
        title: doc.title,
      });

      return reply.send({ ok: true });
    },
  );
}
