import { env } from "../env.js";

// TODO: implement full key lifecycle (slice: llm-gateway)

/** Mint a short-lived, budget-capped LiteLLM key for one session. */
export async function mintSessionKey(params: {
  sessionId: string;
  budgetUsd: number;
  ttlSeconds: number;
}): Promise<string> {
  // LiteLLM key-generation endpoint: POST /key/generate
  // Auth header: Bearer LITELLM_MASTER_KEY
  // Docs: https://docs.litellm.ai/docs/proxy/virtual_keys
  const res = await fetch(`${env.LITELLM_BASE_URL}/key/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`,
    },
    body: JSON.stringify({
      max_budget: params.budgetUsd,
      duration: `${params.ttlSeconds}s`,
      metadata: { sessionId: params.sessionId },
    }),
  });

  if (!res.ok) {
    throw new Error(`LiteLLM key mint failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { key: string };
  return data.key;
}

/** Revoke a previously minted per-session key. */
export async function revokeSessionKey(key: string): Promise<void> {
  // TODO: POST /key/delete with the key
  void key;
}
