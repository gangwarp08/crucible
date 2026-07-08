# asaya — Architecture, modules, and operating guide

> **Audience:** anyone joining the project, or returning to it after a break.
> **Goal:** in one read you should be able to (a) describe what every directory
> does, (b) trace any user-visible interaction down to a row in Supabase, and
> (c) know what to monitor in production.

---

## TL;DR (3 paragraphs)

**asaya is an AI-conducted coding assessment platform.** A candidate
clicks a link, lands on a brief, clicks Begin, and gets dropped into a
sandboxed dev environment with a file tree, an editor, a terminal, a SQL
data explorer, a chat with two AI personas (a client and a teammate), an
AI assistant, and a deliverable form. They have a timer, a token budget,
and a compute budget. While they work, the personas reach out unprompted
according to a scripted beat schedule. When time runs out — or they
submit and end the session — an **Analysis Agent** scores everything
they did against an 8-competency rubric. A recruiter later reviews the
session timeline + scorecard.

**Three layers.** The **browser** is a Next.js (app router) app that
talks ONLY to our own server. The **server** is a Fastify process that
owns sessions: it provisions E2B microVMs for the sandbox, mints
short-lived per-session keys for LiteLLM (our only path to model
providers), writes telemetry to Supabase, and runs the persona engine.
The **external infra** is E2B (sandboxes), LiteLLM on Railway (the model
gateway — provider keys live ONLY there, never in this app), Supabase
(Postgres + Auth + RLS), and Redis (rate-limit + session-side state).

**Everything is session-scoped.** A `sessions.id` UUID is the central
key in the DB and the central object in server memory. Every event,
every persona turn, every file save, every cost line, every evaluation
joins back to a session. The in-memory `sessionRegistry` Map holds the
live wiring (sandbox handle, WebSockets, persona state, scenario
mechanics); Supabase holds the durable record. If the server restarts
mid-session, telemetry is preserved but live wiring is lost — that's
the source of the orphan-teardown fallback in `destroySandbox`.

---

## The system in one diagram

```
                          ┌─────────────────────────────┐
                          │       BROWSER (Next.js)     │
                          │  /start/[slug] · /session/* │
                          │  /review · /review/[id]     │
                          └──────┬───────────────────┬──┘
                          REST  │            WS     │
                                ▼                   ▼
              ┌─────────────────────────────────────────────────┐
              │              SERVER (Fastify)                   │
              │                                                 │
              │  routes/    POST /sessions       sessions.ts    │
              │             GET  /sessions/:id                  │
              │             DEL  /sessions/:id                  │
              │             POST /api/chat       chat.ts        │
              │             POST /api/sessions/:id/query        │
              │             POST /api/sessions/:id/deliverable  │
              │             GET  /api/scenarios/:slug           │
              │             GET  /api/review/*                  │
              │             WS   /pty/:sessionId                │
              │             WS   /messages/:sessionId           │
              │                                                 │
              │  services/  sessionRegistry  (in-memory map)    │
              │             scenarios + personas + scheduler    │
              │             sandbox lifecycle                   │
              │             litellm (mint/revoke session keys)  │
              │             telemetry buffers + flusher         │
              │             analysis-agent (the judge)          │
              └────┬───────────────┬───────────────┬────────┬───┘
                   │               │               │        │
                   ▼               ▼               ▼        ▼
            ┌──────────┐   ┌────────────┐   ┌───────────┐ ┌──────┐
            │  E2B     │   │  LiteLLM   │   │ Supabase  │ │Redis │
            │ microVM  │   │  Railway   │   │  Postgres │ │      │
            │ (Python  │   │  gateway   │   │   + Auth  │ │ rate │
            │  + SQL)  │   │ provider→  │   │   + RLS   │ │ limit│
            │          │   │ Anthropic/ │   │           │ │      │
            │          │   │ OpenAI/    │   │ sessions  │ │      │
            │          │   │ Gemini     │   │ events    │ │      │
            │          │   │            │   │ transcript│ │      │
            │          │   │            │   │ cost_…    │ │      │
            │          │   │            │   │ evaluations│ │      │
            └──────────┘   └────────────┘   └───────────┘ └──────┘
```

**Hard rules (from CLAUDE.md):**
- The browser NEVER talks to E2B, LiteLLM, or Supabase directly.
- Provider keys (Anthropic / OpenAI / Gemini) NEVER appear in app env —
  only on the Railway LiteLLM service.
- Server-only env: `LITELLM_MASTER_KEY`, `E2B_API_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`. Only
  `NEXT_PUBLIC_*` may reach the client.

---

## The three layers, in detail

### Layer 1 — Browser (`apps/web/`)

Next.js 15 app router, React 19, zustand for state, **inline styles**
sourced from `src/styles/tokens.ts`. After the Week 6 UI overhaul, a tiny
`src/app/globals.css` handles hover/focus pseudo-classes, scrollbars,
and `react-resizable-panels` drag handles.

```
apps/web/src/
  app/
    layout.tsx          loads Inter + JetBrains Mono via next/font; imports globals.css
    page.tsx            redirects /  →  /start/fde-db-triage
    start/[slug]/       candidate landing page (brief, constraints, Begin)
    session/[id]/       the workspace
    review/             recruiter list
    review/[id]/        recruiter session detail
    globals.css         body resets, focus rings, data-hover, scrollbars
  components/
    start/              StartScreen.tsx — the landing UX
    workspace/          the IDE itself (see below)
    review/             the recruiter surface (see below)
    ui/                 8 shared primitives (Button, Card, Pill, Bubble, Stat,
                        TabStrip, SectionLabel, IconButton)
  stores/
    sessionStore.ts     zustand singleton; sessionId, deadline, status, balances,
                        scenario presentation, endedAt
  lib/
    api.ts              EVERY HTTP call to the server — typed wrappers
  styles/
    tokens.ts           color/space/radius/font/size/shadow tokens
```

**The workspace is a resizable 3-pane IDE.** From left to right:

| Pane           | Default | Min | Contents                                                |
|----------------|--------:|----:|---------------------------------------------------------|
| File tree      | 18%     | 10% | `FileTree` — lists `/workspace` recursively              |
| Editor         | 50%     | 25% | Monaco (`vs-dark`, ts/py/sql, automatic layout)         |
| Tool panel     | 32%     | 20% | 7-tab strip + always-mounted panes                      |

The 7 tabs (in workflow order): **Brief · Docs · Messages · Data ·
Terminal · Assistant · Deliverable**. All seven stay mounted (`display:
block / none`) so the PTY WS, messaging WS, and chat state survive tab
switches. Pane sizes persist to `localStorage` under
`crucible.workspace.layout.v1`.

The top **chrome row** (44px) merges scenario title + role/difficulty
pill with the live `ConstraintHUD` (Time / Tokens / Compute / Money /
Memory). Time, Tokens, Compute are live (color-coded as they cross
warning thresholds). Money + Memory are static context.

When `sessionStore.status === "ended"` an **EndScreen** overlay covers
the workspace — same overlay regardless of end reason (timer, manual
DELETE, budget exhausted).

### Layer 2 — Server (`apps/server/`)

Fastify, TypeScript, single process. The dev loop is `tsx watch
src/index.ts`. Everything is module-level — no DI, no factory pattern.
The in-memory `sessionRegistry` Map is the single source of in-flight
truth.

```
apps/server/src/
  index.ts              dotenv bootstrap; await buildServer(); listen; SIGTERM cleanup
  server.ts             registers helmet, CORS, rate-limit, JWT (optional), WS plugin,
                        and every routes/ file; starts the beat scheduler
  env.ts                strict env loader with Zod — fails fast on misconfig

  routes/               (HTTP + WS endpoints)
    health.ts             GET /health
    sessions.ts           POST/GET/DELETE /sessions[/:id]
    files.ts              GET /files /file ; PUT /file
    pty.ts                WS /pty/:sessionId — attached to sandbox PTY
    messages.ts           WS /messages/:sessionId — persona chat channel
    chat.ts               POST /api/chat — AI assistant turn
    query.ts              POST /api/sessions/:id/query — read-only SQLite
    docs.ts               GET  /api/sessions/:id/docs ; POST .../docs/:docId/view
    deliverable.ts        GET/POST /api/sessions/:id/deliverable
    scenarios.ts          GET /api/scenarios/:slug — candidate-safe scenario lookup
    review.ts             GET /api/review/sessions ; .../sessions/:id ;
                          POST .../sessions/:id/evaluate  (manual re-eval)

  services/             (cross-cutting business logic)
    registry.ts           in-memory SessionEntry shape + the Map
    sandbox.ts            createSandbox / destroySandbox / orphanTeardown
                          (E2B lifecycle, scenarioState seed, beat scheduling)
    session.ts            expireSession (shared teardown path — telemetry, sockets,
                          LiteLLM revoke, sandbox kill, auto-eval)
    litellm.ts            mint/revoke per-session keys; chatCompletionWithMessages
                          (all model calls go through this)
    persona-agent.ts      LLM-driven Client (Dana) + Team (Sam) personas; reactive
                          and proactive beats; reveal-flag state machine
    scheduler.ts          15-second sweep loop; fires due-but-unfired proactive beats
    messaging.ts          WS broadcast helpers for messages.ts
    telemetry.ts          buffered events + transcript + cost ledger flush to Supabase
    events-direct.ts      registry-bypass appendEvent — used by analysis-agent on
                          sessions whose in-memory entry is gone
    db.ts                 thin Supabase writers (sessions row create/update/finalize,
                          loadSessionRow, persistScenarioStatePatch via RPC)
    supabase.ts           single service-role Supabase client; null when env missing
    scenarios.ts          loadScenarioById / loadScenarioBySlug
    analysis-input.ts     assembleAnalysisInput — condenses telemetry into the JSON
                          payload the judge sees
    analysis-agent.ts     the judge: SYSTEM_PROMPT + parseAndValidate + persist
                          evaluations + evaluation_items rows
    compute-tracker.ts    deductComputeMinutes — for db.query + sandbox commands
    query-runner.ts       runs an SQL query via a Python helper inside the sandbox
    sqlrun.py.ts          the Python helper, embedded as a TS string for atomic copy
    dataset-seed.ts       copies the scenario's seed.sql + creates customer.db inside
                          the freshly-booted sandbox

  scripts/              (one-off ops + the calibration verifiers — see § Calibration)
    encode-fde-db-triage.ts       upsert fixtures/fde-db-triage/scenario.json → DB
    apply-migration-0005.sh       creates the merge_scenario_state RPC
    verify-*.ts                   end-to-end verifiers (one per slice)
```

### Layer 3 — External infrastructure

- **E2B** — provides isolated Linux microVMs from a template called
  `crucible-dev` (Python 3, sqlite3, common system tools). The server
  is the only thing that touches E2B; `E2B_API_KEY` lives in server env.
  Every sandbox is created with `metadata.sessionId` for traceability.
- **LiteLLM** (hosted on Railway) — the ONLY way the platform reaches
  Anthropic, OpenAI, or Gemini. The server authenticates with
  `LITELLM_MASTER_KEY` to mint per-session keys via `/key/generate`
  with `max_budget` + `duration` set. Per-session keys cap cost +
  expire on their own.
- **Supabase** — Postgres + Auth + Row-Level Security. The server uses
  the service-role key (server-only). The browser never queries Supabase
  directly — every recruiter read goes through `/api/review/*`.
- **Redis** — app-side rate limiting (via `@fastify/rate-limit`) and
  session-side state. Currently lightly used.
- **Langfuse** (planned) — our own debugging observability. Not
  candidate- or recruiter-facing.

---

## The mental model: session = the unit of everything

A **session** is the central object. Every other entity hangs off it.

```
SESSIONS                    (durable Supabase row + in-memory SessionEntry)
   ├── sandbox_id           ←→ one E2B microVM
   ├── litellm_key_alias    ←→ one per-session LiteLLM key
   ├── scenario_id          ←→ the FDE simulation it's bound to (nullable)
   ├── scenario_state       ←→ live game-mechanic ledger (tokens, compute,
   │                            personas reveal flags, scheduled_beats,
   │                            deliverable)
   ├── events[]             ←→ append-only timeline (every action)
   ├── transcript[]         ←→ every persona / assistant LLM turn (full text)
   ├── file_snapshots[]     ←→ deduped file content versions
   ├── cost_ledger[]        ←→ per-LLM-call USD attribution
   └── evaluations          ←→ the Analysis Agent scorecard (1 per session)
        └── evaluation_items[]   8 per-competency rows
```

The Supabase row is durable. The `SessionEntry` in
`apps/server/src/services/registry.ts` is the live wiring (sandbox
handle, WebSocket sets, telemetry buffer, personaState, scheduled
beats, etc.). When `tsx watch` reloads or the server restarts mid-
session, the in-memory entry is lost — that's exactly the orphan path
`destroySandbox` now handles by reading the sessions row + best-effort
killing the sandbox via `Sandbox.connect(sandbox_id)`.

---

## Flow 1 — Candidate runs an assessment

Walking through what happens between `/start/fde-db-triage` and the
EndScreen, with module names.

1. **Landing.** Browser hits `/start/fde-db-triage` (Next server
   component → `StartScreen` client component). `StartScreen` calls
   `GET /api/scenarios/fde-db-triage` (`apps/server/src/routes/scenarios.ts`),
   which reads the row via `loadScenarioBySlug` and returns ONLY the
   candidate-safe fields (no rubric, no personas, no ground truth).

2. **Begin.** Click → `createSession({ scenarioId })` (lib/api.ts) →
   `POST /sessions` (routes/sessions.ts) → `createSandbox`
   (services/sandbox.ts):
   - `loadScenarioById` reads rubric + constraints + personas.
   - `Sandbox.create("crucible-dev", { timeoutMs: SESSION_TIMEOUT_MIN * 60_000,
     metadata: { sessionId } })` provisions the E2B microVM.
   - `mintSessionKey(sessionId)` → LiteLLM POST `/key/generate` with
     `key_alias: "session-${sessionId}"`, `max_budget: SESSION_BUDGET_USD`,
     `duration: ${SESSION_TIMEOUT_MIN}m`. Returns the secret key (held
     ONLY in memory on `SessionEntry.litellmKey`).
   - `seedScenarioDataset` copies the scenario's `seed.sql` into the
     sandbox + initializes `/workspace/customer.db` (read-only SQLite).
   - `computeScheduledBeats` reads `scenario.curveballs[]`, applies any
     `beatTimingOverridesMs` (dev/test knob), and computes absolute
     `due_ts` per beat.
   - Build `scenarioState` from `scenario.constraints` (tokens,
     compute_minutes, money_usd, memory_mb) + the persona-reveal flag
     sub-objects.
   - `sessionRegistry.set(sessionId, …)` — the live entry is born.
   - `persistSessionCreated(sessionId)` writes the durable row.
   - `setTimeout(() => expireSession(sessionId, "timeout"), timeoutMs)` —
     the kill switch.
   - `logEvent(sessionId, "session.created", …)` — first row in the
     event stream.
   - Response: `{ sessionId, deadline, scenarioId }`.

3. **Workspace mounts.** Browser routes to `/session/[id]`. `Workspace`
   calls `getSession(sessionId)`, hydrates the `sessionStore`, opens
   two WebSockets:
   - `WS /pty/:sessionId` (routes/pty.ts) — backed by E2B's
     `sandbox.pty.create()`. Bytes flow both directions; xterm.js
     renders. Each PTY command (Enter press) deducts compute via
     `deductComputeMinutes(sessionId, COMPUTE_COST_PER_COMMAND, "sandbox_command")`.
   - `WS /messages/:sessionId` (routes/messages.ts) — the persona
     channel. Carries Client/Team messages in both directions.

4. **Working.** Each action takes a different code path:
   - **Editing files** — Monaco changes → `PUT /file` (routes/files.ts)
     → `sandbox.files.write(...)`. File snapshots are deduped via
     SHA256; only changed contents land in `file_snapshots`.
   - **Running SQL** — `DataExplorer` → `POST /api/sessions/:id/query`
     (routes/query.ts) → `query-runner.ts` calls a Python helper
     embedded in `sqlrun.py.ts` inside the sandbox. Deducts compute.
     Streams rows back (max 500). Logs a `db.query` event.
   - **Sending the AI assistant a message** — `ChatHUD` → `POST /api/chat`
     (routes/chat.ts) → `chatCompletionWithMessages` with the session's
     key. Returns the reply + new spend + remaining tokens. Logs
     `ai.assistant.*` events. Token deduction is in `scenarioState.tokens`;
     if it drops ≤ 0 the next call is rejected (`token_budget_exhausted`).
   - **Messaging Client/Team** — `Messages` → WS message → backend
     `messaging.ts` enqueues a turn for `persona-agent.ts`. The persona
     LLM runs with the channel's history + the persona's system prompt
     + current reveal-flag state. Reply broadcasts back via WS.
   - **Viewing docs** — `DocsViewer` → `POST /api/sessions/:id/docs/:docId/view`
     (routes/docs.ts) → logs `doc.view` event (for the recruiter
     timeline and the Analysis Agent's surfaced_seqs).
   - **Saving deliverable** — `DeliverablePanel` → `POST /api/sessions/:id/deliverable`
     (routes/deliverable.ts) → mirrors to `scenarioState.deliverable`
     via `persistScenarioStatePatch` (the merge_scenario_state RPC,
     race-safe). Logs `deliverable.draft` or `deliverable.submit`.

5. **Personas reach out unprompted.** `services/scheduler.ts` runs
   `setInterval(sweep, 15_000)`. Each sweep walks `sessionRegistry`,
   finds beats whose `due_ts <= now` and `fired === false`, calls
   `proactiveBeatMessage(...)` to generate the message via LLM,
   broadcasts via `messaging.ts`, marks the beat fired, and persists
   via `persistScenarioStatePatch({ personas, scheduled_beats })`.

6. **End.** Three ways:
   - Timer expires → `expireSession(sessionId, "timeout")`.
   - Manual DELETE → `destroySandbox` → `expireSession(sessionId, "manual")`
     (or `orphanTeardown` if registry entry is gone).
   - Budget exhausted → server flips status to `budget_exhausted` and
     ultimately runs through `expireSession`.

   `expireSession` is the shared teardown:
   - Mark status completed (registry).
   - `logEvent("session.ended")` + `flushTelemetry` (drains buffer).
   - `finalizeSession` writes terminal row state.
   - Close all PTY + messaging sockets.
   - `revokeSessionKey(litellmKey)` — best-effort LiteLLM POST `/key/delete`.
   - `sandbox.kill()` — frees the E2B VM.
   - **Fire-and-forget `runAnalysisAgent(sessionId)`** — the auto-eval.

7. **End screen.** Browser's `ConstraintHUD.useCountdown` fires
   `setStatus("ended")` when the deadline hits, OR the PTY WS close
   triggers `handleSessionEnd`, OR `getSession` returns
   `status: "completed"` on rehydrate. Any of these flip the store →
   `<EndScreen>` overlay renders.

8. **Auto-eval (in parallel with the end screen).** The agent reads
   the full Supabase row + condensed telemetry, calls one LLM (Gemini
   Flash by default, json_object mode, max_tokens 8000), validates the
   response (drops hallucinated event_seqs, clamps scores), computes
   the weighted overall server-side, DELETEs any prior evaluation,
   INSERTs the new one + 8 evaluation_items, records cost with
   `purpose: "analysis"`, and emits an `ai.evaluation` event for the
   recruiter timeline.

---

## Flow 2 — Recruiter reviews

1. `/review` → `SessionsTable` → `GET /api/review/sessions`
   (`apps/server/src/routes/review.ts`). One main query for sessions +
   four parallel grouped counts (events, transcript messages,
   file_snapshots, evaluations) merged in JS. Returns up to 100 rows
   with `overall_score` + `evaluation_status` per row.
2. Click a row → `/review/[id]` → `SessionDetail` → `GET /api/review/sessions/:id`.
   Fires six parallel reads (session + events + transcript +
   file_snapshots + cost_ledger + evaluation header), then conditionally
   fetches `evaluation_items` when an evaluation exists. The detail
   bundle hydrates:
   - **`Scorecard`** — 8 per-competency cells with score + rationale +
     evidence chips that link back to specific events.
   - **`TranscriptPanel`** — every persona / assistant turn, rendered
     as Bubbles.
   - **`TerminalReplay`** — xterm.js replays the recorded PTY stream.
   - **`FilesDiffPanel`** — step-through diff of every file save.
   - **`Timeline`** — every event row, click any to scroll its detail
     into focus.
   - **`CostPanel`** — per-call USD attribution.
   - **`SessionSummary`** — top-level metadata stats.
3. Manual re-eval: `Scorecard` → `POST /api/review/sessions/:id/evaluate`
   → `runAnalysisAgent` (replaces prior evaluation row + items
   cascade-drop on DELETE).

---

## Flow 3 — Persona simulation

The FDE simulation is what makes asaya distinctive. Two layers:

### Reactive (the candidate sent a message)

`messages.ts` WS receives a candidate message → routed into
`persona-agent.processCandidateMessage(sessionId, channel, text)`:
- Loads the channel's history from `SessionEntry.channelHistory[channel]`.
- Loads the persona's system prompt (from `scenario.client_persona` /
  `scenario.team_persona`) + current reveal-flag state from
  `personaState`.
- Calls LLM via `chatCompletionWithMessages`. The persona prompt is
  written to respect reveal flags: e.g., Sam only "concedes with
  evidence" if the candidate brought specific numbers refuting the
  refund hypothesis. The LLM returns `{ text, reveals: { ... } }` —
  reveals flip the corresponding personaState flags.
- Broadcasts the reply, persists, logs.

### Proactive (no candidate input — beats fire on their own)

`scheduler.ts` runs every 15 s. Each beat in
`SessionEntry.scenarioState.scheduled_beats[]` has:
- `id` (curveball id from scenario.json)
- `channel: "client" | "team"`
- `beat: "refund_hint" | "requirement_change"` (which reveal flag it sets)
- `due_ts: ISO`
- `fired: boolean`

On sweep:
- If `due_ts > now`: skip.
- If `beatAlreadyRevealed`: mark fired silently (the reactive path
  already gave the same reveal).
- Else: `fireBeat` → `proactiveBeatMessage` (LLM call) → broadcast →
  `applyBeatReveal` → log `curveball.fired` + `message.<channel>.persona`
  → record cost with `purpose: "proactive_client"|"proactive_team"`.

Beats are durable: `scheduled_beats` is part of `scenarioState`, which
lives in the Supabase row. A future session-resume slice can rebuild
SessionEntry from Supabase and the schedule survives.

---

## The Analysis Agent (the judge)

`apps/server/src/services/analysis-agent.ts`. The most carefully-tuned
piece of the system.

**Input** (assembled by `analysis-input.ts`): scenario.rubric (8
competencies × weight + description + signals + **anchors**),
ground_truth.json (correct figures + root cause), deliverable_spec,
success_criteria, the candidate's deliverable, a condensed signal
stream (messages, db.queries, doc.views, ai.assistant turns, file
snapshots, curveball.fired events, constraint trajectory), and
**`surfaced_seqs`** — the whitelist of valid event_seqs the judge may
cite as evidence.

**System prompt** — global judge principles + two anchor blocks added
in Week 4.12.3:

- **"Score each competency on its own evidence"** — a wrong final
  answer must NOT drag down process competencies that have independent
  evidence. Exception: confidently communicating an INCORRECT
  conclusion caps `outcome_communication` at ~3.
- **Execution is a graduated band**, with explicit 5/3/1 anchors:
  e.g., dedup'd correctly but missed `status='succeeded'` so figures
  are ~12% off = 3, not 1.

If the scenario's rubric includes per-competency `anchors`, those
override the global ones for that scenario. fde-db-triage has them.

**Output processing:**
- LLM responds with `{overall_summary, items: {<competency>: {score,
  rationale, evidence: [{event_seq, note}]}}}`.
- `parseAndValidate` drops hallucinated event_seqs (filters against
  `surfacedSet`), clamps scores to [1, 5], fills missing competencies
  with score=1 + "(no item returned)" rationale.
- **Server computes the weighted overall** — never trust the model to
  do arithmetic.
- Persist: DELETE any prior evaluation for the session (cascade drops
  items), INSERT new evaluation + 8 evaluation_items.
- Cost recorded with `purpose: "analysis"`.
- `ai.evaluation` event emitted via `events-direct.appendEvent` — the
  registry-bypass writer that works even for sessions whose in-memory
  entry is gone.

**Triggers:**
- **Auto** — fire-and-forget from `expireSession` at the tail.
- **Manual** — `POST /api/review/sessions/:id/evaluate` from the
  Scorecard's "Re-evaluate" button.

---

## Calibration & verification harness

`apps/server/scripts/verify-*.ts` is where the system gets stress-
tested end-to-end. Each script:
- Creates a real session via the real `POST /sessions`.
- Drives it through the real WS + REST endpoints (no mocks).
- Either waits for auto-eval or triggers manual eval.
- Asserts shape + computed values against ground truth.
- Reports a structured pass/fail/skip.

Order of evolution (matches the slices in `git log --oneline`):

| Script | Slice | What it proved |
|---|---|---|
| `verify-fde-db-triage.ts`      | 4.4 | Sandbox + SQLite seed + Data Explorer reach the right rows. |
| `verify-messages.ts`           | 4.5 | Client/Team persona WS round-trip works. |
| `verify-proactive-beats.ts`    | 4.6 | Scheduler fires beats; beats are durable across restart. |
| `verify-ai-assistant.ts`       | 4.7 | AI assistant turn deducts tokens; force-exhaust path. |
| `verify-candidate-surfaces.ts` | 4.8 | Docs viewer + deliverable submission + constraint HUD. |
| `verify-analysis-agent.ts`     | 4.9 | Auto-eval lands a complete 8-item scorecard with valid evidence_seqs. |
| `verify-scenario-state-race.ts`| 4.10 | jsonb merge RPC prevents lost deliverables under concurrent writes. |
| `verify-discrimination.ts`     | 4.12  | Judge SEPARATES a strong from a weak playthrough (spread ≥ 1.5). |
| `verify-gradient.ts`           | 4.12.2 | Judge uses the middle band, scores competencies independently. |
| `verify-anchor-tuning.ts`      | 4.12.3 | Anchor changes re-evaluate 5 prior sessions + a held-out PROFILE D, confirming generalization. |

These scripts ARE the regression suite. Run them before / after any
substantive judge or persona change.

---

## Data persistence — what lives where

### Supabase tables (`supabase/migrations/`)

| Table              | Key columns                                                  | Purpose |
|--------------------|--------------------------------------------------------------|---------|
| `scenarios`        | id, slug, title, brief, role, difficulty, **rubric**, **deliverable_spec**, **success_criteria**, client_persona, team_persona, curveballs, dataset_ref | Authoring; written by `scripts/encode-fde-db-triage.ts`. |
| `sessions`         | id, sandbox_id, **scenario_id**, **scenario_state** (jsonb), litellm_key_alias, status, end_reason, started_at, ended_at, duration_ms, spend_usd | One row per session. status ∈ {active, completed, timed_out, error, aborted}. end_reason ∈ {manual, timeout, budget, orphaned}. |
| `events`           | id, session_id, **seq** (monotonic), type, actor, ts, payload (jsonb) | Append-only timeline. Type taxonomy: `session.*`, `message.<channel>.<actor>`, `doc.view`, `db.query`, `chat.*`, `ai.assistant.*`, `ai.evaluation`, `deliverable.draft`, `deliverable.submit`, `curveball.fired`, `constraint.spend`. |
| `transcript`       | id, session_id, seq, role, content, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, finish_reason, litellm_call_id | Full LLM round-trip records (persona + assistant + analysis). |
| `file_snapshots`   | id, session_id, ts, path, content, action, size_bytes, content_hash | Deduped file-version history. |
| `cost_ledger`      | id, session_id, ts, model, prompt_tokens, completion_tokens, cost_usd, cumulative_spend_usd, litellm_call_id, transcript_id, **purpose** | Every LLM call. purpose ∈ {assistant, proactive_client, proactive_team, reactive_client, reactive_team, analysis}. |
| `evaluations`      | id, session_id, scenario_id, overall_score, summary, model, status (complete|error), created_at | One per session (DELETE+INSERT on re-eval). |
| `evaluation_items` | id, evaluation_id, competency, score, weight, rationale, evidence (jsonb) | 8 rows per evaluation. evidence references events.seq. |

### In-memory (server)

`apps/server/src/services/registry.ts` — `SessionEntry` map. Fields
include `sandbox`, `sandboxId`, `scenarioState`, `scenarioMeta`
(presentation cache for the candidate UI), `litellmKey` (NEVER logged),
`spendTally`, telemetry buffers, PTY + messaging socket sets,
`channelHistory`, `personaState`. Entries persist until server
restart; completed entries are NOT evicted yet (TODO in registry.ts).

### Browser (`apps/web/src/stores/sessionStore.ts`)

Singleton zustand store: sessionId, deadline, endedAt, spend, budget,
tokensRemaining, computeMinutesRemaining, scenarioConstraints (frozen),
scenario (presentation), status, messages (AI assistant chat history).
Workspace pane resize sizes go to `localStorage`, NOT the store.

---

## Module reference (concise)

### Server services — what each owns

- **`registry.ts`** — the SessionEntry shape + the in-memory Map. No
  logic; just types and the singleton.
- **`scenarios.ts`** — read scenarios from Supabase by id or slug.
- **`sandbox.ts`** — `createSandbox` (the heavyweight setup),
  `destroySandbox` (with orphan fallback), `orphanTeardown`,
  `computeScheduledBeats`. Owns E2B lifecycle.
- **`session.ts`** — `expireSession`, the shared teardown path. Type
  `EndReason = "timeout" | "manual" | "budget" | "orphaned"`.
- **`litellm.ts`** — `mintSessionKey`, `revokeSessionKey`,
  `getKeySpend`, `chatCompletionWithMessages` (the single LLM call
  surface). All model calls anywhere in the server eventually land
  here.
- **`scheduler.ts`** — `startBeatScheduler` + `sweep`. The 15s tick is
  configurable via `CRUCIBLE_SCHEDULER_TICK_MS`.
- **`persona-agent.ts`** — `processCandidateMessage` (reactive),
  `proactiveBeatMessage` (proactive). System prompts per scenario.
- **`messaging.ts`** — `broadcastToSession` + the messaging WS
  bookkeeping helpers.
- **`telemetry.ts`** — `logEvent`, `recordCost`, `flushTelemetry`.
  Buffered to reduce write amplification; flushed on a timer + on
  `expireSession`.
- **`events-direct.ts`** — `appendEvent` that works for sessions
  without an in-memory entry (analysis agent on historic sessions,
  orphan teardown).
- **`db.ts`** — `persistSessionCreated`, `persistSessionUpdate`,
  `loadSessionRow` (added in Week 5.1 for orphan teardown),
  `persistScenarioStatePatch` (RPC `merge_scenario_state` for race-
  safe partial writes), `finalizeSession`.
- **`supabase.ts`** — exports a single Supabase client built with the
  service-role key. `null` when env is missing (tests).
- **`compute-tracker.ts`** — `deductComputeMinutes(amount, reason)`.
  Deductions emit `constraint.spend` events; depletion does NOT block
  (it's a rubric signal, not a hard gate).
- **`query-runner.ts` + `sqlrun.py.ts`** — read-only SQLite query
  execution inside the sandbox. Python helper enforces the read-only
  contract; results capped at 500 rows.
- **`dataset-seed.ts`** — copies `seed.sql` into the sandbox and runs
  it. Failure tears down the sandbox cleanly.
- **`analysis-input.ts`** — assembles the JSON payload the judge sees.
  Includes `surfaced_seqs` whitelist.
- **`analysis-agent.ts`** — the judge. See § Analysis Agent.

### Server routes — what each accepts/returns

(All under `apps/server/src/routes/`. Headers/CORS/rate-limit handled
by Fastify plugins in `server.ts`.)

- **`health.ts`** — `GET /health` returns `{status: "ok"}`.
- **`sessions.ts`** — `POST /sessions {scenarioId?}`, `GET /sessions/:id`,
  `DELETE /sessions/:id`.
- **`files.ts`** — `GET /files?path=...`, `GET /file?path=...`,
  `PUT /file {path, content}`. All scoped to `/workspace` in the sandbox.
- **`pty.ts`** — `WS /pty/:sessionId`. Bidirectional PTY stream.
- **`messages.ts`** — `WS /messages/:sessionId`. Inbound `{channel, text}`;
  outbound `{channel, role, persona_name, text, ts}` or `{type:"error",
  code, message}`.
- **`chat.ts`** — `POST /api/chat {sessionId, prompt}` → AI assistant.
  Returns 402 with `{error}` on budget exhaustion.
- **`query.ts`** — `POST /api/sessions/:id/query {sql}`. Deducts compute.
- **`docs.ts`** — `GET /api/sessions/:id/docs` returns scenario.docs;
  `POST /api/sessions/:id/docs/:docId/view` logs `doc.view`.
- **`deliverable.ts`** — `GET/POST /api/sessions/:id/deliverable`.
- **`scenarios.ts`** — `GET /api/scenarios/:slug`. Candidate-safe
  fields only (no rubric / ground_truth / personas).
- **`review.ts`** — `GET /api/review/sessions`,
  `GET /api/review/sessions/:id`, `POST /api/review/sessions/:id/evaluate`,
  plus suspicion / cohorts / report-shares / equating (see § v-next below).
  Org-authenticated via an `X-Org-Key` API key once `ORG_AUTH_REQUIRED=true`.

### Web UI primitives (Week 6)

`apps/web/src/components/ui/` — token-driven, no raw hexes:

- **`Button`** — variants: primary | secondary | ghost | danger.
  Sizes: sm | md | lg. `leadingIcon`, `trailingIcon`, `fullWidth`.
- **`IconButton`** — square icon-only button. Required `label` for a11y.
- **`Pill`** — tones: neutral | accent | success | warn | error.
  Variants: soft | outline.
- **`Card`** — surface with optional header + headerRight. Body
  padding via `space` token.
- **`SectionLabel`** — canonical uppercase-letter-spaced micro-header.
- **`Bubble`** — chat bubble. Roles: self | other | system.
- **`TabStrip`** — generic tabs. Variants: underline (top-level) | pill
  (sub-tabs). Optional icon + badge per tab.
- **`Stat`** — label-over-value cell. Tones: default | warn | error |
  success | muted.

`tokens.ts` exports `color`, `space`, `radius`, `font`, `size`,
`shadow`, `motion`, and `scoreColor(n)` (1→error, 3→warn, 4→accent,
5→success).

---

## Monitoring — what to watch & where

### Live operations

| Signal | Where | What good looks like |
|---|---|---|
| E2B live sandbox count | `e2b sandbox list` | One row per active session. Anything dangling past `SESSION_TIMEOUT_MIN` is a leak. |
| LiteLLM master + per-session spend | LiteLLM dashboard on Railway | Per-session cost ≤ `SESSION_BUDGET_USD`. Watch for keys that don't get revoked. |
| Server logs | `tsx watch` console | `[scheduler]`, `[sandbox]`, `[orphan-teardown]`, `[analysis]`, `[db]` prefixes are deliberate. Errors prefixed `[…]` are real. |
| Supabase health | Supabase dashboard | Watch `sessions` table count growth; `evaluations` `status='error'` rate. |
| Gemini free-tier daily quota | model provider account | 20 req/day on free tier. Calibration verifiers all have quota-aware SKIP paths but if you're running multiple times a day, you may hit it. |

### Per-session forensics (when something went wrong)

```sql
-- The whole story of one session, ordered:
SELECT seq, type, actor, ts, payload
FROM events
WHERE session_id = '<uuid>'
ORDER BY seq;

-- All LLM round-trips:
SELECT seq, role, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, left(content, 200) as preview
FROM transcript
WHERE session_id = '<uuid>'
ORDER BY seq;

-- The scorecard:
SELECT competency, score, weight, rationale
FROM evaluation_items
WHERE evaluation_id = (
  SELECT id FROM evaluations WHERE session_id = '<uuid>'
);

-- Was the analysis agent run? did it succeed?
SELECT status, overall_score, summary FROM evaluations WHERE session_id = '<uuid>';
```

### Recurring sanity checks

- **Orphan sessions.** Should be ZERO with the Week 5.1 fix in place.
  `SELECT id, end_reason FROM sessions WHERE status='active' AND created_at < now() - interval '2 hours';` — if this returns anything, investigate.
- **Scorecard error rate.** `SELECT count(*) FROM evaluations WHERE status='error';` — climbing means the analysis agent is failing (often Gemini quota; sometimes a malformed scenario row).
- **Token cost outliers.** `SELECT * FROM cost_ledger ORDER BY cost_usd DESC LIMIT 20;` — should all be sub-$0.05 with current models.

### Adding a new scenario

1. Drop scenario assets under `fixtures/<slug>/`:
   - `scenario.json` (title, brief, role, difficulty, constraints,
     curveballs, deliverable_spec, **rubric with anchors**,
     success_criteria, client_persona, team_persona, docs)
   - `ground_truth.json` (the answers, hidden from the candidate)
   - `seed.sql` + `schema.sql` if the scenario needs a database
   - `queries.sql` — reference queries the judge can match against
   - `generate.ts` — synthetic-data generator (one-shot)
2. Write a per-scenario encoder script (copy
   `apps/server/scripts/encode-fde-db-triage.ts`).
3. Run it once: `pnpm --filter @crucible/server exec tsx
   scripts/encode-<slug>.ts`.
4. Add the scenario doc under `docs/scenarios/`.
5. Run the calibration sequence (discrimination → gradient → anchor
   tuning) to confirm the new rubric discriminates.
6. The candidate URL is automatically `/start/<slug>`.

### Common pitfalls

- **Browser can't reach the server** — check `NEXT_PUBLIC_SERVER_URL`
  in `.env`. CORS allows `localhost:3000` in dev only.
- **`tsx watch` reload between Begin and DELETE** — the orphan path
  catches it (Week 5.1). If you see `[orphan-teardown]` logs, that's
  fine — it's the safety net doing its job.
- **Gemini quota** — calibration verifiers print SKIP for quota
  failures rather than fail. Watch for `RESOURCE_EXHAUSTED` in logs.
- **scenario_state lost writes** — fixed by `merge_scenario_state`
  RPC (Week 4.10). If you find concurrent writes losing data, check
  that the caller is using `persistScenarioStatePatch`, not
  `persistScenarioState`.
- **Adding a route** — register it in `apps/server/src/server.ts`
  with the right `prefix`. Conventions: `/api/*` for non-WS, no prefix
  for WS, `/sessions/*` for the core session CRUD.

---

## Operating asaya going forward — a runbook

### Daily (when you're actively building)

- `pnpm dev` (or `pnpm --filter @crucible/server dev`, `pnpm --filter
  @crucible/web dev` separately) — both with hot reload.
- Open `http://localhost:3000` → redirects to `/start/fde-db-triage`.
- The server logs are noisy on purpose. `[scheduler]` ticks every 15s
  even when idle.

### Before merging changes that touch the judge or rubric

1. `pnpm --filter @crucible/server typecheck`
2. `pnpm --filter @crucible/server exec tsx scripts/verify-analysis-agent.ts`
   (sanity)
3. `pnpm --filter @crucible/server exec tsx scripts/verify-anchor-tuning.ts`
   (re-evaluates the 5 calibration sessions + held-out D). Confirm
   verdict is `PASS`.

### Before merging changes that touch personas or scheduler

1. `pnpm --filter @crucible/server exec tsx scripts/verify-messages.ts`
2. `pnpm --filter @crucible/server exec tsx scripts/verify-proactive-beats.ts`

### Before merging UI changes

1. `pnpm --filter @crucible/web typecheck`
2. Manually visit `/`, `/start/fde-db-triage`, click Begin, check all
   7 tabs work, end the session, confirm EndScreen.
3. Check `/review`, click into a session, confirm Scorecard renders.

### When you ship to production (eventual)

- Provider keys MUST stay on Railway LiteLLM, never in app env.
- `SESSION_BUDGET_USD` and `SESSION_TIMEOUT_MIN` are the cost stops.
  Don't weaken without a written justification.
- Add a TTL-based eviction job for completed `sessionRegistry`
  entries (TODO in registry.ts) — without it, memory grows
  unboundedly across long uptimes.
- Add monitoring around the orphan-teardown rate. A high rate means
  the deployment is reloading mid-session (bad).
- Plan auth before exposing `/review/*` to anyone outside the team.

### When things break — the diagnosis order

1. **Browser console** — most issues surface here first (CORS,
   WebSocket, fetch failures).
2. **`tsx watch` server logs** — look for `[orphan-teardown]`, `[db]`,
   `[analysis]`, `[scheduler]`, `[sandbox]` prefixes.
3. **`e2b sandbox list`** — orphan sandboxes mean DELETE didn't reach
   the server-side teardown.
4. **Supabase SQL** — see § Per-session forensics. Almost any "did
   this work?" question is one query away.
5. **LiteLLM dashboard** — for cost / rate-limit / provider failures.
6. The four calibration verifiers — for "is the judge sane?"
   questions.

---

## What's notable about how asaya is built

- **Real services in tests.** The verifier scripts hit the real
  endpoints, mint real LiteLLM keys, boot real E2B sandboxes, and
  write to real Supabase. There's almost no mocking. This is the
  source of confidence that the calibration findings are
  trustworthy.
- **Telemetry first.** Every meaningful interaction emits an event
  with a monotonic seq. The event stream IS the system's audit log,
  the recruiter timeline, AND the input to the Analysis Agent.
  Adding a new interaction usually means logging a new event type.
- **One LLM gateway.** All model calls — persona reactive, persona
  proactive, AI assistant, analysis agent — go through
  `chatCompletionWithMessages` in `services/litellm.ts`. Provider /
  model selection is centralized.
- **Server computes the math, not the LLM.** The Analysis Agent's
  weighted overall is computed server-side from the LLM's per-item
  scores + the rubric weights. The model isn't trusted with
  arithmetic.
- **Source-of-truth split.** scenario.json on disk is the authoring
  source. The encode script pushes it into Supabase. The server reads
  from Supabase. Don't bypass the encoder.
- **The plan / verify discipline.** Most non-trivial slices have a
  planning document in `.claude/plans/` and a one-shot verifier in
  `apps/server/scripts/verify-*.ts`. The verifier proves the slice
  in CI-style, end-to-end. Keep this pattern.

---

## v-next (July 2026) — proctoring, orgs, reports, difficulty routing

Shipped after the guide above was written; `docs/ARCHITECTURE-REPORT.md` §13
is the detailed source of truth. In brief:

- **Passive proctoring + Suspicion Score.** The workspace emits `integrity.*`
  events (tab/window blur, paste bursts, idle gaps, devtools, copy, fullscreen
  exit — shared Zod taxonomy in `packages/shared/src/schemas/telemetry.ts`;
  browser hook `apps/web/src/lib/integrity.ts`) to
  `POST /sessions/:id/integrity` (rate-capped). `services/suspicion-score.ts`
  computes a deterministic 0–100 score + factors
  (`suspicion_detector_version=1`), shown in the review UI's SuspicionPanel.
  **Hard rule:** the evidence extractor filters `integrity.*` before any
  detector runs — proctoring signals never affect scores. Candidates see a
  disclosure on the start screen; the public shared report shows the score
  only (factors are recruiter-only).
- **Multi-tenant orgs** (migrations 0018/0019, applied). `orgs` table;
  `org_id NOT NULL` on sessions / session_links / outcomes / outcome_invites
  (backfilled to the default asaya org); per-org API key + webhook secret,
  sha256-hashed at rest, minted via `scripts/mint-org-key.ts`. `/api/review/*`
  authenticates via `X-Org-Key` once `ORG_AUTH_REQUIRED=true` (default off →
  default-org fallback); every query is org-scoped, the RLS posture is
  deny-all, and cross-tenant probes return a uniform 404. Scenarios remain
  global. `verify-tenant-isolation.ts` is the gate. Access model: admin = the
  operator-set `ORG_ADMIN_KEY` env var (constant-time compare, before the hash
  lookup); partners = one shared review link (`/review?key=…`, moved into
  sessionStorage and stripped from the URL on load — treat the link as a
  secret).
- **Reports.** Org-scoped cohort dashboard
  (`GET /api/review/cohorts/:scenarioId` → `/review/cohorts/[scenarioId]`) and
  shareable candidate reports (`report_shares`, 0021): mint/list/revoke from
  the review UI (ShareReportModal), public `GET /api/report/:token` behind a
  strict Zod allowlist (no cost/model/sandbox/transcript data), rendered at
  `/report/[token]` with print-CSS PDF export. AI-Fluency placement is a
  presentation-only mapping of `ai_orchestration` (<2.5 Dependent · 2.5–3.9
  Augmented · ≥4 Orchestrator).
- **Difficulty routing + calibration** (0020/0022, applied). Session links
  carry a `difficulty_band`; `services/difficulty-routing.ts` routes band →
  scenario-family sibling at session **creation only** (a running session is
  never re-routed). `services/difficulty-stats.ts` maintains
  `competency_difficulty_stats` over scorable sessions only
  (`difficulty_stats_version=1`); `services/equating.ts` +
  `GET /api/review/equating/:familyId` compare bands within a family. The
  candidate link token is consumed end-to-end from `/start/[slug]?link=…`.
- **Ops:** to enable tenant auth, mint org keys first, then flip
  `ORG_AUTH_REQUIRED=true`. The verify suite grew by nine scripts (~49 total),
  including the tenant-isolation gate.

**Dormant builds (July 2026 — fully built, deliberately OFF).** Two features
ship in the codebase but do nothing until manually activated: the second
scenario family **`fde-api-integration`** (dormant by data — migration 0023
is authored but unapplied, and its seed carries `catalog_visible = false`, so
the family never lists in the candidate catalog; its `DETECTOR_VERSION` 3
detectors are slug-gated and inert on family 1) and **proctoring v2**
(dormant by flag — consent-gated identity verification + webcam presence,
gated per org on `orgs.settings.proctoring_v2_enabled`, default off and
fail-closed to v1 passive on every error path; migration 0024
(`identity_checks`) is likewise authored but unapplied, raw imagery is never
persisted, and deletion is an org-scoped hard delete — `identity.*` events
are retained by design). Activation is a manual, per-feature operator
runbook — `docs/GOING-LIVE.md` — with family 2 gated on cohort 1 closing +
green calibration verifiers, and proctoring v2 gated on counsel sign-off of
the consent text; details in `docs/ARCHITECTURE-REPORT.md` §13.5–13.7.

**Validity instrumentation (July 2026).** A READ-ONLY, admin-only dashboard
over the existing measurement data — no new measurement logic, no writes:
`GET /api/admin/validity/*` (`services/validity.ts` + `routes/validity.ts`)
serves six views — per-competency discrimination, not-assessed rates,
band-stratified distributions, score↔outcome correlation (reusing
`services/outcomes.ts`), exclusion breakdown, and a version/drift-boundary
panel — rendered at `/review/validity` (ValidityDashboard, plus a web-only
reliability placeholder; an admin-probe nav link on the review dashboard).
Access requires an explicit `X-Org-Key` resolving to the admin org
(`ORG_ADMIN_KEY` works); partner keys get 403 and key-less requests 401
**even with `ORG_AUTH_REQUIRED` off** — this surface fails closed because it
aggregates across orgs. Metrics are version-aware (never pooled across a
judge-prompt / competency-model boundary; legacy v1-judge sessions are
segregated to the versions panel, with a `boundary_warning`), scorable-only
(the exclusions view is the one exception), and small-N-honest (the server
nulls numbers below N=10 per segment / paired-N=20 for correlations). Six
infra-light `verify-*` scripts gate it; details in
`docs/ARCHITECTURE-REPORT.md` §13.8.

---

## Glossary

- **Beat** — a scripted persona action (reactive or proactive).
- **Curveball** — a beat that disrupts the candidate (e.g.,
  requirement_change, misleading_teammate_hint).
- **Reveal flag** — a boolean on `personaState` that gates what the
  persona will say next (e.g., `team.gave_webhook_clue`).
- **Scenario state** — the live game-mechanic ledger for a session
  (tokens, compute_minutes, personas, scheduled_beats, deliverable).
- **Surfaced seqs** — the whitelist of event_seqs the Analysis Agent
  may cite as evidence; prevents the judge from hallucinating
  evidence from events that didn't happen.
- **Anchor** — explicit 5/3/1 scoring guidance in the judge prompt
  (global) and rubric (per-scenario). Added in Week 4.12.3.
- **Orphan session** — a session whose in-memory `SessionEntry` was
  dropped (server restart) but whose E2B sandbox is still alive. The
  Week 5.1 fix handles these via Supabase-backed teardown.
- **PROFILE A/B/C/D** — scripted candidate playthroughs used by the
  calibration verifiers. A = technically strong / socially absent.
  B = process strong / technically wrong. C = near-miss execution.
  D = held-out: technically right / actively rude.
