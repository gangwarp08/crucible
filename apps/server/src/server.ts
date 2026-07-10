import Fastify, { type FastifyError } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyJwt from "@fastify/jwt";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import { env } from "./env.js";
import { sessionRoutes } from "./routes/sessions.js";
import { healthRoutes } from "./routes/health.js";
import { ptyRoutes } from "./routes/pty.js";
import { fileRoutes } from "./routes/files.js";
import { integrityRoutes } from "./routes/integrity.js";
import { proctoringRoutes } from "./routes/proctoring.js";
import { chatRoutes } from "./routes/chat.js";
import { reviewRoutes } from "./routes/review.js";
import { reportRoutes } from "./routes/report.js";
import { queryRoutes } from "./routes/query.js";
import { messageRoutes } from "./routes/messages.js";
import { docsRoutes } from "./routes/docs.js";
import { deliverableRoutes } from "./routes/deliverable.js";
import { scenariosRoutes } from "./routes/scenarios.js";
import { outcomesRoutes } from "./routes/outcomes.js";
import { contactRoutes } from "./routes/contact.js";
import { validityRoutes } from "./routes/validity.js";
import { costsRoutes } from "./routes/costs.js";
import { startBeatScheduler } from "./services/scheduler.js";
import { startDeadlineReaper } from "./services/deadline-reaper.js";

export async function buildServer() {
  const server = Fastify({
    // Railway terminates TLS and forwards to this service through its edge
    // proxy — without trustProxy, request.ip is the proxy's address for every
    // request. Trusting X-Forwarded-For makes request.ip the real client
    // address, which feeds (a) rate-limit keying and (b) the geo/network
    // integrity channel (services/geo-integrity.ts — derived values only, the
    // raw IP is never persisted). Safe here because the platform proxy always
    // sits in front and sets the header; direct-to-container traffic isn't
    // exposed on Railway.
    trustProxy: true,
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  // Global error handler: unhandled throws must never serialize their raw
  // `message` to the client (it can carry internal error text — e.g. an
  // upstream gateway body). Preserve explicit 4xx (validation, auth, Zod)
  // which are safe and intentional; collapse everything 500+ to a generic
  // body and log the real error server-side. (Security audit 2026-07-10.)
  server.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, "unhandled server error");
      return reply.status(status).send({ error: "internal_error" });
    }
    // Client errors (4xx): keep Fastify's/Zod's own safe message.
    return reply.status(status).send({
      error: err.message || "request_error",
      ...(err.validation ? { validation: err.validation } : {}),
    });
  });

  await server.register(fastifyHelmet);
  // WEB_ORIGIN entries may contain a `*` wildcard — e.g.
  // "https://crucible-web*.vercel.app" admits the Vercel preview/alias
  // domains (crucible-web-git-<branch>-….vercel.app etc.), which otherwise
  // CORS-fail with "Failed to fetch" for anyone browsing a preview deploy.
  // Wildcards become anchored RegExps over [a-z0-9.-]; exact entries stay
  // exact strings (@fastify/cors accepts a mixed array).
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parseOrigin = (entry: string): string | RegExp =>
    entry.includes("*")
      ? new RegExp(`^${entry.split("*").map(escapeRe).join("[a-z0-9.-]*")}$`)
      : entry;
  const webOrigins = env.WEB_ORIGIN
    ? env.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean).map(parseOrigin)
    : env.NODE_ENV === "production"
      ? false
      : ["http://localhost:3000"];
  await server.register(fastifyCors, {
    origin: webOrigins,
    // Without `methods`, the default Access-Control-Allow-Methods response
    // came back as GET,HEAD,POST — missing DELETE and PUT. The browser
    // blocked our DELETE /sessions/:id and PUT /file calls before they
    // ever reached the server, surfacing as "Failed to fetch" in the UI.
    // Explicit allow-list per the actual route methods we use.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // X-Org-Key: the review/admin surfaces send it from the browser (P2
    // org auth). Without it here the preflight rejects the header and every
    // keyed /api/review/* call dies client-side as "Failed to fetch".
    allowedHeaders: ["Content-Type", "Authorization", "X-Invite-Code", "X-Org-Key"],
  });
  await server.register(fastifyRateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });
  // @fastify/jwt is no longer used for session tokens — services/session-token.ts
  // signs/verifies HS256 by hand against env.JWT_SECRET. Register stays so the
  // plugin's request decorators are still available if any future route opts
  // in via reply.jwtSign / request.jwtVerify (e.g. a recruiter auth slice).
  await server.register(fastifyJwt, { secret: env.JWT_SECRET });
  await server.register(fastifyWebsocket);

  await server.register(healthRoutes);
  await server.register(sessionRoutes, { prefix: "/sessions" });
  await server.register(ptyRoutes);
  await server.register(fileRoutes);
  await server.register(integrityRoutes);
  // P6 (proctoring v2, dormant): pre-session config lookup only — answers
  // { v2Enabled: false } for every org until the flag + counsel gate flip.
  await server.register(proctoringRoutes);
  await server.register(chatRoutes, { prefix: "/api" });
  await server.register(queryRoutes, { prefix: "/api" });
  await server.register(messageRoutes);
  await server.register(docsRoutes, { prefix: "/api" });
  await server.register(deliverableRoutes, { prefix: "/api" });
  await server.register(scenariosRoutes, { prefix: "/api/scenarios" });
  await server.register(reviewRoutes, { prefix: "/api/review" });
  // PUBLIC shared candidate report — token IS the auth (P4.3); no org key.
  await server.register(reportRoutes, { prefix: "/api/report" });
  await server.register(outcomesRoutes, { prefix: "/api" });
  await server.register(contactRoutes, { prefix: "/api" });
  // Admin-only, read-only validity instrumentation (registers full
  // /api/admin/validity/* paths itself; fails closed to non-admin orgs).
  await server.register(validityRoutes);
  // Admin-only, read-only cost/usage dashboard (registers full
  // /api/admin/costs/* paths itself; same fail-closed guard as validity).
  await server.register(costsRoutes);

  // Start the proactive-beat scheduler. The sweep loop iterates the live
  // sessionRegistry — initially empty after a fresh boot, populated as
  // POST /sessions calls land.
  startBeatScheduler();

  // Start the deadline reaper — force-completes sessions past their deadline
  // that this (or a prior, restarted) process's in-memory timer missed. The
  // eager first sweep catches anything orphaned by the restart that just
  // happened (e.g. a session stuck in `defending` across a deploy).
  startDeadlineReaper();

  return server;
}
