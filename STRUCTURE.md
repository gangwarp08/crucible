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
        chat.ts                    # candidate <-> AI assistant chat (rolling
                                   #   last-2-exchange context, in-memory only)
        costs.ts                   # ADMIN-ONLY READ-ONLY costs dashboard
                                   #   (/api/admin/costs/* — same requireAdmin
                                   #   gate as validity.ts)
        deliverable.ts             # submission/deliverable
        docs.ts                    # scenario docs
        files.ts                   # sandbox file read/write
        health.ts
        integrity.ts               # passive proctoring signals (integrity.* events)
        messages.ts                # unified persona chat WS + history (one
                                   #   thread, both personas; channel = addressee)
        outcomes.ts                # partner outcome webhook + feedback invites
        proctoring.ts              # proctoring v2 surface (DORMANT — org flag): consent,
                                   #   identity-verify, org-scoped identity-delete
        pty.ts                     # terminal/PTY bridge
        query.ts                   # SQL query runner (scenarios)
        report.ts                  # PUBLIC shareable candidate report (token-gated)
        review.ts                  # recruiter review data (org-scoped via X-Org-Key)
        scenarios.ts               # scenario catalog
        sessions.ts                # session lifecycle
        validity.ts                # ADMIN-ONLY READ-ONLY validity instrumentation
                                   #   (/api/admin/validity/* — six views; fails closed
                                   #   even with ORG_AUTH_REQUIRED off)
      services/
        ai-fluency.ts              # presentation-only AI-Fluency placement
        analysis-agent.ts          # post-session analysis
        analysis-input.ts
        cohort.ts                  # per-scenario cohort aggregates (org-scoped)
        compute-tracker.ts         # cost/compute accounting
        costs.ts                   # READ-ONLY costs aggregation (LiteLLM gateway spend,
                                   #   sessions.spend_usd usage, FIXED_SERVICES cards)
        dataset-seed.ts
        db.ts                      # in-sandbox SQL DB helpers
        difficulty-routing.ts      # band -> scenario-family sibling (at creation only)
        difficulty-stats.ts        # competency_difficulty_stats accumulator
        equating.ts                # cross-band equating readout
        events-direct.ts
        geo-integrity.ts           # server-authored geo/network integrity
                                   #   (vendored GeoLite2 via maxmind; raw IPs
                                   #   never persisted — per-session-salted hash)
        litellm.ts                 # mint/scope per-session LiteLLM keys
        live-stream.ts             # READ-ONLY tail for live-session SSE monitoring
        messaging.ts               # WS broadcast + the single persona promise
                                   #   chain (runOnPersonaChain; verifier separate)
        orgs.ts                    # org resolution + API key / webhook secret minting
        persona-agent.ts           # scenario personas — fully DB-driven (no
                                   #   hardcoded family path); unified shared-
                                   #   context chat; differential misleading
                                   #   hints on the hard sims (migration 0026)
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
                                   #   v4: +geo/network factors, copy/paste now
                                   #   informational-only)
        telemetry.ts               # telemetry writes
        validity.ts                # READ-ONLY validity aggregation (version-aware,
                                   #   scorable-only, min-N gates N>=10 / paired-N>=20)
        workspace-readme.ts        # guarded in-sandbox README generator —
                                   #   renderGuardedReadme() hard-fails provisioning
                                   #   (ReadmeLeakError) if rendered onboarding text
                                   #   would leak ground truth / never-reveals
      session.test.ts
    data/
      GeoLite2-Country.mmdb        # vendored country-only geo DB (~8.5 MB, read via maxmind)
    scripts/                       # verify-*.ts harnesses (~70+, incl. verify-tenant-isolation.ts,
                                   #   verify-family2-*.ts + verify-family1-drift-inert.ts +
                                   #   verify-cross-family-scale.ts (family 2, now LIVE),
                                   #   verify-persona-scenario-driven.ts, verify-geo-integrity.ts,
                                   #   verify-live-monitoring.ts, verify-error-redaction.ts,
                                   #   verify-proctoring-v2-flag / identity-verify /
                                   #   biometric-retention (dormant proctoring v2), the six
                                   #   validity-dashboard gates: verify-validity-access /
                                   #   not-assessed / exclusions / discrimination-view /
                                   #   correlation-view / version-panel,
                                   #   verify-costs-dashboard.ts, and the newest
                                   #   verify-shared-context.ts (unified-chat
                                   #   cross-persona visibility, no knowledge bleed)
                                   #   + verify-workspace-readme.ts (README leak
                                   #   guard + real-E2B provision check))
                                   # + encode/seed helpers + mint-org-key.ts
    package.json  tsconfig.json  vitest.config.ts

  web/                             # Next.js front end
    src/
      app/
        layout.tsx  page.tsx  globals.css
        report/[token]/page.tsx                    # public shared candidate report (print-CSS PDF)
        review/page.tsx  review/[id]/page.tsx     # recruiter review
        review/cohorts/[scenarioId]/page.tsx       # cohort dashboard
        review/costs/page.tsx                      # admin-only READ-ONLY costs dashboard
        review/validity/page.tsx                   # admin-only READ-ONLY validity dashboard
        scenarios/page.tsx
        session/[id]/page.tsx                      # candidate workspace
        start/[slug]/page.tsx                      # session start (consumes ?link= token)
      components/
        landing/      # EmberCanvas, FlameCube, LandingPage
        review/       # AdminNavLinks (admin-probe nav links, replaces
                      # ValidityNavLink), CohortDashboard, CostPanel,
                      # CostsDashboard, FilesDiffPanel, LiveStatusStrip +
                      # useLiveSession (read-only live SSE monitoring),
                      # OrgKeyInput, OutcomeInvitePanel (partner-feedback links,
                      # first in the detail rail), PersonaMessagesPanel,
                      # Scorecard, SessionDetail (overview header + tabbed
                      # evidence + sticky rail redesign), SessionLinkMintPanel,
                      # SessionSummary, SessionsTable, ShareReportModal,
                      # SqlHistoryPanel, StatusBadge, SuspicionPanel (now +geo
                      # network row), TerminalReplay, Timeline,
                      # TranscriptPanel, ValidityDashboard, format.ts
        start/        # ScenariosCatalog, StartScreen, IdentityCapture (dormant
                      # proctoring-v2 consent + ID/selfie capture)
        ui/           # Bubble, Button, Card, IconButton, Pill,
                      # SectionLabel, Stat, TabStrip, Wordmark
        workspace/    # BriefPanel (+ "What you have" inventory: tables/docs/
                      # people from scenario metadata), ChatHUD (+ short-memory
                      # disclaimer), ConstraintHUD (static pre-start time under
                      # the deferred clock; token_exhausted ≠ read-only),
                      # DataExplorer, DeliverablePanel, DocsViewer, Editor
                      # (self-hosted Monaco → /monaco/vs), EndScreen, FileTree,
                      # MarkdownView, Messages (UNIFIED chat: one merged
                      # persona thread + recipient toggle; Reviewer sub-tab
                      # hidden unless the dormant verifier speaks),
                      # OrientationOverlay (scenario-grounded entry tutorial;
                      # starts the clock — replaced WorkspaceTour),
                      # Terminal, Workspace, WorkspaceLoader
      lib/api.ts
      lib/integrity.ts             # useIntegrityMonitor hook (passive proctoring)
      lib/proctoring.ts            # dormant proctoring-v2 client plumbing (consent, config)
      lib/webcam-presence.ts       # dormant in-browser presence heuristic (frames never leave)
      lib/ai-fluency.ts
      stores/sessionStore.ts
      styles/tokens.ts
    public/monaco/vs/              # self-hosted Monaco editor build (no CDN;
                                   #   declared a turbo build output so the
                                   #   remote cache can't restore a build without it)
    public/demo-asaya.mp4          # self-hosted landing demo video (CSP: no external hosts)
    scripts/copy-monaco.mjs        # build step: vendor Monaco into public/monaco/vs
    next.config.ts                 # CSP + security headers (frame-ancestors none,
                                   #   connect-src self+server, HSTS; no external hosts)
    package.json  tsconfig.json

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
    0023_family2_api_integration.sql  # APPLIED: family 2 seed + scenarios.catalog_visible
                                      #   (family 2 since flipped to catalog_visible=true — LIVE)
    0024_proctoring_v2.sql            # AUTHORED-UNAPPLIED: identity_checks (derived data only)
    0025_constraints_v2.sql           # APPLIED: tighten in-fiction constraints
                                      #   (tokens 50k, compute 30m, memory 1 GiB)
    0026_differential_hints.sql       # APPLIED: sync the two hard sims' team
                                      #   persona to the differential misleading
                                      #   hint (personas fully DB-driven)

infra/
  e2b/
    e2b.Dockerfile  e2b.toml
    workspace/index.js  workspace/package.json

fixtures/
  fde-db-triage/        # generate.ts, ground_truth.json, queries.sql,
  fde-db-triage-pro/    # scenario.json, schema.sql, seed.sql
  fde-api-integration/  # family 2 (LIVE) — canonical mid-band scenario.json (client
                        #   persona Priya), generate.ts, schema/seed/ground_truth; the
                        #   -iso and -pro sibling dirs are committed alongside (migration
                        #   0023 seeds all three dataset_refs)

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
