import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSandbox, destroySandbox } from "../services/sandbox.js";
import { DatasetUnavailableError } from "../services/dataset-seed.js";
import { sessionRegistry } from "../services/registry.js";
import { getOrRehydrateSession } from "../services/session-rehydrate.js";
import { signToken, requireSessionToken } from "../services/session-token.js";
import { env } from "../env.js";

// Optional body. Missing body, empty body, and {} are all "no scenario" — the
// session boots in the legacy generic mode. When scenarioId is present the
// session is tied to that FDE simulation.
//
// `beatTimingOverridesMs` is a dev/test knob — maps a scenario curveball id
// to an absolute offset-in-ms from session start, replacing the value computed
// from `scenario.curveballs[*].trigger.time_offset_minutes`. Production
// callers (the web app) omit it. Verifier scripts use it to compress the
// 25-minute requirement-change beat into a 15-second wait.
const PostSessionBody = z
  .object({
    scenarioId: z.string().uuid().optional(),
    beatTimingOverridesMs: z.record(z.string(), z.number().int().nonnegative()).optional(),
    // Dev/test only — overrides scenario.constraints.tokens for this session.
    // Used by the AI-assistant verifier to force token exhaustion in a few calls.
    tokenBudgetOverride: z.number().int().nonnegative().optional(),
    // Shared invite code. Required only when env.INVITE_CODE is set.
    inviteCode: z.string().optional(),
  })
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
    if (env.INVITE_CODE && parsed.data?.inviteCode !== env.INVITE_CODE) {
      return reply.status(401).send({ error: "Invalid invite code" });
    }
    const scenarioId = parsed.data?.scenarioId;
    const beatTimingOverridesMs = parsed.data?.beatTimingOverridesMs;
    const tokenBudgetOverride = parsed.data?.tokenBudgetOverride;
    const sessionId = randomUUID();
    try {
      await createSandbox(sessionId, scenarioId, beatTimingOverridesMs, tokenBudgetOverride);
    } catch (err) {
      if (err instanceof DatasetUnavailableError) {
        // Scenario row exists but its dataset isn't deployed on this server —
        // a config/deploy mismatch, not a candidate error. Clean 422 instead
        // of a raw 500 leaking the server path.
        request.log.error({ err, scenarioId }, "scenario dataset unavailable");
        return reply.status(422).send({
          error: "This assessment is temporarily unavailable. Please pick another or try again later.",
        });
      }
      throw err;
    }
    const entry = sessionRegistry.get(sessionId)!;
    // Mint a session-bound JWT. The token is the ONLY thing that lets the
    // candidate use the protected routes — a leaked session UUID alone can
    // no longer drive chat / SQL / personas.
    const token = signToken(sessionId, entry.deadline.getTime());
    return reply.status(201).send({
      sessionId,
      deadline: entry.deadline.toISOString(),
      scenarioId: entry.scenarioId,
      token,
    });
  });

  // GET /sessions/:id — session metadata including live budget/status for the HUD.
  server.get<{ Params: { id: string } }>("/:id", {
    preHandler: [requireSessionToken((req) => (req.params as { id?: string }).id)],
  }, async (request, reply) => {
    const entry = await getOrRehydrateSession(request.params.id);
    if (!entry) return reply.status(404).send({ error: "Session not found" });
    const hasScenario = entry.scenarioId !== null;
    const initial = (entry.scenarioState["budget_initial"] ??
      {}) as Record<string, unknown>;
    return {
      sessionId: request.params.id,
      sandboxId: entry.sandboxId,
      createdAt: entry.createdAt.toISOString(),
      deadline: entry.deadline.toISOString(),
      budget: env.SESSION_BUDGET_USD,
      spend: entry.spendTally,
      status: entry.status,
      // null when this session has no scenario (legacy mode); otherwise the
      // live game-mechanic token balance the AI assistant draws from.
      scenarioTokensRemaining: hasScenario
        ? ((entry.scenarioState["tokens"] as number | undefined) ?? null)
        : null,
      // Static constraint snapshot — what the candidate started with. The HUD
      // uses these as the denominator in "X / Y" displays.
      scenarioConstraints: hasScenario
        ? {
            time_minutes:    (initial["time_minutes"]    as number | undefined) ?? null,
            tokens:          (initial["tokens"]          as number | undefined) ?? null,
            compute_minutes: (initial["compute_minutes"] as number | undefined) ?? null,
            money_usd:       (initial["money_usd"]       as number | undefined) ?? null,
            memory_mb:       (initial["memory_mb"]       as number | undefined) ?? null,
          }
        : null,
      // Live values for the hard-resource HUD indicators.
      scenarioBalances: hasScenario
        ? {
            tokens:          (entry.scenarioState["tokens"]          as number | undefined) ?? null,
            compute_minutes: (entry.scenarioState["compute_minutes"] as number | undefined) ?? null,
          }
        : null,
      // Latest deliverable mirrored from scenario_state.deliverable. The
      // POST /api/sessions/:id/deliverable route owns writes.
      deliverable: (entry.scenarioState["deliverable"] ?? null) as Record<string, unknown> | null,
      // Presentation metadata for the candidate UI (frozen at session
      // creation; see services/sandbox.ts scenarioMeta wiring).
      scenarioTitle:      entry.scenarioMeta?.title      ?? null,
      scenarioBrief:      entry.scenarioMeta?.brief      ?? null,
      scenarioRole:       entry.scenarioMeta?.role       ?? null,
      scenarioDifficulty: entry.scenarioMeta?.difficulty ?? null,
    };
  });

  // DELETE /sessions/:id — manual end: clear timer + run shared teardown.
  server.delete<{ Params: { id: string } }>("/:id", {
    preHandler: [requireSessionToken((req) => (req.params as { id?: string }).id)],
  }, async (request, reply) => {
    await destroySandbox(request.params.id);
    return reply.status(204).send();
  });
}
