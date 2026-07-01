# Secret-handling audit — H1 (Slice 6.8a)

Confirmed **in code** (not by assumption). Paths checked + result, plus the one
gap found and its fix.

## 1. Env injected into the E2B sandbox — PASS

`apps/server/src/services/sandbox.ts` creates the microVM with only
`timeoutMs` + `metadata: { sessionId }`:

```ts
const sandbox = await Sandbox.create("crucible-dev", { timeoutMs, metadata: { sessionId } });
```

No env dict is passed. Confirmed NONE of these reach the sandbox: provider keys
(none exist in-app — model access is LiteLLM-only), `LITELLM_MASTER_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `E2B_API_KEY` (read by the SDK server-side, not
forwarded), `JWT_SECRET`, `SUPABASE_DB_URL`. Candidate code needs no secrets:
the DB is a local SQLite file seeded by the server; all model calls are proxied
by the server.

## 2. Per-session LiteLLM key lifecycle — GAP FOUND + FIXED

Key is minted scoped (`models: ["gemini-flash"]`), budget-capped
(`SESSION_BUDGET_USD`), and TTL-bounded (`SESSION_TIMEOUT_MIN`) in
`services/litellm.ts`.

Revocation by teardown path:

| Path | Revoked? | Notes |
|------|----------|-------|
| Normal end (`session.ts` `expireSession` → `revokeSessionKey`) | ✅ | idempotent, after telemetry flush |
| Manual DELETE / budget teardown (`sandbox.ts`) | ✅ | routes through `expireSession` |
| Orphan teardown (registry entry gone) | ⚠️ by design | only the alias is known, not the raw key; TTL bounds cost |
| **Rehydration after restart** | ❌ **GAP** | minted a NEW key each time, never revoked the old one → keys accumulate across restarts |

**Fix (this slice):**
- Added `revokeSessionKeyByAlias(alias)` (LiteLLM `/key/delete` with
  `key_aliases`) so alias-only teardown paths can revoke.
- `session-rehydrate.ts` now revokes the prior key by its stored alias BEFORE
  minting the replacement, and **persists the rotated alias**
  (`litellm_key_alias`) so the next rehydration revokes the correct (current)
  key — closing the accumulation gap across repeated restarts.
- The orphan path remains TTL-bounded (raw key not recoverable); acceptable for
  the pilot and now documented.

## 3. Browser exposure — PASS

Only `NEXT_PUBLIC_SERVER_URL` is used client-side (`apps/web`), pointing at our
server. No `NEXT_PUBLIC_*` secret. No direct LiteLLM / E2B / Supabase-service
calls from the browser — every request routes through our server.

## 4. Secrets in logs — PASS

No key/secret VALUE is logged. LiteLLM failure logs include only status codes
(`key/delete failed (<status>)`), never the key.

## Summary

4 areas audited; 1 gap (rehydration key rotation) found and fixed in 6.8a. The
orphan-path non-revoke is TTL-bounded and documented. No provider key,
service-role key, or master key reaches the sandbox or browser.
