import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sessionRegistry } from "../services/registry.js";
import {
  chatCompletion,
  BudgetExceededError,
} from "../services/litellm.js";
import { destroySandbox } from "../services/sandbox.js";
import { persistSessionUpdate } from "../services/db.js";
import { env } from "../env.js";

const ChatBodySchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1).max(4000),
});

export async function chatRoutes(server: FastifyInstance) {
  server.post("/chat", async (request, reply) => {
    const parsed = ChatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { sessionId, prompt } = parsed.data;

    const entry = sessionRegistry.get(sessionId);
    if (!entry) {
      return reply.status(404).send({ error: "Session not found" });
    }

    // Reject requests for sessions that have already ended (timeout or manual end).
    if (entry.status === "completed") {
      return reply.status(402).send({
        error: "session_ended",
        message: "This session has ended.",
        spend: entry.spendTally,
        budget: env.SESSION_BUDGET_USD,
      });
    }

    // Layer 2 local stop — fires before the gateway is ever hit.
    if (entry.spendTally >= env.SESSION_BUDGET_USD) {
      return reply.status(402).send({
        error: "budget_exhausted",
        message: `Session budget of $${env.SESSION_BUDGET_USD} has been exhausted.`,
        spend: entry.spendTally,
        budget: env.SESSION_BUDGET_USD,
      });
    }

    try {
      const { text, responseCost } = await chatCompletion(entry.litellmKey, prompt);

      // Accumulate per-call cost from x-litellm-response-cost header (synchronous).
      if (responseCost !== null) entry.spendTally += responseCost;

      // Persist updated spend to Supabase (fire-and-forget — never blocks the reply).
      void persistSessionUpdate(sessionId, { spend_usd: entry.spendTally });

      server.log.debug({ sessionId, spendTally: entry.spendTally }, "chat ok");
      return reply.send({
        reply: text,
        spend: entry.spendTally,
        budget: env.SESSION_BUDGET_USD,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        // Gateway enforced its own budget cap — run shared teardown.
        await destroySandbox(sessionId, "budget").catch(() => {});
        return reply.status(402).send({
          error: "budget_exhausted",
          message: "Session budget exceeded at the gateway.",
          spend: entry.spendTally,
          budget: env.SESSION_BUDGET_USD,
        });
      }
      server.log.error({ err, sessionId }, "chat completion failed");
      return reply.status(500).send({ error: "Chat completion failed" });
    }
  });
}
