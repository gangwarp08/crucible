import type { FastifyInstance } from "fastify";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env.js";

// Deployed commit SHA. Railway injects RAILWAY_GIT_COMMIT_SHA on git-triggered
// deploys; our `railway up` (CLI) deploys don't, so the deploy step sets
// GIT_COMMIT_SHA. Vercel uses VERCEL_GIT_COMMIT_SHA. Surfacing it makes "prod
// silently running an old commit" (the 22-commit drift that bit us) impossible
// to miss — diff /health.commit against the deployed git SHA.
const COMMIT =
  process.env["RAILWAY_GIT_COMMIT_SHA"] ??
  env.GIT_COMMIT_SHA ??
  process.env["VERCEL_GIT_COMMIT_SHA"] ??
  null;

// Highest-numbered migration bundled with THIS build — "what schema this code
// expects". Computed once at load (no per-request IO); best-effort.
const LATEST_MIGRATION = ((): string | null => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/routes or src/routes → repo root is 4 levels up.
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
      session_link_required: env.SESSION_LINK_REQUIRED === "true",
      outcome_webhook: Boolean(env.OUTCOMES_WEBHOOK_SECRET),
    },
  }));
}
