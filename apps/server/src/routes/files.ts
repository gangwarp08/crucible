import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { sessionRegistry } from "../services/registry.js";
import { getOrRehydrateSession } from "../services/session-rehydrate.js";
import { requireSessionToken } from "../services/session-token.js";
import { recordFileSnapshot } from "../services/telemetry.js";

const SessionQuerySchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
});

const WriteBodySchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
});

async function requireSession(sessionId: string, reply: FastifyReply) {
  const entry = await getOrRehydrateSession(sessionId);
  if (!entry) {
    reply.status(404).send({ error: "Session not found" });
    return null;
  }
  return entry;
}

export async function fileRoutes(server: FastifyInstance) {
  // The three file routes all carry sessionId either in the query string
  // (GET) or the body (PUT). The extractor reads from both — preHandler
  // runs before the per-route Zod parse, so we accept whichever is present.
  const sessionIdFromReq = (req: { query?: unknown; body?: unknown }): string | undefined => {
    const fromQuery = (req.query as { sessionId?: string } | undefined)?.sessionId;
    const fromBody  = (req.body  as { sessionId?: string } | undefined)?.sessionId;
    return fromQuery ?? fromBody;
  };
  const requireToken = requireSessionToken(sessionIdFromReq);

  // GET /files?sessionId=&path= — list a directory
  server.get("/files", { preHandler: [requireToken] }, async (request, reply) => {
    const parsed = SessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { sessionId, path } = parsed.data;
    const entry = await requireSession(sessionId, reply);
    if (!entry) return;

    const entries = await entry.sandbox.files.list(path);
    return reply.send({
      entries: entries.map((e) => ({
        name: e.name,
        path: e.path,
        type: e.type ?? "file",
        isDir: e.type === "dir",
        size: e.size,
      })),
    });
  });

  // GET /file?sessionId=&path= — read a file
  server.get("/file", { preHandler: [requireToken] }, async (request, reply) => {
    const parsed = SessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { sessionId, path } = parsed.data;
    const entry = await requireSession(sessionId, reply);
    if (!entry) return;

    const content = await entry.sandbox.files.read(path);
    return reply.send({ content });
  });

  // PUT /file — write a file
  server.put("/file", { preHandler: [requireToken] }, async (request, reply) => {
    const parsed = WriteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { sessionId, path, content } = parsed.data;
    const entry = await requireSession(sessionId, reply);
    if (!entry) return;

    await entry.sandbox.files.write(path, content);
    void recordFileSnapshot(sessionId, path, content); // best-effort, never blocks
    return reply.send({ ok: true });
  });
}
