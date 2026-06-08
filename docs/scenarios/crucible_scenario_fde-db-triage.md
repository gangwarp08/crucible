# Flagship Scenario · `fde-db-triage` — "Revenue dashboard triage"

**One-liner:** An anxious finance customer says their revenue dashboard is overstating numbers before a
board meeting. The real cause is duplicate payment rows from a webhook-retry bug (not the refunds the
teammate blames). The candidate must investigate the data, find and quantify the true cause, ship a
corrected figure + fix, and write a board-ready summary — under resource constraints and a mid-sim
requirement change.

Difficulty: **mid**. Target length: **90 min**.

---

## 1. Candidate-facing brief (shown at session start)
> You're the forward-deployed engineer assigned to **Meridian**, a B2B SaaS company. Their finance team
> has flagged that the monthly revenue dashboard looks materially too high for recent months, and
> leadership wants answers before a board meeting. You have read access to a copy of Meridian's
> production database and an internal channel with your teammate. Figure out what's going on, fix it,
> and give finance something they can trust. Your client (Dana, VP Finance) is in the client channel.

Deliberately omits: which metric/timeframe, the expected number, the cause. The candidate must extract
that from the client.

---

## 2. Personas (semi-scripted: fixed goals + beats, LLM only for phrasing)

### Client — "Dana", VP Finance (non-technical, anxious, time-pressured)
- **Goal:** a trustworthy corrected revenue number + a plain-English explanation for the board.
- **Knows:** the dashboard "looks wrong, way too high, started around April"; the board meeting is soon.
- **Does NOT know / never reveals:** the technical root cause, anything about the schema or SQL.
- **Beats:**
  1. Opening: vague, urgent ask (mirrors the brief).
  2. If asked clarifying questions → reveals specifics: it's the **monthly recognized revenue** tile; finance expected roughly **$1.1–1.3M/mo**, dashboard shows **~$1.5M+**; "it started looking off around **April**."
  3. If the candidate gives a status update → relief + slight extra pressure ("can you have it by end of session?").
  4. **Curveball 1** (see §5).
  5. On delivery → asks one skeptical follow-up ("are you sure this is the *real* number?") before accepting.
- **Guardrails:** never volunteers or confirms the technical cause; if asked leading SQL-ish questions, redirects to business context; stays in character; does not coach.

### Team — "Sam", senior engineer / teammate (helpful but busy)
- **Goal:** be helpful, but is mid-task and slightly overconfident.
- **Beats:**
  1. Early proactive message: a **misleading hint** — "the revenue thing? pretty sure it's refunds not being subtracted, just filter those out." (Refunds are a red herring.)
  2. If the candidate pushes back **with evidence** (e.g., "refunds only account for $X, the gap is bigger") → concedes and offers a real clue: "huh. payments come in via Stripe webhooks — worth checking for dupes if a retry misfired."
  3. If asked for access/help beyond scope → sets a boundary ("can't pull prod creds, but the read replica you have should be enough").
- **Guardrails:** gives the misleading hint once; never hands over the answer; the real clue only unlocks if the candidate brings evidence (rewards verification over trust).

---

## 3. Synthetic dataset (seeded read-only inside the sandbox)
All data synthetic — no real PII. Generated deterministically (fixed RNG seed) so every candidate gets
the identical DB. Postgres or SQLite.

**Schema**
- `customers(id, name, plan, created_at)` — ~400 rows.
- `subscriptions(id, customer_id, plan, mrr, started_at, status)` — ~500 rows.
- `payments(id, external_payment_id, subscription_id, amount_cents, currency, status, created_at)`
  - `status` ∈ {`succeeded`, `refunded`, `failed`}.
  - ~5,000 rows across the last 12 months.

**Injected truth + distractors**
- **Root cause (the real bug):** in the last **2 months** a webhook-retry bug double-inserted ~**8%** of
  `succeeded` payments — duplicate rows share the same `external_payment_id` and `amount_cents`,
  differ by `id` and a few seconds of `created_at`. These inflate the naive `SUM(amount_cents)`.
  Correct approach: dedupe by keeping one row per `external_payment_id`; exclude `refunded`/`failed`.
- **Red herring 1 (refunds):** a normal, correctly-recorded volume of `refunded` rows exists — small
  relative to the gap. Sam's hint points here. Filtering only refunds does NOT close the gap.
- **Red herring 2 (timezone):** `created_at` is UTC; a handful of payments near month boundaries could
  be mis-bucketed if someone bins by local time — minor, a distractor for over-thinkers.

**Ground truth (recorded in the fixture, used to grade — never shown to candidate)**
- Naive monthly revenue (what the dashboard shows) for the last 3 months.
- Correct monthly revenue (dedup + status filter) for the last 3 months.
- The overstatement = duplicate `succeeded` amounts in the last 2 months.
- The fixture stores these exact figures so success criteria + the Analysis Agent can score objectively.

---

## 4. Constraints (scenario game-mechanic — separate from the platform LLM budget)
Stored in `scenarios.constraints`; copied into `sessions.scenario_state` at start; surfaced in the HUD.
- `time_minutes: 90` — **hard** (the existing session timer).
- `tokens: 200000` — **hard-ish**: budget for the in-platform AI assistant; when exhausted the assistant
  is unavailable (the candidate must work unaided). Metered via LiteLLM.
- `compute_minutes: 60`, `money_usd: 25`, `memory_mb: 2048` — **soft/displayed** for MVP: consumed by
  running queries/code (e.g., a full-table scan costs more than a targeted query), surfaced in the HUD
  as judgment pressure. Not hard-blocking in the MVP; the *management* of them is what's scored, via the
  `design_under_constraints` competency. (Hard enforcement can come later.)

---

## 5. Curveballs (scripted, time/▶event-triggered → `curveball.fired` events)
1. **Requirement change** (~T+25m, or after first substantive client update): Dana relays that leadership
   now wants the **corrected figures for the last 3 months** *and* a **one-paragraph board explanation**,
   by end of session. Tests adaptability + reprioritization + outcome comms.
2. **Misleading teammate hint** (early, see Sam beat 1): tests verification-over-trust.

---

## 6. Deliverable (composite — `deliverable.*` events)
1. **Corrected monthly revenue** for the last 3 months (a query/script that runs and reproduces them).
2. **Root-cause finding** — what was wrong and why (duplicates from webhook retries).
3. **Client-facing summary** — a board-ready paragraph: the corrected number, plain-English cause, and
   that it's a recording bug (revenue was never actually that high), with the upstream fix recommended.
4. **Key decisions / trade-offs** — how they handled refunds, timezone, dedup choice, what they'd fix upstream.

---

## 7. Rubric (8 competencies; weights sum to 1.0; scored 1–5 with evidence)
| Competency | Weight | What "good" looks like here | Primary signals |
|---|---|---|---|
| problem_framing | 0.15 | Asks what "wrong"/expected/when before digging; forms hypotheses | client Qs before first query; time-to-first-question vs first-query |
| data_fluency | 0.20 | Explores schema, finds the duplicates, quantifies the gap; doesn't accept the refund hint blindly | db.query progression; dedup query present; refund hypothesis tested & rejected |
| design_under_constraints | 0.10 | Targeted queries over full scans; manages compute/token budget; prioritizes the board deadline | constraint.spend trajectory; query selectivity; reprioritization after curveball 1 |
| execution | 0.20 | Produces corrected figures that actually run and match ground truth | deliverable correctness vs ground truth; working fix |
| ai_orchestration | 0.10 | Uses the AI assistant to accelerate but verifies its output against the data | ai.assistant usage + subsequent verification queries |
| teamwork | 0.10 | Engages Sam, verifies the misleading hint rather than acting on it, escalates appropriately | team-channel exchange; whether refund hint was acted on vs tested |
| customer_engagement | 0.05 | Sets expectations, updates the anxious client, absorbs the requirement change calmly | client-channel cadence/quality; response to curveball 1 |
| outcome_communication | 0.10 | Board-ready paragraph is clear, accurate, non-technical, correct number + plain cause | deliverable summary quality |

---

## 8. Success criteria (objective gate, from ground truth)
- Identifies **duplicate payments** as the root cause (not refunds).
- Corrected last-3-month figures within **±2%** of the fixture's true corrected numbers.
- Delivers all four deliverable components.
- Bonus signal: recommends the upstream idempotency fix (not just a one-off dedupe).
