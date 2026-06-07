import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createSandbox, destroySandbox } from "../services/sandbox.js";
import { sessionRegistry } from "../services/registry.js";

export async function sessionRoutes(server: FastifyInstance) {
  // POST /sessions — boot a sandbox and return a sessionId
  server.post("/", async (_request, reply) => {
    const sessionId = randomUUID();
    await createSandbox(sessionId);
    return reply.status(201).send({ sessionId });
  });

  // GET /sessions/:id — return session metadata from the in-memory registry
  server.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const entry = sessionRegistry.get(request.params.id);
    if (!entry) return reply.status(404).send({ error: "Session not found" });
    return {
      sessionId: request.params.id,
      sandboxId: entry.sandboxId,
      createdAt: entry.createdAt.toISOString(),
    };
  });

  // DELETE /sessions/:id — kill the sandbox and remove from registry
  server.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    await destroySandbox(request.params.id);
    return reply.status(204).send();
  });
}
