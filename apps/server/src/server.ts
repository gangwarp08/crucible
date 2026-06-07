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

export async function buildServer() {
  const server = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  await server.register(fastifyHelmet);
  await server.register(fastifyCors, {
    origin: env.NODE_ENV === "production" ? false : ["http://localhost:3000"],
  });
  await server.register(fastifyRateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });
  // JWT only registered once the secret is configured
  if (env.JWT_SECRET) {
    await server.register(fastifyJwt, { secret: env.JWT_SECRET });
  }
  await server.register(fastifyWebsocket);

  await server.register(healthRoutes);
  await server.register(sessionRoutes, { prefix: "/sessions" });
  await server.register(ptyRoutes);
  await server.register(fileRoutes);
  await server.register(chatRoutes, { prefix: "/api" });

  return server;
}
