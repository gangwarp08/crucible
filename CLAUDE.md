# CLAUDE.md — Crucible

Operating contract for every Claude Code session in this repository. Read this
fully before planning or editing. If a request conflicts with a **Hard Rule**
below, stop and ask before proceeding.

## What Crucible is

An AI-conducted coding assessment platform. Candidates solve tasks in a real,
sandboxed dev environment while an AI interviewer observes; recruiters later
review the session and its telemetry. Realism and trustworthy isolation matter
more than feature breadth.

## Architecture (data flow)

- **Browser (Next.js)** talks ONLY to our stateful server. It never calls
  LiteLLM, E2B, or privileged Supabase endpoints directly.
- **Stateful server (Fastify)** owns sessions: it creates E2B sandboxes, mints
  short-lived per-session LiteLLM keys, enforces budget + timeout, and writes
  telemetry to Supabase.
- **E2B microVMs** run candidate code. Treat everything inside them as untrusted.
- **LiteLLM gateway (hosted on Railway)** is the ONLY path to model providers.
  The server authenticates with `LITELLM_MASTER_KEY` to mint per-session keys.
  Provider keys live on the gateway, never in this app.
- **Supabase** = Postgres + Auth + Row Level Security. The anon key is public;
  the service-role key is server-only.
- **Redis** = app-side session/rate-limit state.
- **Langfuse** = our own debugging observability — not candidate- or
  recruiter-facing.

## Hard Rules (never violate; if a task requires breaking one, stop and ask)

1. **Provider keys** (Anthropic / OpenAI / Gemini) NEVER appear in app code or
   app env. They live only on the Railway LiteLLM service. Models are reached
   exclusively through LiteLLM.
2. **Browser exposure**: the only env vars that may reach the client are
   `NEXT_PUBLIC_*`. The Supabase service-role key, `LITELLM_MASTER_KEY`,
   `E2B_API_KEY`, and `SUPABASE_DB_URL` are server-only. Never prefix a secret
   with `NEXT_PUBLIC_`.
3. **No direct provider calls**: route every model call through
   `LITELLM_BASE_URL` — never to `api.anthropic.com`, `api.openai.com`, or
   `generativelanguage.googleapis.com` directly.
4. **Sandbox isolation**: candidate code runs only inside E2B. Never exec
   candidate-provided commands on the server or the developer machine.
5. **Cost & time**: every session is bounded by `SESSION_BUDGET_USD` and
   `SESSION_TIMEOUT_MIN`. Do not remove, weaken, or bypass these controls.
6. **Secrets in git**: never commit `.env` or any real key. `.gitignore`
   excludes them from commit #1.
7. **Data access**: the server uses the service role; user-facing reads/writes go
   through RLS-protected paths. Don't bypass RLS for convenience.

## Stack & conventions

- TypeScript everywhere; no `any` without a written reason.
- Frontend: Next.js (app router). Server: Fastify.
- Package manager: pnpm; monorepo via pnpm workspaces.  *(confirm against guide)*
- Validate all external input with Zod at the boundary.
- Never swallow errors; log with context. Never log secrets or candidate PII.
- Each slice ships with a test that verifies against real infra where the build
  guide requires it (E2B, LiteLLM, Supabase) — not mocks.

## Working agreement for Claude Code

- Plan before large changes and show the plan.
- Make the smallest change that satisfies the current slice; don't scaffold
  speculative abstractions.
- Verify against real services when the step calls for it.
- **Ask before**: installing new dependencies, changing the data model, touching
  auth/RLS, modifying budget/timeout logic, or anything touching a Hard Rule.
- For schema/telemetry specifics, consult `crucible-mvp-architecture.md` — it is
  the source of truth for the data model.

## Commands

<!-- Fill in after scaffolding -->
- dev:
- build:
- test:
- lint:
- db migrate:
