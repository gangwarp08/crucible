import { env } from "../env.js";

// Server-side only — NEVER sent to the browser or logged.
export const SYSTEM_PROMPT =
  "You are an AI technical interviewer conducting a coding assessment on the Crucible platform. " +
  "You can observe the candidate's code and terminal session. " +
  "Be concise, professional, and encouraging. " +
  "Guide with targeted hints rather than direct solutions. " +
  "When a candidate asks for help, ask a clarifying question first to understand where they are stuck.";

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** Mint a short-lived, budget-capped LiteLLM key for one session. */
export async function mintSessionKey(sessionId: string): Promise<string> {
  const res = await fetch(`${env.LITELLM_BASE_URL}/key/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`,
    },
    body: JSON.stringify({
      key_alias: `session-${sessionId}`,
      max_budget: env.SESSION_BUDGET_USD,
      models: ["gemini-flash"],
      duration: `${env.SESSION_TIMEOUT_MIN}m`,
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
export async function chatCompletion(
  sessionKey: string,
  prompt: string,
): Promise<{ text: string; responseCost: number | null }> {
  const res = await fetch(`${env.LITELLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionKey}`, // session key — never the master key
    },
    body: JSON.stringify({
      model: "gemini-flash",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // LiteLLM returns 429 (not 400) when a key's max_budget is exceeded.
    if (body.includes("budget_exceeded")) {
      throw new BudgetExceededError("Gateway budget exceeded");
    }
    throw new Error(`LiteLLM chat/completions failed: ${res.status} ${body}`);
  }

  // x-litellm-response-cost is the cost of this call, written synchronously.
  // x-litellm-key-spend is cumulative but lags by ~1 request (async DB write).
  const costHeader = res.headers.get("x-litellm-response-cost");
  const responseCost = costHeader !== null ? parseFloat(costHeader) : null;

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const text = data.choices[0]?.message?.content ?? "";
  return { text, responseCost };
}
