import Fastify from "fastify";
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
import { chatRoutes } from "./routes/chat.js";
import { reviewRoutes } from "./routes/review.js";
import { queryRoutes } from "./routes/query.js";
import { messageRoutes } from "./routes/messages.js";
import { docsRoutes } from "./routes/docs.js";
import { deliverableRoutes } from "./routes/deliverable.js";
import { scenariosRoutes } from "./routes/scenarios.js";
import { outcomesRoutes } from "./routes/outcomes.js";
import { startBeatScheduler } from "./services/scheduler.js";

export async function buildServer() {
  const server = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  await server.register(fastifyHelmet);
  const webOrigins = env.WEB_ORIGIN
    ? env.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
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
    allowedHeaders: ["Content-Type", "Authorization", "X-Invite-Code"],
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
  await server.register(chatRoutes, { prefix: "/api" });
  await server.register(queryRoutes, { prefix: "/api" });
  await server.register(messageRoutes);
  await server.register(docsRoutes, { prefix: "/api" });
  await server.register(deliverableRoutes, { prefix: "/api" });
  await server.register(scenariosRoutes, { prefix: "/api/scenarios" });
  await server.register(reviewRoutes, { prefix: "/api/review" });
  await server.register(outcomesRoutes, { prefix: "/api" });

  // Start the proactive-beat scheduler. The sweep loop iterates the live
  // sessionRegistry — initially empty after a fresh boot, populated as
  // POST /sessions calls land.
  startBeatScheduler();

  return server;
}
