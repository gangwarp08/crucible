import type { FastifyInstance } from "fastify";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env.js";

// Deployed commit SHA, build-injected by the platform (Railway sets
// RAILWAY_GIT_COMMIT_SHA; Vercel sets VERCEL_GIT_COMMIT_SHA). Surfacing it makes
// "prod silently running an old commit" (the 22-commit drift that bit us)
// impossible to miss — diff /health.commit against the deployed git SHA.
const COMMIT =
  process.env["RAILWAY_GIT_COMMIT_SHA"] ?? process.env["VERCEL_GIT_COMMIT_SHA"] ?? null;

// Highest-numbered migration bundled with THIS build — "what schema this code
// expects". Computed once at load (no per-request IO); best-effort.
const LATEST_MIGRATION = ((): string | null => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = resolve(here, "../../../..", "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    return files.length ? files[files.length - 1]! : null;
  } catch {
    return null;
  }
})();

export async function healthRoutes(server: FastifyInstance) {
  server.get("/health", async () => ({
    status: "ok",
    commit: COMMIT,
    migration: LATEST_MIGRATION,
    flags: {
      verification_enabled: env.VERIFICATION_ENABLED === "true",
      pilot_verification_advisory: env.PILOT_VERIFICATION_ADVISORY === "true",
      outcome_webhook: Boolean(env.OUTCOMES_WEBHOOK_SECRET),
    },
  }));
}
