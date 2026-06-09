// Per-session messaging orchestrator.
//
// Serializes inbound candidate messages PER CHANNEL so two quick sends on the
// same channel don't race on history append + scenarioState mutation, while
// leaving the two channels independent of each other (a slow Dana reply does
// not head-of-line block a Sam reply).
//
// This module owns the wiring between the WS route and the persona-agent:
// telemetry events, cost ledger, in-memory spend accounting, and the
// budget-exhausted teardown path.

import { sessionRegistry } from "./registry.js";
import { logEvent } from "./telemetry.js";
import { recordCost } from "./telemetry.js";
import { persistSessionUpdate } from "./db.js";
import { destroySandbox } from "./sandbox.js";
import { BudgetExceededError } from "./litellm.js";
import { replyAsPersona, type Channel } from "./persona-agent.js";

// Per-session, per-channel promise chain to serialize work.
interface ChannelChains {
  client: Promise<void>;
  team: Promise<void>;
}
const chainsBySession = new Map<string, ChannelChains>();

function getChains(sessionId: string): ChannelChains {
  let c = chainsBySession.get(sessionId);
  if (!c) {
    c = { client: Promise.resolve(), team: Promise.resolve() };
    chainsBySession.set(sessionId, c);
  }
  return c;
}

export type OutboundMessage =
  | {
      type?: undefined;
      channel: Channel;
      role: "persona";
      persona_name: string;
      text: string;
      ts: string;
    }
  | {
      type: "error";
      code: "budget_exhausted" | "persona_error" | "session_ended" | "persona_misconfigured";
      message: string;
    };

export type Send = (msg: OutboundMessage) => void;

/**
 * Append one candidate message to the per-channel queue. The reply (when it
 * arrives) is sent back via the provided `send` callback. Returns the promise
 * for the just-enqueued work — the WS handler can ignore it (fire-and-forget)
 * since responses are pushed via `send`.
 */
export function enqueueCandidateMessage(
  sessionId: string,
  channel: Channel,
  text: string,
  send: Send,
): Promise<void> {
  const chains = getChains(sessionId);
  const next = chains[channel].then(() => processOne(sessionId, channel, text, send));
  // Swallow downstream rejections on the chain so a single failed turn doesn't
  // poison the subsequent ones. Errors are already surfaced via `send`.
  chains[channel] = next.catch(() => {});
  return next;
}

async function processOne(
  sessionId: string,
  channel: Channel,
  text: string,
  send: Send,
): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry || entry.status === "completed") {
    send({ type: "error", code: "session_ended", message: "Session has ended." });
    return;
  }

  // Persist the candidate side immediately. This event lands even if the
  // persona reply fails — recruiter timeline still shows what was asked.
  logEvent(sessionId, `message.${channel}.candidate`, "candidate", { text });

  try {
    const reply = await replyAsPersona(sessionId, channel, text);

    // Cost accounting — mirror the chat route's flow exactly.
    if (reply.costUsd !== null) entry.spendTally += reply.costUsd;

    logEvent(sessionId, `message.${channel}.persona`, "system", {
      text: reply.text,
      persona_name: reply.personaName,
      reveals: reply.reveals,
      model: reply.model,
      prompt_tokens: reply.promptTokens,
      completion_tokens: reply.completionTokens,
      total_tokens: reply.totalTokens,
      cost_usd: reply.costUsd,
      latency_ms: reply.latencyMs,
      litellm_call_id: reply.callId,
      finish_reason: reply.finishReason,
    });

    void recordCost(sessionId, {
      model: reply.model,
      promptTokens: reply.promptTokens,
      completionTokens: reply.completionTokens,
      costUsd: reply.costUsd ?? 0,
      cumulativeSpendUsd: entry.spendTally,
      purpose: channel === "client" ? "persona_client" : "persona_team",
      ...(reply.callId && { litellmCallId: reply.callId }),
    });
    void persistSessionUpdate(sessionId, { spend_usd: entry.spendTally });

    send({
      channel,
      role: "persona",
      persona_name: reply.personaName,
      text: reply.text,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      send({
        type: "error",
        code: "budget_exhausted",
        message: "Session budget exhausted.",
      });
      // Teardown — closes the WS via expireSession's messagingSockets loop.
      await destroySandbox(sessionId, "budget").catch(() => {});
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    // PersonaConfigError vs generic LLM error — both surface as persona_error
    // for the candidate. Logged on the server with full context.
    console.error(`[messaging] ${channel} reply failed for session ${sessionId}:`, message);
    send({
      type: "error",
      code: "persona_error",
      message,
    });
  }
}
