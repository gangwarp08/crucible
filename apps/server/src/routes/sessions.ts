import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSandbox, destroySandbox } from "../services/sandbox.js";
import { sessionRegistry } from "../services/registry.js";
import { env } from "../env.js";

// Optional body. Missing body, empty body, and {} are all "no scenario" — the
// session boots in the legacy generic mode. When scenarioId is present the
// session is tied to that FDE simulation.
const PostSessionBody = z
  .object({ scenarioId: z.string().uuid().optional() })
  .optional();

export async function sessionRoutes(server: FastifyInstance) {
  // POST /sessions — boot a sandbox, mint a key, start the kill-switch timer.
  server.post("/", async (request, reply) => {
    const parsed = PostSessionBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid body",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const scenarioId = parsed.data?.scenarioId;
    const sessionId = randomUUID();
    await createSandbox(sessionId, scenarioId);
    const entry = sessionRegistry.get(sessionId)!;
    return reply.status(201).send({
      sessionId,
      deadline: entry.deadline.toISOString(),
      scenarioId: entry.scenarioId,
    });
  });

  // GET /sessions/:id — session metadata including live budget/status for the HUD.
  server.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const entry = sessionRegistry.get(request.params.id);
    if (!entry) return reply.status(404).send({ error: "Session not found" });
    return {
      sessionId: request.params.id,
      sandboxId: entry.sandboxId,
      createdAt: entry.createdAt.toISOString(),
      deadline: entry.deadline.toISOString(),
      budget: env.SESSION_BUDGET_USD,
      spend: entry.spendTally,
      status: entry.status,
    };
  });

  // DELETE /sessions/:id — manual end: clear timer + run shared teardown.
  server.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    await destroySandbox(request.params.id);
    return reply.status(204).send();
  });
}
