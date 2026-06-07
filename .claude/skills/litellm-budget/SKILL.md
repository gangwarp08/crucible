---
name: litellm-budget
description: >-
  Use whenever minting, scoping, revoking, or budgeting LiteLLM access for a
  Crucible session — per-session virtual keys, max_budget / model allow-lists /
  key expiry via POST /key/generate against the Railway gateway, spend checks,
  and the three-layer cost+time controls. Pins the current LiteLLM key API.
---

# LiteLLM per-session keys & budget (Crucible)

LiteLLM is **hosted on Railway**. The server reaches it at `LITELLM_BASE_URL`
and authenticates with `LITELLM_MASTER_KEY` ONLY to mint short-lived per-session
keys. The master key never leaves the server; the browser never sees any LiteLLM
key. Model calls in a session use that session's minted key.

Reference: https://docs.litellm.ai/docs/proxy/virtual_keys

## Mint a per-session key

`POST {LITELLM_BASE_URL}/key/generate` with the master key. Scope it tightly:
budget = `SESSION_BUDGET_USD`, allowed models only, and an expiry aligned to
`SESSION_TIMEOUT_MIN` so the key dies with the session.

```ts
// server-only
async function mintSessionKey(sessionId: string): Promise<string> {
  const res = await fetch(`${process.env.LITELLM_BASE_URL}/key/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LITELLM_MASTER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      key_alias: `session-${sessionId}`,
      max_budget: Number(process.env.SESSION_BUDGET_USD),     // hard $ cap for this key
      models: ['gemini-flash'],                                // allow-list of model aliases
      duration: `${process.env.SESSION_TIMEOUT_MIN}m`,         // key auto-expires, e.g. "90m"
      metadata: { sessionId },
    }),
  })
  if (!res.ok) throw new Error(`key/generate failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.key as string   // hand ONLY this to the session runtime
}
```

Notes:
- `duration` = key TTL (`"30s"|"30m"|"90m"|"30d"`). `budget_duration` is a
  *resetting* window (e.g. `"30d"`) — omit it for one-shot session keys.
- `models` must match the `model_name` aliases configured on the gateway.
- One key per session. Never reuse a key; never mint with anything but the
  master key, server-side.

## Use, check, revoke

```ts
// Session model calls: OpenAI-compatible, pointed at the gateway with the SESSION key.
// import OpenAI from 'openai'   // allowed: this is the LiteLLM client, not a provider SDK
const client = new OpenAI({ baseURL: process.env.LITELLM_BASE_URL, apiKey: sessionKey })

// Spend check (master key):
const info = await fetch(
  `${process.env.LITELLM_BASE_URL}/key/info?key=${sessionKey}`,
  { headers: { Authorization: `Bearer ${process.env.LITELLM_MASTER_KEY}` } },
).then((r) => r.json())
// info.info.spend, info.info.max_budget

// Revoke on session end / error / timeout (master key):
await fetch(`${process.env.LITELLM_BASE_URL}/key/delete`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.LITELLM_MASTER_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ keys: [sessionKey] }),
})
```

When the budget is crossed, model calls fail with HTTP 400 and
`type: "budget_exceeded"`. Treat that as a terminal session signal — stop work,
revoke the key, kill the sandbox.

## Three-layer cost + time control (CLAUDE.md Hard Rule 5)

Do not rely on any single layer:

1. **Gateway budget** — the key's `max_budget` (hard cap at LiteLLM).
2. **Server-side tally** — the server also sums spend per session from `/key/info`
   (or its own accounting) and ends the session at the threshold. This is defense
   in depth: cross-worker budget counters can lag (a known LiteLLM Redis
   reservation caveat), so never trust the gateway as the *only* stop.
3. **Wall-clock timeout** — the orchestrator kills the sandbox AND revokes the key
   at `SESSION_TIMEOUT_MIN`, regardless of spend.

## Hard rules

- Master key: server-only, used only for `/key/*` admin calls. Never in
  `apps/web`, never in a session runtime, never client-visible.
- Every session: mint → use → (spend/timeout) → revoke + kill sandbox.
- Persist the minted key + sessionId in session state so any server instance can
  revoke it during cleanup.
