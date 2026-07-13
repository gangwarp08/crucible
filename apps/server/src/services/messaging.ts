// Per-session messaging orchestrator.
//
// Serializes ALL persona work (client + team, reactive + proactive) on ONE
// promise chain per session: the personas share a single conversation history,
// so a reply to Sam must see Dana's completed reply — two chains would let an
// LLM call snapshot the history mid-turn and interleave appends
// nondeterministically. The verifier keeps its own chain so a slow persona
// turn never blocks a defense answer.
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
import { verifierReply } from "./verifier-agent.js";

// Channels the candidate can message on. The persona channels are client/team;
// "verifier" carries the L4 interactive defense (Slice 5.4b). Persona-agent's
// Channel stays the narrower client|team — MessageChannel is its superset.
export type MessageChannel = Channel | "verifier";

// Per-session promise chains: one for all persona traffic, one for the verifier.
interface ChannelChains {
  persona: Promise<void>;
  verifier: Promise<void>;
}
const chainsBySession = new Map<string, ChannelChains>();

function getChains(sessionId: string): ChannelChains {
  let c = chainsBySession.get(sessionId);
  if (!c) {
    c = { persona: Promise.resolve(), verifier: Promise.resolve() };
    chainsBySession.set(sessionId, c);
  }
  return c;
}

/** Run a task serialized on the session's persona chain. Used by the proactive
 *  beat scheduler so a scheduled persona ping can never interleave with an
 *  in-flight reactive reply's history read/append. Returns the task's promise;
 *  the stored chain swallows the rejection so one failure doesn't poison
 *  subsequent turns. */
export function runOnPersonaChain(sessionId: string, task: () => Promise<void>): Promise<void> {
  const chains = getChains(sessionId);
  const next = chains.persona.then(task);
  chains.persona = next.catch(() => {});
  return next;
}

/** Fan out one message to every open WS for the given session. Used by the
 *  proactive-beat scheduler (no candidate-callback to route through). Best-
 *  effort: dead sockets are skipped silently and the persisted event in the
 *  database is the durable record. */
export function broadcastToSession(sessionId: string, msg: OutboundMessage): void {
  const entry = sessionRegistry.get(sessionId);
  if (!entry) return;
  const payload = JSON.stringify(msg);
  for (const socket of entry.messagingSockets) {
    if (socket.readyState !== 1 /* OPEN */) continue;
    try {
      // SessionEntry types this as the minimal {readyState, close} shape; the
      // actual instance is a Fastify-websocket WebSocket which also exposes
      // .send(). Narrow with a runtime check; no `as any` lies.
      const sendable = socket as unknown as { send?: (data: string) => void };
      if (typeof sendable.send === "function") sendable.send(payload);
    } catch (err) {
      console.warn("[messaging] broadcast send failed", err);
    }
  }
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
      type?: undefined;
      channel: "verifier";
      role: "verifier";
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
 * Append one candidate message to the appropriate queue (persona chain for
 * client/team, verifier chain for the defense). The reply (when it arrives) is
 * sent back via the provided `send` callback. Returns the promise for the
 * just-enqueued work — the WS handler can ignore it (fire-and-forget) since
 * responses are pushed via `send`.
 */
export function enqueueCandidateMessage(
  sessionId: string,
  channel: MessageChannel,
  text: string,
  send: Send,
): Promise<void> {
  const chains = getChains(sessionId);
  const key = channel === "verifier" ? "verifier" : "persona";
  const next = chains[key].then(() => processOne(sessionId, channel, text, send));
  // Swallow downstream rejections on the chain so a single failed turn doesn't
  // poison the subsequent ones. Errors are already surfaced via `send`.
  chains[key] = next.catch(() => {});
  return next;
}

async function processOne(
  sessionId: string,
  channel: MessageChannel,
  text: string,
  send: Send,
): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry || entry.status === "completed") {
    send({ type: "error", code: "session_ended", message: "Session has ended." });
    return;
  }

  // L4 verification (Slice 5.4b) — candidate answer on the verifier channel.
  // verifierReply records the answer (verification.response event) and pushes
  // the next question via broadcast; it has no LLM call and its own telemetry,
  // so it does not flow through the persona cost/logging path below.
  if (channel === "verifier") {
    try {
      verifierReply(sessionId, text, broadcastToSession);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[messaging] verifier reply failed for session ${sessionId}:`, message);
      send({ type: "error", code: "persona_error", message });
    }
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
