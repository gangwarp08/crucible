import { randomUUID } from "crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sessionRegistry } from "../services/registry.js";
import {
  chatCompletion,
  BudgetExceededError,
  SYSTEM_PROMPT,
} from "../services/litellm.js";
import { destroySandbox } from "../services/sandbox.js";
import { persistSessionUpdate } from "../services/db.js";
import {
  recordTranscriptTurn,
  recordCost,
} from "../services/telemetry.js";
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

    if (entry.status === "completed") {
      return reply.status(402).send({
        error: "session_ended",
        message: "This session has ended.",
        spend: entry.spendTally,
        budget: env.SESSION_BUDGET_USD,
      });
    }

    if (entry.spendTally >= env.SESSION_BUDGET_USD) {
      return reply.status(402).send({
        error: "budget_exhausted",
        message: `Session budget of $${env.SESSION_BUDGET_USD} has been exhausted.`,
        spend: entry.spendTally,
        budget: env.SESSION_BUDGET_USD,
      });
    }

    // Write the system prompt row exactly once per session (fire-and-forget).
    if (!entry.systemPromptWritten) {
      entry.systemPromptWritten = true;
      void recordTranscriptTurn(sessionId, "system", SYSTEM_PROMPT);
    }

    // Record the user turn (fire-and-forget).
    void recordTranscriptTurn(sessionId, "user", prompt);

    const t0 = Date.now();

    try {
      const { text, responseCost, callId, finishReason, usage } =
        await chatCompletion(entry.litellmKey, prompt);

      const latencyMs = Date.now() - t0;

      if (responseCost !== null) entry.spendTally += responseCost;

      // Pre-generate the assistant transcript ID so cost_ledger can reference
      // it without waiting for the transcript INSERT to complete.
      const assistantId = randomUUID();
      void recordTranscriptTurn(sessionId, "assistant", text, {
        transcriptId: assistantId,
        model: "gemini-flash",
        latencyMs,
        ...(usage && {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        }),
        ...(responseCost !== null && { costUsd: responseCost }),
        ...(finishReason && { finishReason }),
        ...(callId && { litellmCallId: callId }),
      });
      void recordCost(sessionId, {
        model: "gemini-flash",
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        costUsd: responseCost ?? 0,
        cumulativeSpendUsd: entry.spendTally,
        ...(callId && { litellmCallId: callId }),
        transcriptId: assistantId,
      });

      void persistSessionUpdate(sessionId, { spend_usd: entry.spendTally });

      server.log.debug({ sessionId, spendTally: entry.spendTally, latencyMs }, "chat ok");
      return reply.send({
        reply: text,
        spend: entry.spendTally,
        budget: env.SESSION_BUDGET_USD,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
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
