# asaya

An AI-conducted coding assessment platform. Candidates solve real work
in a sandboxed dev environment while an AI interviewer observes;
recruiters review the session afterward with a structured scorecard.

The pitch: résumés lie, portfolios are borrowed, AI writes the rest.
asaya drops candidates into 60 minutes of the actual job — real
tools, live context — and scores what they truly do, not what they
claim to do.

## What it does

- Presents a scenario (e.g. "Meridian SaaS revenue dashboard looks off,
  board meeting in 60 minutes — figure out what's wrong, prioritize,
  and brief the VP Finance").
- Spins up a per-candidate sandbox (E2B microVM) with a SQLite copy of
  Meridian's "production" data, file tree, terminal, SQL data explorer.
- Runs two AI personas the candidate can talk to: **Dana** (VP Finance,
  the client) and **Sam** (senior engineer teammate — helpful but
  confidently wrong about priority).
- Tracks every action — query, message, file write, AI assistant turn —
  as structured telemetry.
- Grades the session against an 8-competency rubric with anchor-driven
  scoring. Recruiters see overall score plus per-competency breakdown
  with evidence citations.
- Flags (but never scores) suspicious behavior — tab switches, idle gaps,
  devtools, plus server-side geo/network signals (coarse location, IP-change,
  timezone mismatch — raw IPs never stored, only a per-session-salted hash) —
  as a recruiter-only 0–100 Suspicion Score (copy/paste counted but shown "not
  scored"). Integrity signals are excluded from scoring by construction, and
  candidates see a disclosure up front.
- Lets recruiters **watch a session live** — a read-only, org-scoped SSE
  stream of the in-flight event timeline + status/spend.
- Multi-tenant: partner orgs authenticate with an API key
  (`X-Org-Key`) — delivered as a single review link (`/review?key=…`)
  — and see only their own sessions, plus per-scenario
  cohort dashboards and public shareable candidate reports
  (allowlisted, PDF-printable).
- Routes candidates to an easier/harder variant of a scenario family
  per invite link (difficulty bands, applied at session creation only),
  with calibration stats + equating to compare bands.

## Architecture (data flow)

```
Browser (Next.js)
  │
  ├──► Stateful server (Fastify) ──► E2B sandbox     (candidate code, isolated)
  │        │                   ──► LiteLLM gateway (only path to models)
  │        │                   ──► Supabase        (sessions, telemetry, evals)
  │        │                   ──► Redis           (app-side rate-limit state)
  │
  └──► (never talks to LiteLLM / E2B / Supabase service-role directly)
```

Hard rules enforced everywhere:

- **No direct provider calls.** Anthropic / OpenAI / Gemini keys live
  only on the LiteLLM gateway on Railway, never in this app.
- **No browser exposure of secrets.** Only `NEXT_PUBLIC_*` env vars
  may reach the client. Service-role key, LiteLLM master key, E2B
  key, JWT secret all server-only.
- **Sandbox isolation.** Candidate code runs only in E2B microVMs;
  the server never execs candidate-provided commands.
- **Cost + time caps per session.** `SESSION_BUDGET_USD` and
  `SESSION_TIMEOUT_MIN` bound every session at the server and
  enforced again at LiteLLM via per-session keys.
- **Per-session JWT auth.** Every protected route and both
  WebSocket handshakes require a server-signed bearer token bound
  to the session. A leaked URL is useless without the token.

Full operating contract: see `CLAUDE.md`.

## Stack

- **Frontend**: Next.js (app router), Zustand, react-resizable-panels,
  Monaco editor, xterm.js
- **Backend**: Fastify, Zod, `@fastify/rate-limit`, `@fastify/jwt`,
  `@fastify/websocket`
- **AI gateway**: LiteLLM (hosted on Railway) — provider-agnostic
- **Sandbox**: E2B microVMs (`@e2b/code-interpreter`)
- **Data**: Supabase (Postgres + RLS); Redis for app-side state
- **TypeScript everywhere**; pnpm workspaces via Turbo
- **Deployment**: Vercel (web), Railway (server + LiteLLM)

## Project structure

```
apps/
  web/          Next.js — candidate UI, landing page, review UI
  server/       Fastify — session lifecycle, persona-agent, analysis-agent
fixtures/
  fde-db-triage/        Tier 1 scenario — synthetic dataset + ground truth
  fde-db-triage-pro/    Tier 1.5 — multi-issue + prioritization + Sam pushes wrong priority
  fde-api-integration/  Family 2 (LIVE) — API-integration debugging + native ps-fork (client: Priya)
infra/
  e2b/          Sandbox template definition
packages/
  shared/       Cross-app types
supabase/
  migrations/   DDL + scenario-content migrations
docs/           Architecture reference, scenario specs
.github/
  workflows/    CI (typecheck + build) + daily cost alert cron
```

## Quick start

Prerequisites: Node 20+, pnpm 9, Supabase project, LiteLLM gateway
deployed, E2B API key, Railway account (for production deploy).

```bash
# Install
pnpm install

# Copy env template and fill in real values
cp .env.example .env
# Edit .env — at minimum: SUPABASE_PROJECT_REF, SUPABASE_SERVICE_ROLE_KEY,
# LITELLM_BASE_URL, LITELLM_MASTER_KEY, E2B_API_KEY, JWT_SECRET (>=32 chars).
# Generate the JWT secret: openssl rand -hex 32

# Apply migrations to your Supabase project
# (Either via supabase CLI or by running the migrations/ files manually.)

# Run the server (port 3001 by default)
pnpm --filter @crucible/server dev

# In another terminal, run the web app (port 3000)
pnpm --filter @crucible/web dev

# Open http://localhost:3000
```

## Useful commands

```bash
pnpm typecheck                                          # both workspaces
pnpm build                                              # both workspaces
pnpm --filter @crucible/server dev                      # server with tsx watch
pnpm --filter @crucible/web dev                         # next dev

# Regenerate the Tier 1.5 fixture (deterministic)
pnpm exec tsx fixtures/fde-db-triage-pro/generate.ts

# Push a scenario row update to Supabase
pnpm exec tsx apps/server/scripts/encode-fde-db-triage-pro.ts

# Daily cost rollup against cost_ledger
pnpm --filter @crucible/server exec tsx scripts/check-daily-cost.ts

# Calibration verifiers (run against a live server)
pnpm --filter @crucible/server exec tsx scripts/verify-rehydrate.ts
pnpm --filter @crucible/server exec tsx scripts/verify-pro-discrimination.ts
```

## Deployment

- **Web**: auto-deploys to Vercel from `main`. Required env vars:
  `NEXT_PUBLIC_SERVER_URL` (the Railway URL),
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Server**: auto-deploys to Railway from `main`. Build command:
  `pnpm install --frozen-lockfile && pnpm --filter @crucible/server build`.
  Start: `pnpm --filter @crucible/server start`. Needs all server-only
  env vars from `.env.example` (excluding any `NEXT_PUBLIC_*`).
- **LiteLLM gateway**: hosted on Railway as a separate service.
  Provider keys (Anthropic / Gemini / OpenAI) live here only.
- **Supabase**: hosted (any tier with RLS support). Apply migrations
  in `supabase/migrations/` in numerical order on a fresh project.

## CI

GitHub Actions runs typecheck + build for both workspaces on every PR
and push to `main`. A daily cron at 09:00 UTC sums the previous day's
`cost_ledger` rows; the workflow fails (and GitHub emails you) if total
LiteLLM spend exceeds a threshold (`COST_ALERT_THRESHOLD_USD`, default
$10/day). Repo secrets required for the cron:
`SUPABASE_PROJECT_REF`, `SUPABASE_SERVICE_ROLE_KEY`.

## Status

MVP. Tier 1.5 scenario (`fde-db-triage-pro`) is calibrated — the
discrimination matrix passes all four checks (prioritization,
stakeholder-resistance, tier vs strict order, independence/gradient)
with a healthy score distribution. Operational resilience is wired:
sessions survive server restarts (E2B reconnect + LiteLLM re-mint),
the workspace fully hydrates on refresh, costs are alerted daily.

v-next shipped: passive proctoring + Suspicion Score, multi-tenant
orgs (API-key auth behind the `ORG_AUTH_REQUIRED` rollout flag;
admin via the `ORG_ADMIN_KEY` env var, partners via a link-embedded
key on the review surface),
cohort dashboards + public shareable reports, and difficulty-band
routing with calibration stats + equating. Migrations 0018–0022 are
applied to the live DB; see `docs/ARCHITECTURE-REPORT.md` §13.

Second scenario family now LIVE: `fde-api-integration` (API-integration
debugging, client persona Priya, native product-sense fork) was built dormant
and has been activated — migration 0023 applied, calibration passed, and the
`catalog_visible = true` flip run. It rides on a generic deliverable schema,
scenario-driven personas, and a `sqlite_master`-derived DB builder (family 1
byte-identical). Constraints v2 (migration 0025) tightened the in-fiction
budgets (tokens 50k, compute 30 min, memory 1 GiB).

Still built dormant (fully verified, deliberately OFF): proctoring v2
(consent-gated identity verification + webcam presence, per-org flag default
off — migration 0024 authored, unapplied). Activation is a manual runbook:
`docs/GOING-LIVE.md`; details in `docs/ARCHITECTURE-REPORT.md` §13.5–13.7.

Validity instrumentation: a READ-ONLY, admin-only dashboard at
`/review/validity` (`GET /api/admin/validity/*`; admin `X-Org-Key`
required — partner keys 403, key-less 401 even with
`ORG_AUTH_REQUIRED` off) with six views — discrimination,
not-assessed, distributions, correlation, exclusions, versions —
version-aware (legacy v1-judge segregated, never pooled),
scorable-only, and small-N-honest (numbers nulled server-side below
N=10 / paired-N=20). See `docs/ARCHITECTURE-REPORT.md` §13.8.

Costs dashboard: a READ-ONLY, admin-only billing cockpit at
`/review/costs` (`GET /api/admin/costs/*`, same admin gate as
validity) — LiteLLM gateway spend, internal per-session usage from
`sessions.spend_usd`, and fixed-plan service cards. See
`docs/ARCHITECTURE-REPORT.md` §13.9.

Web hardening shipped: a CSP + security headers on the Next.js app
(`frame-ancestors 'none'`, `connect-src` locked to self + server, HSTS)
made self-contained by a self-hosted Monaco editor (vendored under
`public/monaco/vs`, no CDN); a global Fastify error handler that collapses
unhandled 500s to a generic body; `trustProxy` for real client IPs. On the
candidate side, a deferred work clock + `OrientationOverlay` tutorial replaced
the old workspace tour (the clock starts on `POST /sessions/:id/start`).

Not yet shipped: per-candidate one-time invite codes (currently a
shared secret), audit log table.

## License

Private project. See `CLAUDE.md` for the operating contract.
