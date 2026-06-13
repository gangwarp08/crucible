import { randomUUID } from "crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sessionRegistry } from "../services/registry.js";
import { getOrRehydrateSession } from "../services/session-rehydrate.js";
import {
  chatCompletion,
  BudgetExceededError,
  SYSTEM_PROMPT,
} from "../services/litellm.js";
import { destroySandbox } from "../services/sandbox.js";
import { persistSessionUpdate, persistScenarioStatePatch } from "../services/db.js";
import {
  recordTranscriptTurn,
  recordCost,
  logEvent,
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

    const entry = await getOrRehydrateSession(sessionId);
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

    // Scenario token-mechanic pre-flight. Distinct from the USD budget above:
    // scenario_state.tokens is the candidate's IN-GAME AI assistant budget,
    // seeded from scenario.constraints.tokens (default 200_000 for fde-db-
    // triage) and decremented per call by usage.totalTokens. When it hits 0
    // the assistant is unavailable but the session itself stays alive — the
    // candidate is supposed to keep working unaided.
    const hasScenario = entry.scenarioId !== null;
    const tokensRemainingBefore = hasScenario
      ? (entry.scenarioState["tokens"] as number | undefined)
      : null;
    if (
      hasScenario &&
      typeof tokensRemainingBefore === "number" &&
      tokensRemainingBefore <= 0
    ) {
      return reply.status(402).send({
        error: "token_budget_exhausted",
        message:
          "The AI assistant's token budget for this session is exhausted. You'll need to work unaided from here.",
        spend: entry.spendTally,
        budget: env.SESSION_BUDGET_USD,
        scenarioTokensRemaining: tokensRemainingBefore,
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
        purpose: "ai_assistant",
        ...(callId && { litellmCallId: callId }),
        transcriptId: assistantId,
      });

      void persistSessionUpdate(sessionId, { spend_usd: entry.spendTally });

      // Rich ai_orchestration events alongside the lightweight chat.* markers
      // that recordTranscriptTurn already emits — these carry the full text +
      // token + cost + latency payload that the rubric scorer reads.
      logEvent(sessionId, "ai.assistant.candidate", "candidate", {
        text: prompt,
      });
      logEvent(sessionId, "ai.assistant.response", "system", {
        text,
        model: "gemini-flash",
        prompt_tokens: usage?.promptTokens ?? 0,
        completion_tokens: usage?.completionTokens ?? 0,
        total_tokens: usage?.totalTokens ?? 0,
        cost_usd: responseCost,
        latency_ms: latencyMs,
        litellm_call_id: callId,
        finish_reason: finishReason,
      });

      // Scenario token-mechanic deduction. Skipped entirely for sessions
      // without a scenario (legacy generic-mode dev sessions). The balance
      // is allowed to go negative on the call that drives it past zero —
      // the next call will be rejected by the pre-flight check above.
      let tokensRemainingAfter: number | null = null;
      if (hasScenario) {
        const consumed = usage?.totalTokens ?? 0;
        const before = (entry.scenarioState["tokens"] as number) ?? 0;
        const next = before - consumed;
        // In-place mutation on the shared scenarioState object so concurrent
        // readers (and other writers' future spreads) see the latest value
        // without losing sibling fields. Persistence below patches ONLY the
        // tokens key via the merge RPC so it can't clobber compute_minutes /
        // deliverable / personas etc. from a parallel write.
        entry.scenarioState["tokens"] = next;
        tokensRemainingAfter = next;
        logEvent(sessionId, "constraint.spend", "system", {
          resource: "tokens",
          amount: consumed,
          balance_after: next,
        });
        void persistScenarioStatePatch(sessionId, { tokens: next });
      }

      server.log.debug(
        { sessionId, spendTally: entry.spendTally, latencyMs, tokensRemainingAfter },
        "chat ok",
      );
      return reply.send({
        reply: text,
        spend: entry.spendTally,
        budget: env.SESSION_BUDGET_USD,
        scenarioTokensRemaining: tokensRemainingAfter,
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
