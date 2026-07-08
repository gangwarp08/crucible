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
        integrity.ts               # passive proctoring signals (integrity.* events)
        messages.ts                # message history
        outcomes.ts                # partner outcome webhook + feedback invites
        proctoring.ts              # proctoring v2 surface (DORMANT — org flag): consent,
                                   #   identity-verify, org-scoped identity-delete
        pty.ts                     # terminal/PTY bridge
        query.ts                   # SQL query runner (scenarios)
        report.ts                  # PUBLIC shareable candidate report (token-gated)
        review.ts                  # recruiter review data (org-scoped via X-Org-Key)
        scenarios.ts               # scenario catalog
        sessions.ts                # session lifecycle
      services/
        ai-fluency.ts              # presentation-only AI-Fluency placement
        analysis-agent.ts          # post-session analysis
        analysis-input.ts
        cohort.ts                  # per-scenario cohort aggregates (org-scoped)
        compute-tracker.ts         # cost/compute accounting
        dataset-seed.ts
        db.ts                      # in-sandbox SQL DB helpers
        difficulty-routing.ts      # band -> scenario-family sibling (at creation only)
        difficulty-stats.ts        # competency_difficulty_stats accumulator
        equating.ts                # cross-band equating readout
        events-direct.ts
        litellm.ts                 # mint/scope per-session LiteLLM keys
        messaging.ts
        orgs.ts                    # org resolution + API key / webhook secret minting
        persona-agent.ts           # AI interviewer persona
        proctoring-v2.ts           # DORMANT: consent recording, gateway-vision identity
                                   #   match (raw images in-memory only), biometric deletion
        query-runner.ts
        registry.ts
        report-share.ts            # mint/list/revoke shareable report tokens
        sandbox.ts                 # E2B sandbox lifecycle
        scenarios.ts
        scheduler.ts               # budget/timeout enforcement
        session-rehydrate.ts
        session-token.ts
        session.ts                 # core session state
        shared-report.ts           # public report payload (strict Zod allowlist)
        sqlrun.py.ts
        supabase.ts
        suspicion-score.ts         # deterministic 0-100 integrity score (never scored;
                                   #   v2 adds dormant webcam-presence factors)
        telemetry.ts               # telemetry writes
      session.test.ts
    scripts/                       # verify-*.ts harnesses (~59, incl. verify-tenant-isolation.ts,
                                   #   verify-family2-*.ts + verify-family1-drift-inert.ts +
                                   #   verify-cross-family-scale.ts (dormant family 2) and
                                   #   verify-proctoring-v2-flag / identity-verify /
                                   #   biometric-retention (dormant proctoring v2))
                                   # + encode/seed helpers + mint-org-key.ts
    package.json  tsconfig.json  vitest.config.ts

  web/                             # Next.js front end
    src/
      app/
        layout.tsx  page.tsx  globals.css
        report/[token]/page.tsx                    # public shared candidate report (print-CSS PDF)
        review/page.tsx  review/[id]/page.tsx     # recruiter review
        review/cohorts/[scenarioId]/page.tsx       # cohort dashboard
        scenarios/page.tsx
        session/[id]/page.tsx                      # candidate workspace
        start/[slug]/page.tsx                      # session start (consumes ?link= token)
      components/
        landing/      # EmberCanvas, FlameCube, LandingPage
        review/       # CohortDashboard, CostPanel, FilesDiffPanel, OrgKeyInput,
                      # Scorecard, SessionDetail, SessionLinkMintPanel,
                      # SessionSummary, SessionsTable, ShareReportModal,
                      # StatusBadge, SuspicionPanel, TerminalReplay, Timeline,
                      # TranscriptPanel, format.ts
        start/        # ScenariosCatalog, StartScreen, IdentityCapture (dormant
                      # proctoring-v2 consent + ID/selfie capture)
        ui/           # Bubble, Button, Card, IconButton, Pill,
                      # SectionLabel, Stat, TabStrip, Wordmark
        workspace/    # BriefPanel, ChatHUD, ConstraintHUD, DataExplorer,
                      # DeliverablePanel, DocsViewer, Editor, EndScreen,
                      # FileTree, MarkdownView, Messages, Terminal,
                      # Workspace, WorkspaceLoader, WorkspaceTour
      lib/api.ts
      lib/integrity.ts             # useIntegrityMonitor hook (passive proctoring)
      lib/proctoring.ts            # dormant proctoring-v2 client plumbing (consent, config)
      lib/webcam-presence.ts       # dormant in-browser presence heuristic (frames never leave)
      lib/ai-fluency.ts
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
    0007 … 0017                    # competency model, evidence units, outcomes,
                                   # scenario families, lifecycle, session links
    0018_orgs.sql                  # multi-tenant orgs (org_id NOT NULL everywhere)
    0019_org_rls_posture.sql       # deny-all RLS posture on tenant tables
    0020_difficulty_calibration.sql  # sessions.difficulty_band + competency_difficulty_stats
    0021_report_shares.sql         # shareable candidate report tokens
    0022_session_link_band.sql     # session_links.difficulty_band
    0023_family2_api_integration.sql  # AUTHORED-UNAPPLIED: family 2 seed (catalog_visible=false)
    0024_proctoring_v2.sql            # AUTHORED-UNAPPLIED: identity_checks (derived data only)

infra/
  e2b/
    e2b.Dockerfile  e2b.toml
    workspace/index.js  workspace/package.json

fixtures/
  fde-db-triage/        # generate.ts, ground_truth.json, queries.sql,
  fde-db-triage-pro/    # scenario.json, schema.sql, seed.sql
  fde-api-integration/  # family 2 (DORMANT) — canonical mid-band scenario.json,
                        #   generate.ts, schema/seed/ground_truth; the -iso and -pro
                        #   sibling dirs are committed alongside (migration 0023 seeds
                        #   all three dataset_refs)

docs/
  ARCHITECTURE.md
  ARCHITECTURE-REPORT.md
  GOING-LIVE.md         # operator runbook: activating the dormant builds
  architecture.html
  scenarios/crucible_scenario_fde-db-triage.md
```

## Stack

- TypeScript everywhere; pnpm workspaces monorepo; Turbo.
- Front end: Next.js (app router), Zustand store.
- Server: Fastify.
- Data: Supabase (Postgres + Auth + RLS), Redis (app-side session/rate-limit state).
- Sandboxes: E2B microVMs. Models: LiteLLM gateway only. Observability: Langfuse.
