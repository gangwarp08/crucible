import { env } from "../env.js";

// Server-side only — NEVER sent to the browser or logged.
//
// Generic coding / data-analysis assistant. Intentionally knows NOTHING about
// the candidate's scenario, the scenario's ground truth, persona guardrails,
// or the customer database. The candidate has to direct it by typing — and
// how well they do that is the ai_orchestration rubric signal.
export const SYSTEM_PROMPT = `\
You are a coding and data-analysis assistant. The user is a developer working \
in a sandboxed dev environment. Help them clearly and concisely: write code, \
write SQL, explain concepts, debug, think through approaches.

You do not have direct access to their files, terminal, database, or any \
project context — only what they paste into this chat. When you need a \
schema, a sample row, an error message, or the relevant snippet, ask for it.

Default to brief, focused answers. Write small targeted code examples rather \
than sprawling templates. If they want depth, they'll ask.

You are a general-purpose tool — you do NOT know what specific task the user \
is working on unless they tell you. Don't assume.`;

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** Mint a short-lived, budget-capped LiteLLM key for one session. */
export interface MintSessionKeyOpts {
  /** Override the alias suffix. Used by session rehydration to avoid the
   *  unique-alias collision on re-mint after a server restart. Defaults
   *  to plain `session-${sessionId}`. */
  aliasOverride?: string;
  /** Override the max_budget. Used by session rehydration to cap the new
   *  key at SESSION_BUDGET_USD - already_spent so the candidate doesn't get
   *  a fresh full budget after a restart. Defaults to env.SESSION_BUDGET_USD. */
  maxBudgetUsd?: number;
  /** Override the duration. Defaults to env.SESSION_TIMEOUT_MIN. */
  durationMinutes?: number;
}
export async function mintSessionKey(
  sessionId: string,
  opts: MintSessionKeyOpts = {},
): Promise<string> {
  const alias = opts.aliasOverride ?? `session-${sessionId}`;
  const maxBudget = opts.maxBudgetUsd ?? env.SESSION_BUDGET_USD;
  const duration = opts.durationMinutes ?? env.SESSION_TIMEOUT_MIN;
  const res = await fetch(`${env.LITELLM_BASE_URL}/key/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`,
    },
    body: JSON.stringify({
      key_alias: alias,
      max_budget: maxBudget,
      models: ["gemini-flash"],
      duration: `${duration}m`,
      metadata: { sessionId },
    }),
  });
  if (!res.ok) {
    throw new Error(`LiteLLM key/generate failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { key: string };
  return data.key;
}

/** Revoke a previously minted per-session key. Best-effort — logs on failure. */
export async function revokeSessionKey(key: string): Promise<void> {
  const res = await fetch(`${env.LITELLM_BASE_URL}/key/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`,
    },
    body: JSON.stringify({ keys: [key] }),
  });
  if (!res.ok) {
    console.warn(`LiteLLM key/delete failed (${res.status}) — key may already be expired`);
  }
}

/** Return the authoritative spend (USD) for a session key from the gateway. */
export async function getKeySpend(key: string): Promise<number | null> {
  const res = await fetch(
    `${env.LITELLM_BASE_URL}/key/info?key=${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${env.LITELLM_MASTER_KEY}` } },
  );
  if (!res.ok) {
    console.warn(`getKeySpend: /key/info returned ${res.status} — tally not updated`);
    return null;
  }
  const data = (await res.json()) as { info?: { spend?: number } };
  return data.info?.spend ?? null;
}

/**
 * Call the LiteLLM gateway with the session key.
 * Returns text + the per-call response cost (from x-litellm-response-cost header).
 * Accumulate responseCost into the tally instead of using x-litellm-key-spend,
 * which lags by one request due to async DB writes in the gateway.
 * Throws BudgetExceededError when the gateway rejects with budget_exceeded.
 */
export interface ChatCompletionResult {
  text: string;
  responseCost: number | null;
  callId: string | null;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface PostOpts {
  responseFormat?: "json_object";
  maxTokens?: number;
}

/** Single-prompt shape used by the chat HUD / AI assistant route. Hardcodes
 *  the generic-assistant SYSTEM_PROMPT so callers don't need to know it. */
export async function chatCompletion(
  sessionKey: string,
  prompt: string,
): Promise<ChatCompletionResult> {
  return _postChatCompletion(sessionKey, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);
}

/** Multi-turn shape used by the persona-agent (Dana / Sam). Caller provides
 *  the full messages array including its OWN system prompt — we do not inject
 *  the interviewer SYSTEM_PROMPT here. Optionally requests JSON-only output. */
export async function chatCompletionWithMessages(
  sessionKey: string,
  messages: ChatMessage[],
  opts?: PostOpts,
): Promise<ChatCompletionResult> {
  return _postChatCompletion(sessionKey, messages, opts);
}

async function _postChatCompletion(
  sessionKey: string,
  messages: ChatMessage[],
  opts: PostOpts = {},
): Promise<ChatCompletionResult> {
  const body: Record<string, unknown> = {
    model: "gemini-flash",
    messages,
  };
  if (opts.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }
  if (opts.maxTokens !== undefined) {
    body.max_tokens = opts.maxTokens;
  }

  const res = await fetch(`${env.LITELLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionKey}`, // session key — never the master key
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    // LiteLLM returns 429 (not 400) when a key's max_budget is exceeded.
    if (errBody.includes("budget_exceeded")) {
      throw new BudgetExceededError("Gateway budget exceeded");
    }
    throw new Error(`LiteLLM chat/completions failed: ${res.status} ${errBody}`);
  }

  // x-litellm-response-cost is the cost of this call, written synchronously.
  // x-litellm-key-spend is cumulative but lags by ~1 request (async DB write).
  const costHeader = res.headers.get("x-litellm-response-cost");
  const responseCost = costHeader !== null ? parseFloat(costHeader) : null;
  const callId = res.headers.get("x-litellm-call-id");

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string }; finish_reason?: string }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const text = data.choices[0]?.message?.content ?? "";
  const finishReason = data.choices[0]?.finish_reason ?? null;
  const usage = data.usage
    ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      }
    : null;

  return { text, responseCost, callId, finishReason, usage };
}
