# Pilot-readiness plan (slices 6.1–6.8)

One-trusted-partner pilot readiness. Scope = lock the live gaming hole, make
"scored" mean "fairly scorable", fence the judge, and harden the operational
edges. Proctoring / DDoS / external pentest / multi-tenant RLS are GA / second-
partner concerns (§7 non-goals) — explicitly deferred.

Continues the asaya-v1 conventions: per-slice migration + `verify-*.ts` against
real infra, wired into `pnpm regression`.

## Reconciliation with the live repo (resolves the plan's stale assumptions)

- **Migration numbers.** `0007`–`0013` are USED (`0013 = outcome_invites`). So
  the plan's "migration 0013" → **`0014`** (lifecycle columns), and "0014"
  (competency gating) → **`0015`**.
- **Session status is free TEXT** (`sessions.status`, default `'active'`; no enum
  / CHECK today). New statuses `submitted`, `defending` need **no migration** —
  only the new *columns* do. We will NOT add a restrictive CHECK (it would reject
  legacy `timed_out` rows).
- **Current enums:** `status ∈ {active, completed, timed_out}` (set in
  `db.ts:finalizeSession`, `timeout → 'timed_out'`); `EndReason = timeout |
  manual | budget | orphaned` (`services/session.ts`).
- `routes/health.ts` is a stub. `services/{scheduler,compute-tracker,session}.ts`
  exist. `services/scorability.ts` is NEW. `analysis-agent.parseAndValidate`
  currently fills missing competencies with `score:1` (RD4 changes this).

## Open questions — resolved (Q1–Q5)

- **Q1 timed_out reconciliation.** KEEP `timed_out` as a legacy terminal status
  for existing rows; do NOT backfill (migration-safe, never rewrite history).
  NEW sessions use the progression `active → … → completed` with
  `end_reason=timeout`. Treat `end_reason` as the source of truth for "how it
  ended"; lifecycle/scorability code accepts `timed_out` as equivalent to
  `completed + end_reason=timeout`. Extend `EndReason` with `error`, `aborted`.
- **Q2 floors.** Start: non-empty deliverable; active duration **≥ 10 min OR ≥ 20
  meaningful candidate events** (db.query / message.*.candidate / deliverable.* /
  ai.assistant.candidate); evidence units on **≥ 3 load-bearing competencies**.
  Constants in `services/scorability.ts` (`SCORABILITY_THRESHOLDS`), recalibrated
  on cohort 1; later promote to scenario config.
- **Q3 advisory-cap UX.** **Per-session** confirm/override for the pilot (N tiny;
  the cap is execution-only today = one decision/session). Per-competency is a
  GA refinement.
- **Q4 re-scoring policy.** **Lazy / on-demand only** (matches 5.7). Scorability
  recomputes when evidence_units are re-extracted or on an explicit review
  action; never an eager background sweep.
- **Q5 SHA injection.** Server `/health` reads `RAILWAY_GIT_COMMIT_SHA` (Railway
  injects it). Web (if surfaced later) uses `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`.
  H7 is server-side, so `RAILWAY_GIT_COMMIT_SHA` is sufficient.

## Build sequence

| Slice | Item | Migration | Acceptance |
|---|---|---|---|
| 6.8e | H7 `/health` SHA + flags (do FIRST — cheap, prevents stale-prod) | — | `GET /health` returns deployed SHA |
| 6.1 | Session lifecycle state machine | **0014** (5 columns) | verify-session-lifecycle.ts |
| 6.2 | RD1 submit-and-lock (closes live gaming hole) | — | verify-submit-lock.ts |
| 6.3 | RD2 verification outcomes + advisory cap | — (flag) | verify-verification-outcomes.ts |
| 6.4 | RD3 scorability + reason codes | uses 0014 | verify-scorability.ts |
| 6.5 | RD4 competency gating | **0015** (items.score nullable + assessed) | verify-competency-gating.ts |
| 6.6 | RD5 judge fencing | — | verify-judge-injection.ts |
| 6.7 | RD6 session-link integrity | — | verify-session-link.ts |
| 6.8 | Hardening H1 (secret audit), H2 (budgets fail-closed + global breaker), H3 (egress), H6 (fail-clean) | — | per-item verifies |

Order rationale: **6.8e first** (cheap, stops another stale-prod loss), then
**6.1 → 6.2** (lifecycle + the live gaming hole). After **6.4**, re-run
discrimination/gradient — gating must not regress separation.

## Per-slice grounding (files touched)

- **6.8e /health** — `routes/health.ts`: return `{status, commit, migration?,
  flags:{verification_enabled, pilot_verification_advisory, outcome_webhook}}`.
  No migration.
- **6.1 lifecycle** — migration `0014`: `sessions += deliverable_locked_at,
  defense_outcome ({coherent,weak,declined,not_reached}), scorable bool null,
  exclusion_reason text null, verification_cap_status text null
  ({none,applied,advisory_pending,confirmed,overridden})`. New
  `services/session-lifecycle.ts` (legal-transition map + `transition()`); wire
  into `session.ts` (deadline path: active → auto-lock → defending → completed,
  end_reason=timeout). `EndReason += error, aborted`.
- **6.2 RD1** — `services/session.ts` `assertWorkspaceWritable(session)` (throws
  409 unless status==='active'); guard `routes/files.ts`, `pty.ts`, `chat.ts`,
  `deliverable.ts`, `query.ts`. Immutable deliverable snapshot (event seq). Web:
  `DeliverablePanel` confirm modal; read-only workspace driven off session status.
- **6.3 RD2** — `verifier-agent.ts` sets `defense_outcome`; weak → `defense_weak`
  unit + execution cap, but behind `PILOT_VERIFICATION_ADVISORY=true` records
  `verification_cap_status=advisory_pending` (official score unchanged until a
  human confirms). New `POST /api/review/sessions/:id/verification-cap {decision}`.
- **6.4 RD3** — NEW `services/scorability.ts` (recomputable; reads evidence_units
  + session); reason codes `excluded_{infra,abandoned,no_deliverable,
  defense_unreachable,insufficient_evidence}`; surfaced in review.
- **6.5 RD4** — migration `0015`: `evaluation_items.score` nullable + `assessed
  boolean`. `analysis-agent.parseAndValidate`: missing/zero-evidence →
  `assessed=false, score=null` (not 1); overall reweights over assessed only.
- **6.6 RD5** — `services/analysis-input.ts`: deterministic units are the primary
  score; candidate text delimited + labeled untrusted in the judge prompt.
- **6.7 RD6** — `services/session-token.ts`: single-use, candidate-bound,
  time-boxed start token; consumed on first start; can't restart/hijack.
- **6.8 hardening** — H1 secret audit note (`docs/`), H2 fail-closed budgets +
  `GLOBAL_DAILY_SPEND_CEILING_USD` breaker in `routes/sessions.ts`, H3 E2B egress
  default-deny, H6 fail-clean terminal states.

## Non-negotiables (CLAUDE.md) + non-goals — unchanged from the brief (§6/§7).

## Final gate — internal adversarial dry run with verification ON (§5) before any
real partner candidate.
