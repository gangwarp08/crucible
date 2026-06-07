import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { sessionRegistry } from "../services/registry.js";

const SessionQuerySchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
});

const WriteBodySchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
});

function requireSession(sessionId: string, reply: FastifyReply) {
  const entry = sessionRegistry.get(sessionId);
  if (!entry) {
    reply.status(404).send({ error: "Session not found" });
    return null;
  }
  return entry;
}

export async function fileRoutes(server: FastifyInstance) {
  // GET /files?sessionId=&path= — list a directory
  server.get("/files", async (request, reply) => {
    const parsed = SessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { sessionId, path } = parsed.data;
    const entry = requireSession(sessionId, reply);
    if (!entry) return;

    const entries = await entry.sandbox.files.list(path);
    return reply.send({
      entries: entries.map((e) => ({
        name: e.name,
        path: e.path,
        type: e.type ?? "file",
        size: e.size,
      })),
    });
  });

  // GET /file?sessionId=&path= — read a file
  server.get("/file", async (request, reply) => {
    const parsed = SessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { sessionId, path } = parsed.data;
    const entry = requireSession(sessionId, reply);
    if (!entry) return;

    const content = await entry.sandbox.files.read(path);
    return reply.send({ content });
  });

  // PUT /file — write a file
  server.put("/file", async (request, reply) => {
    const parsed = WriteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { sessionId, path, content } = parsed.data;
    const entry = requireSession(sessionId, reply);
    if (!entry) return;

    await entry.sandbox.files.write(path, content);
    return reply.send({ ok: true });
  });
}
