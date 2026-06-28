# asaya v1 — Implementation Plan

Status: proposed. Grounded against the working tree on 2026-06-28. This is the
response to `asaya — v1 Architecture Plan (for Claude Code)`: layer mapping
confirmed against real code, per-slice migration + module diffs, conflicts
flagged, and the §8 open questions resolved with recommendations.

Read §1 (conflicts) first — three premises in the brief don't hold against the
current repo and change the slice order.

---

## 1. Conflicts with the brief — resolve these before slicing

These are places where the brief's stated "MVP today" doesn't match the code.
None are blocking, but each changes a slice.

### C1 — There is **no `verify-*` regression suite** to "not regress". (blocks the acceptance model)
The brief repeatedly says slices "must not regress the existing regression suite"
and the `verify-*.ts` scripts "become part of the regression suite."
Reality (`apps/server/package.json:6-13`, `.github/workflows/ci.yml:52-59`):
- No pnpm/npm script runs any `verify-*.ts`. CI only does typecheck + build with
  **stubbed fake env** — the verifiers never run in CI.
- They are manual, one-at-a-time, against a **live server + real Supabase + real
  LiteLLM/Gemini**, with 60s rate-limit cooldowns between playthroughs.
- **Most carry a `TODO(jwt-auth)` banner and will 401 today** — they were never
  updated for per-session JWT auth. Only `verify-pro-discrimination.ts` and
  `verify-rehydrate.ts` use the current auth pattern.

Consequence: "don't regress the suite" is currently unverifiable, and slice 5.3's
acceptance ("verify-discrimination + verify-gradient still pass") would run
broken scripts. **Add Slice 5.0 (below): repair verifier auth + a single
regression runner.** Without it, every downstream acceptance gate is hand-waving.

### C2 — The competency set is hard-coded in **three** disconnected places, and `packages/shared` has **no** rubric/competency schema. (expands slice 5.1)
- `analysis-agent.ts:39-49` — `const COMPETENCIES = [...8 keys]` baked into server code.
- `supabase/migrations/0003_fde_scenarios.sql:95-104` — the seed inserts the 8 keys.
- Each `fixtures/*/scenario.json` `rubric` — the 8 keys again.
- `packages/shared/src/schemas/{assessment,session}.ts` model an **unrelated,
  older "assessment/task" concept** (starterFiles, estimatedMinutes) — there is
  no Zod for rubric/competency/scoring anywhere. `scenarios.ts:5-22` types
  `rubric` as `Record<string, unknown>`.

Consequence: L0 isn't only "extract rubric → canonical model." It must also
**delete the hard-coded `COMPETENCIES` const** and make `analysis-agent` load the
competency set from the resolved model version, or the construct stays pinned in
code. Slice 5.1 owns all three sites.

### C3 — `anchors` is a live data-drift, and the "lossless rebind parity check" can't be an LLM re-eval. (reshapes slice 5.1 acceptance)
- `fixtures/fde-db-triage/scenario.json` rubric carries `anchors` + `scoring_note`;
  **migration `0004` does not** (`grep -c anchors 0004 = 0`). So `supabase db reset`
  yields a base scenario with no anchors, while the live DB (updated from the
  fixture via `encode-fde-db-triage.ts`) has them. `anchors` is also absent from
  every TS type (`analysis-input.ts:108-112`, the encode `ScenarioDoc` interface).
- The judge **does** consume `anchors` (`analysis-agent.ts:152-156`).
- The brief's parity check ("re-evaluate stored sessions; scores must match within
  tolerance") cannot be an LLM re-eval: the judge is `gemini-flash`,
  non-deterministic. Re-running will not reproduce scores even with an identical
  rubric.

Consequence (parity, redefined): parity = **(a)** the rebound rubric resolves to
byte-identical `{weight, anchors}` per competency vs the current *live/fixture*
rubric (not the `0004` migration state), and **(b)** re-feeding the *stored*
`evaluation_items` through the new server-side weighting yields the identical
`overall_score`. That isolates the migration as lossless without depending on LLM
reproducibility. Fix the `0004`/fixture anchors drift in the same slice.

### C4 — `difficulty` already exists (free-text). (slice 5.6 is a modify, not an add)
`scenarios.difficulty TEXT` exists (`0003:30`), values `'mid'`/`'hard'`, surfaced
on the public catalog (`scenarios.ts:64`) and in the web store. Slice 5.6 should
**constrain** it into a band enum, not add a column.

### C5 — There is no session FSM phase for "verifying," and submit does not end the session. (decides open Q2 — see §3)
`registry.ts:56` status is just `"active" | "completed"`. `expireSession`
(`session.ts:25`) is synchronous teardown that **revokes the LiteLLM key and kills
the sandbox**, and runs fire-and-forget at timeout. `deliverable.ts:6-7,90-91`:
submission is latest-wins telemetry and **explicitly does not end the session**.
So a verification stage cannot live "inside teardown" (no live key, no interactive
loop there). It must run while the session is live. See §3 + Q2.

---

## 2. Confirmed layer mapping (what's real today)

| Layer | Brief's claim | Confirmed in code |
|---|---|---|
| L0 | embedded per scenario | ✅ `rubric` JSONB, 8 keys, `{weight,description,signals,anchors?}`; no catalog table; competency also a free-text `evaluation_items.competency TEXT` |
| L1 | 1 scenario + pro variant | ✅ `fde-db-triage` (UPDATE path) + `-pro` (UPSERT path); siblings linked only by slug prefix; **no family/isomorph/version columns** |
| L2/L3 | none | ✅ none — `dataset_ref` + hand fixtures only |
| L4 | strong, fixed difficulty, scripted beats | ✅ `persona-agent.ts` (per-session key), curveballs defined in scenario JSON, fired by `scheduler.ts` time-sweep → `curveball.fired`; budget/timeout = 3 layers (gateway key, `spendTally`, timeout timer) |
| L5 | single LLM judge over raw stream | ✅ `analysis-input.ts` condenses events → `analysis-agent.ts` one `gemini-flash` call → `evaluations` + 8 `evaluation_items`; `surfaced_seqs` whitelist filters hallucinated seqs; **server computes weighted overall** (`weightedOverall`, `analysis-agent.ts:265`) |
| L6 | weighted overall + verify scripts | ✅ overall = Σ score·weight; verify scripts exist but see C1 |

Key invariants the verifiers pin (don't break silently): `evaluations` has exactly
1 row/session (DELETE-then-INSERT), 8 items, exact 8 keys, integer scores 1–5,
`overall_score = Σ score·weight`, `evidence[].event_seq` grounded in `events`;
`cost_ledger.purpose ∈ {analysis, proactive_team, proactive_client, ai_assistant}`;
`events` types incl. `curveball.fired`, `message.*.persona`, `ai.evaluation`;
persona model `gemini-flash`; starting token budget `200000`.

---

## 3. Open questions (§8) — resolved

**Q1 — evidence-unit detector boundary (deterministic vs LLM).**
Rule: **deterministic** = anything checkable against `ground_truth.json`, plus
event counts / timing / ordering / presence-absence. **LLM (Stage B)** = quality,
tone, judgment, rationale. Initial detector list for `fde-db-triage` (Stage A):

| Competency | Deterministic units (Stage A) | Stays LLM (Stage B) |
|---|---|---|
| problem_framing | `clarifier_before_first_query` (client `message` seq < first `db.query` seq), `time_to_first_question_ms` | quality of hypotheses |
| data_fluency | `dedup_correct` (final query has DISTINCT/CTE), `status_filter_missing`, `query_error_rate`, `rowcount_matches_truth` | interpretation of results |
| execution | `figures_match_truth` (deliverable numbers vs `ground_truth` within tol), `verified_before_submit` (a read query after a `deliverable.draft`), `iterated_after_failure` (error query → corrected), `wasteful_select_star_count` | overall rigor |
| ai_orchestration | `ai_turn_count`, `ai_token_spend`, `caught_ai_error` (candidate query/text contradicts a prior assistant claim) | quality of the correction |
| teamwork | `persona_pushback_resisted` (did a later query/deliverable adopt Sam's wrong hint? boolean from `curveball.fired` followups + deliverable) | tone, collaboration |
| customer_engagement | `client_update_sent` (≥1 client message), `requirement_change_acknowledged` | empathy, clarity |
| design_under_constraints | `prioritization_order` vs `ground_truth.impact_ranking` (pro), `budget_blown` (spend ≥ cap) | trade-off reasoning |
| outcome_communication | `deliverable_present`, `required_fields_present` | prose quality |

Each unit: `{competency_key, kind, value, weight, event_seqs[], detector_version}`.
Justification per unit is its `kind`'s definition above; all are derivable from the
existing condensed buckets in `analysis-input.ts` (db_queries, messages,
ai_assistant pairs, curveball followups, deliverable, constraint_summary) +
`ground_truth.json`. **The `surfaced_seqs` hallucination filter becomes structural**
— Stage B cites `evidence_unit_id`s whose `event_seqs` were validated by Stage A.

**Q2 — verification timing: post-submit, while the session is live (NOT blocking
pre-submit, NOT inside teardown).** Rationale from C5: teardown revokes the key
and kills the sandbox, so interactive LLM defense can't run there; blocking
pre-submit hurts candidate UX and fights the "submit doesn't end session" design.
Trigger options, recommend **(a)**: (a) a `scheduler.ts` beat near `entry.deadline`
that opens a verification exchange over the existing messaging WebSocket while the
key is still valid; (b) candidate-initiated "submit & defend." Emit
`verification.prompt` / `verification.response` events; Stage A reads them like any
other event. This keeps verification inside the budget/timeout envelope
automatically (it uses `entry.litellmKey`).

**Q3 — minimum viable outcome_type set.** `hired` (bool), `ramp_weeks` (numeric),
`manager_rating_90d` (1–5), `retained_90d` (bool). Schema: `outcome_type` (enum/text),
`outcome_value` (jsonb to fit bool/num/scale), `source ∈ {csv, webhook, manual}`.
Keep to what a design partner will actually return; everything else is v2.

**Q4 — re-scoring policy: lazy / on-demand, never eager.** A version bump stamps
only *new* evaluations; historical rows keep their original stamps. Re-scoring is
explicit: per-session via the new `/reinterpret` endpoint (slice 5.3), or batch
via `verify-drift.ts` over a **fixed held-out anchor set** (not the whole corpus).
Eager re-scoring of all history on every bump is LLM-cost-prohibitive and
defeats the reliability goal. (Cheap because Stage B re-runs over stored
`evidence_units` — no session replay.)

**Q5 — versioning surface fits with no schema fight.** Add four nullable columns to
`evaluations`: `competency_model_version`, `detector_version`, `judge_prompt_version`,
`scenario_version`. DELETE-then-INSERT is per-session, so adding columns is trivial
and the stamps are written at persist time (`persistEvaluation`,
`analysis-agent.ts:273-327`). Confirmed: no conflict.

---

## 4. Slices — migrations + module diffs

Slice order: **5.0 → 5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6 → 5.7** (5.0 prepended).

### Slice 5.0 — Regression harness (precondition; resolves C1)
- **Module diffs:** add `apps/server/scripts/regression.ts` (runs the verifier set
  serially against a configured live server, aggregates pass/fail, respects the
  Gemini cooldowns); add `pnpm --filter @crucible/server regression` to
  `package.json`. Update the `TODO(jwt-auth)` verifiers
  (`verify-discrimination.ts`, `verify-gradient.ts`, `verify-anchor-tuning.ts`,
  `verify-analysis-agent.ts`, `verify-proactive-beats.ts`, …) to the JWT pattern
  already in `verify-pro-discrimination.ts` / `verify-rehydrate.ts`.
- **Migrations:** none.
- **Acceptance:** `regression.ts` runs discrimination + gradient + analysis-agent
  green against `main` before any L0/L5 change. This is the baseline the brief
  assumed already existed.
- *No new dependency, no schema change — but flag: this is added scope the brief
  didn't budget. Confirm before starting.*

### Slice 5.1 — L0 canonical competency model + rebind (resolves C2, C3)
- **Migrations:**
  - `0007_competency_model.sql` — `competencies (key, name, version, definition,
    dimensions jsonb, default_anchors jsonb, construct_family, created_at)`;
    `competency_model_versions (version int PK, frozen_at, note)`; seed the 8 keys
    as `competency_model_version = 1` (lift definitions/anchors from the live
    fixture, **not** from `0003`'s placeholder `{weight:1}`).
  - `0008_scenario_rubric_rebind.sql` — rewrite `fde-db-triage` + `-pro` rubric to
    the binding shape `[{competency_key, weight, scenario_anchors?, evidence_hints?,
    load_bearing}]`; **fix the `0004` anchors drift** by writing anchors here.
  - `evaluations += competency_model_version` (the version stamp; rest of stamps in 5.7).
- **Shared:** new `packages/shared/src/schemas/competency.ts` (Zod for competency,
  model version, rubric-binding) + types; export from `index.ts`. (Greenfield —
  the existing `assessment.ts`/`session.ts` are an unrelated legacy concept; leave
  them, don't extend.)
- **Server:** new `services/competencies.ts` (load active model version; resolve a
  scenario's binding → effective `{competency_key, weight, anchors}` map). Refactor
  `analysis-agent.ts`: **delete the `COMPETENCIES` const** (C2); load the set + the
  per-competency weight/anchors from the resolved binding; keep `weightedOverall`
  server-side unchanged. Update `analysis-input.ts` rubric type to include `anchors`.
- **Acceptance — `verify-competency-model.ts`:** (a) rebound rubric resolves to
  byte-identical `{weight, anchors}` vs the current live rubric; (b) re-feeding
  stored `evaluation_items` through the new weighting reproduces each session's
  `overall_score` exactly (parity per C3). `verify-analysis-agent.ts` still green
  (8 keys, math, grounding).

### Slice 5.2 — L5 Stage A: deterministic evidence extraction
- **Migrations:** `0009_evidence_units.sql` — `evidence_units (id, session_id FK,
  competency_key, kind, value jsonb, weight numeric, event_seqs int[],
  detector_version text, created_at)`; index `(session_id)`, `(session_id, competency_key)`.
- **Server:** new `services/evidence-extractor.ts` — pure, deterministic, versioned
  detectors (Q1 list). Reads the same durable source `analysis-input.ts` uses
  (Supabase `events` + `ground_truth.json` from `dataset_ref`), so it works
  post-session with no in-memory dependency. Emits typed units with validated
  `event_seqs`. Add a `detector_version` const.
- **Acceptance — `verify-evidence-units.ts`:** the existing STRONG/WEAK scripted
  playthroughs emit the expected unit `kind`s with correct `event_seqs`
  (e.g. STRONG → `dedup_correct`, `verified_before_submit`, `figures_match_truth`;
  WEAK → `status_filter_missing`, figures mismatch).

### Slice 5.3 — L5 Stage B: Analysis Agent over units + reinterpret
- **Migrations:** none (uses 5.2 table; stamps land in 5.7).
- **Server:** refactor `analysis-agent.ts` Stage B to consume `evidence_units` +
  deliverable + ground truth (**not** the raw firehose), cite `evidence_unit_id`s.
  The `surfaced_seqs` whitelist is **replaced** by unit-id citation (structural —
  Q1). Keep: server-side weighted overall, `events-direct.appendEvent` for
  `ai.evaluation`, DELETE-then-INSERT. Refactor `analysis-input.ts` to assemble the
  compact Stage-B input from units. New route `POST /api/review/sessions/:id/reinterpret`
  (`routes/review.ts`) = run Stage B only over stored units (no Stage A re-run).
- **Acceptance:** `verify-discrimination.ts` (spread ≥ 1.5) + `verify-gradient.ts`
  (independence gap ≥ 1.0, mid-band used, no inversion/binarity) **still pass over
  the new path** — the L5 split must not regress judge quality. `reinterpret`
  returns a new `evaluation_id` without a session replay.

### Slice 5.4 — L4 interactive verification + difficulty-banded curveballs (resolves C5/Q2)
- **Migrations:** none (events extend the taxonomy; no schema change — `events`
  has no type enum).
- **Server:** add a verification prompt-builder + structured-output schema reusing
  `persona-agent.ts` + `entry.litellmKey` + the messaging WebSocket path
  (`messaging.ts`/`messages.ts`). Trigger via a near-deadline `scheduler.ts` beat
  (Q2 option a). Thread a new channel/role through `InboundSchema`, `Channel`, the
  history-split (`messages.ts:139-145`), and emit `verification.prompt` /
  `verification.response`. Parameterize curveball selection by `difficulty_band`
  (data-driven from the scenario; lay the v2 real-time-escalation hook, don't build
  it). The verifier selects 2–3 consequential decisions from the live event stream
  and asks the candidate to defend each.
- **Acceptance — `verify-verification.ts`:** a deliverable that passes but cannot be
  defended → score drops on the relevant competencies (Stage A emits a
  `defense_weak` unit tied to those competencies; Stage B reflects it).

### Slice 5.5 — L6 outcome capture (resolves Q3)
- **Migrations:** `0010_outcomes.sql` — `outcomes (id, candidate_ref, session_id FK,
  scenario_id FK, outcome_type, outcome_value jsonb, source, captured_at)`; RLS on.
- **Server:** CSV import script + `POST /api/outcomes` partner webhook (Zod-validated,
  org-scoped). Link outcomes → sessions → evidence_units for later correlation.
- **Acceptance — `verify-outcomes.ts`:** outcome rows link to sessions; the
  correlation query (outcome ↔ overall/competency) runs end-to-end on synthetic data.

### Slice 5.6 — L1 item families + 2 new scenarios (resolves C4)
- **Migrations:** `0011_scenario_families.sql` — `scenario_families (family_id,
  competency_targets jsonb, difficulty_band, radical_spec jsonb)`; `scenarios +=
  family_id, isomorph_of, radical_values jsonb, incidental_values jsonb`; **constrain
  existing `difficulty`** into a band (don't add a column — C4). Formalize
  `fde-db-triage` + `-pro` as one family at two bands.
- **Authoring:** extend the `scripts/encode-*.ts` pattern (keep authoring behind the
  encode interface so v2 generation targets the same rows). Author 2 more scenarios
  → 3–5 total across 2 families, each band-labeled, referencing the L0 model. No
  generator.
- **Acceptance — `verify-isomorph-equivalence.ts`:** matched playthroughs of two
  same-family/same-band isomorphs yield comparable score distributions.

### Slice 5.7 — L6 reliability + scenario_stats + drift + version stamping (resolves Q4/Q5)
- **Migrations:** `evaluations += detector_version, judge_prompt_version,
  scenario_version` (model version landed in 5.1) — four stamps total, all nullable
  (Q5). `scenario_stats (scenario_id, competency_key, n, mean_score, pass_rate,
  updated_at)`. Add light org/tenant scoping (`org_id`) to `scenarios`, `sessions`,
  `outcomes` with RLS (multi-tenant seam).
- **Server:** stamp all four versions at `persistEvaluation`. Compute `scenario_stats`
  as sessions accrue (proto-difficulty).
- **Acceptance:** `verify-reliability.ts` (run Stage B N times/models over the same
  units → per-competency variance within bound) + `verify-drift.ts` (re-score the
  held-out anchor set when any version changes; flag drift). Stub `verify-fairness.ts`
  + DIF check that activates only once subgroup N is sufficient (build the seam).

---

## 5. Constraint compliance (CLAUDE.md / brief §6)

All new LLM calls go through LiteLLM: the **extractor is deterministic** (no model
call); the **verifier uses `entry.litellmKey`** (per-session, budget/timeout-bounded);
Stage B keeps using the master key as a platform post-session call
(`analysis-agent.ts:364`), unchanged. No provider keys in app. Browser still talks
only to the server. Every new row (`evidence_units`, `outcomes`, `verification.*`
events, `scenario_stats`) joins back to `sessions.id` / `scenario_id`. `events`
stays append-only; `verification.*` extends the taxonomy, mutates nothing. Server
computes all arithmetic. Post-session writes use `events-direct.appendEvent`. New
tables get RLS; tenant scoping in 5.7.

## 6. Explicit non-goals (unchanged from brief §7)
L2/L3 generation + environment synthesis; real-time adaptive difficulty/CAT; full
IRT + DIF; 50+ competency expansion. Build seams, not the analyses.

---

## 7. What I need confirmed before building
1. **Slice 5.0 scope** — repairing the verifier auth + a regression runner is added
   scope (the brief assumed the suite existed and was green). OK to prepend it?
2. **Parity redefinition (C3)** — accept the two-part parity check (byte-identical
   rubric resolution + stored-items re-weight) instead of LLM re-eval tolerance?
3. **Verification trigger (Q2)** — near-deadline scheduler beat vs candidate-initiated
   "submit & defend." I recommend the scheduler beat.
4. **Migration numbering** — next free is `0007`; I've reserved `0007`–`0011`.
