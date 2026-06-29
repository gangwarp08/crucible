# Crucible — Code Structure (MVP)

AI-conducted coding assessment platform. Candidates solve tasks in a real,
sandboxed dev environment while an AI interviewer observes; recruiters review
the session and its telemetry afterward.

## Architecture at a glance

- **`apps/web`** — Next.js (app router) front end. Talks ONLY to the stateful server.
- **`apps/server`** — Fastify stateful server. Owns sessions: creates E2B sandboxes,
  mints short-lived per-session LiteLLM keys, enforces budget + timeout, writes
  telemetry to Supabase.
- **`packages/shared`** — Zod schemas + shared types (session, assessment, telemetry).
- **`supabase/migrations`** — Postgres schema (with RLS).
- **`infra/e2b`** — E2B microVM template (Dockerfile + workspace) running candidate code.
- **`fixtures`** — scenario data (schema/seed/queries/ground truth) for FDE DB-triage tasks.

Data flow: Browser → Server → (E2B sandboxes | LiteLLM gateway | Supabase | Redis).
Models are reached only through the LiteLLM gateway; provider keys never live in this app.

## File tree

```
.claude/
  hooks/guard.js
  settings.json
  skills/
    e2b-api/SKILL.md
    litellm-budget/SKILL.md
.github/
  workflows/
    ci.yml
    cost-alert.yml
.env.example
.eslintrc.js .prettierrc .prettierignore .gitignore .mcp.json
CLAUDE.md
README.md
package.json  pnpm-workspace.yaml  turbo.json  tsconfig.json

apps/
  server/                          # Fastify stateful server
    src/
      index.ts                     # entry
      server.ts                    # app/route wiring
      env.ts                       # env validation
      routes/
        chat.ts                    # candidate <-> AI interviewer chat
        deliverable.ts             # submission/deliverable
        docs.ts                    # scenario docs
        files.ts                   # sandbox file read/write
        health.ts
        messages.ts                # message history
        pty.ts                     # terminal/PTY bridge
        query.ts                   # SQL query runner (scenarios)
        review.ts                  # recruiter review data
        scenarios.ts               # scenario catalog
        sessions.ts                # session lifecycle
      services/
        analysis-agent.ts          # post-session analysis
        analysis-input.ts
        compute-tracker.ts         # cost/compute accounting
        dataset-seed.ts
        db.ts                      # in-sandbox SQL DB helpers
        events-direct.ts
        litellm.ts                 # mint/scope per-session LiteLLM keys
        messaging.ts
        persona-agent.ts           # AI interviewer persona
        query-runner.ts
        registry.ts
        sandbox.ts                 # E2B sandbox lifecycle
        scenarios.ts
        scheduler.ts               # budget/timeout enforcement
        session-rehydrate.ts
        session-token.ts
        session.ts                 # core session state
        sqlrun.py.ts
        supabase.ts
        telemetry.ts               # telemetry writes
      session.test.ts
    scripts/                       # verify-*.ts harnesses + encode/seed helpers
    package.json  tsconfig.json  vitest.config.ts

  web/                             # Next.js front end
    src/
      app/
        layout.tsx  page.tsx  globals.css
        review/page.tsx  review/[id]/page.tsx     # recruiter review
        scenarios/page.tsx
        session/[id]/page.tsx                      # candidate workspace
        start/[slug]/page.tsx                      # session start
      components/
        landing/      # EmberCanvas, FlameCube, LandingPage
        review/       # CostPanel, FilesDiffPanel, Scorecard, SessionDetail,
                      # SessionSummary, SessionsTable, StatusBadge,
                      # TerminalReplay, Timeline, TranscriptPanel, format.ts
        start/        # ScenariosCatalog, StartScreen
        ui/           # Bubble, Button, Card, IconButton, Pill,
                      # SectionLabel, Stat, TabStrip, Wordmark
        workspace/    # BriefPanel, ChatHUD, ConstraintHUD, DataExplorer,
                      # DeliverablePanel, DocsViewer, Editor, EndScreen,
                      # FileTree, MarkdownView, Messages, Terminal,
                      # Workspace, WorkspaceLoader, WorkspaceTour
      lib/api.ts
      stores/sessionStore.ts
      styles/tokens.ts
    next.config.ts  package.json  tsconfig.json

packages/
  shared/
    src/
      index.ts
      schemas/        # assessment.ts, session.ts, telemetry.ts (Zod)
      types/index.ts
    package.json  tsconfig.json

supabase/
  migrations/
    0001_initial_schema.sql
    0002_telemetry_3_2.sql
    0003_fde_scenarios.sql
    0004_fde_db_triage_content.sql
    0005_merge_scenario_state_rpc.sql
    0006_fde_db_triage_pro_content.sql

infra/
  e2b/
    e2b.Dockerfile  e2b.toml
    workspace/index.js  workspace/package.json

fixtures/
  fde-db-triage/        # generate.ts, ground_truth.json, queries.sql,
  fde-db-triage-pro/    # scenario.json, schema.sql, seed.sql

docs/
  ARCHITECTURE.md
  architecture.html
  scenarios/crucible_scenario_fde-db-triage.md
```

## Stack

- TypeScript everywhere; pnpm workspaces monorepo; Turbo.
- Front end: Next.js (app router), Zustand store.
- Server: Fastify.
- Data: Supabase (Postgres + Auth + RLS), Redis (app-side session/rate-limit state).
- Sandboxes: E2B microVMs. Models: LiteLLM gateway only. Observability: Langfuse.
