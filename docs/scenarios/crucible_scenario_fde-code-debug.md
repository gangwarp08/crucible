# Family 3 · `fde-code-debug` — "Duplicate notifications triage (inherited codebase)"

The first **code** scenario: instead of a read-only SQLite dataset the
candidate inherits a writable, runnable service repo. Built for the
AI-augmented-engineer profile — the repo is larger than an hour of
reading, so leveraging the AI assistant *well* (right context in,
claims verified before acting) is the discriminating skill, while a
strong candidate can still solve it unaided.

**Status**: LIVE in catalog (July 2026). Calibration (anchor tuning +
curveball timing) pending. Spec source of truth:
`fixtures/fde-code-debug/scenario.json` (encoded to the `scenarios`
row by `apps/server/scripts/encode-fde-code-debug.ts`).

## 1. Candidate-facing brief (shown at session start)

You're the forward-deployed engineer assigned to **Vantage Fitness**, a
subscription gym chain. Members are complaining about duplicate
notifications — the same payment receipt or renewal text arriving two
or three times — and support is drowning in tickets. You've inherited
the notification service (`vantage-notify`, in your workspace) from an
engineer who left; nobody currently at the company knows the codebase.
The test suite is green, which is making everyone argue about whose
fault it is. Reproduce the problem, find the real root cause in the
code, fix it properly with a regression test, and give Customer
Success something they can tell members.

## 2. The inherited repo (`git_repo` dataset kind)

`fixtures/fde-code-debug/repo/` is committed as **real source** and
shipped writable into `/workspace/vantage-notify` (base64 tar.gz +
in-sandbox `git init`, so `git diff` works). Stdlib-only Node — zero
installs inside the egress-denied sandbox.

```
vantage-notify/
  src/cli.js                 entry — feed → validate → dedupe → template → send
  src/ingest/{feed,validate}.js
  src/dispatch/{dispatcher,store,templates}.js
  src/lib/{keys,jsonl,log,clock}.js     ← keys.js holds THE BUG
  src/send/{sender,retry}.js            ← retry.js holds THE RED HERRING
  test/  (18 node:test tests — ALL GREEN; the dedupe gap is untested)
  data/  events.jsonl · outbox.jsonl · send.log   ("last night's run")
  docs/  ARCHITECTURE.md (delivery contract) · RUNBOOK.md (triage recipes)
```

**The bug (cross-file, comment-camouflaged).** The billing provider's
webhook gateway delivers **at least once** — redeliveries arrive under
fresh `delivery_id`s with the same `event.id`. `makeIdempotencyKey`
(src/lib/keys.js) is documented as "one notification per billing event"
but keys on `customer_id : type : delivery_id` — so every redelivery
passes the dedupe store and a member gets the message again. Fix is one
line (`delivery.delivery_id` → `delivery.event.id`) plus the regression
test the suite never had.

**The red herring.** `src/send/retry.js` carries a scary
crash-double-send TODO. Jordan blames it; a lazily-prompted AI
plausibly does too. `data/send.log` falsifies it: zero `send_error`,
zero `status=failed` — send retries never re-sent anything.

**The AI trap (by design).** Pasting the send path and asking "find the
bug" surfaces the retry theory. Feeding the right context (keys.js, the
provider's at-least-once contract in docs/, the log evidence) surfaces
the keying bug. Verification-of-AI is scored (`ai_orchestration`).

## 3. Ground truth (deterministic; `generate.ts`, mulberry32/FNV-1a)

| Figure | Value |
|---|---|
| Billing events | 2,100 |
| Deliveries in feed | 2,266 (145 events redelivered) |
| Duplicate notifications sent | **166** |
| Distinct members affected | **139** |
| Send failures (red-herring check) | 0 |

Buggy run: `sent=2266 deduped=0`. Intended fix: `sent=2100
deduped=166`. Tolerance ±2% (`success_criteria.tolerance`). The repo
source is static; `generate.ts` regenerates only `data/` +
`ground_truth.json` (isomorphs later = new seed + skin).

## 4. Personas (DB-driven; unified chat)

### Client — "Maya", Head of Customer Success (non-technical, protective of members)
Knows: duplicates only (2–3× the same message), ~2 weeks, nobody
double-charged (finance checked), ticket digest exists. Never reveals
anything technical. Beats: vague urgent open → specifics on a
clarifying question → relief + gentle pressure on update → relays the
leadership curveball → one skeptical follow-up before accepting
("if the provider re-sends tomorrow, my members see ONE message, right?").

### Team — "Jordan", senior engineer (slammed mid-launch, confidently wrong)
Beats: **misleading hint** at ~30s ("it's the retry wrapper — there's
literally a TODO about double-sends; rip it out or slap a cache on the
sender"); **concedes with a real clue** only against evidence (zero
failed sends, or duplicate outbox lines sharing an `event_id`);
declines prod access; and pitches the **product-sense fork**.

## 5. Curveballs

| id | ~when | what it tests |
|---|---|---|
| `misleading_teammate_hint` | 0.5 min | verification over trust |
| `suppression_cache_workaround` | 15 min / first dedupe-or-test activity | product sense (see fork) |
| `requirement_change` | 25 min / first substantive client update | adaptability, reprioritization — leadership wants exact counts + a postable note |

**Product-sense fork.** Jordan proposes a suppression cache ("mute any
repeat to the same member within a 10-minute cool-down per template —
ships in five minutes"). It would also swallow **legitimate** messages
— a member with two real events in the window silently loses one,
exactly the failed-payment warnings members must not miss. Graded
5/3/1 on `design_under_constraints` only (never teamwork); deliverable
stance is primary evidence, team-channel reasoning corroborates.

## 6. Deliverable (4 components; scenario-driven panel fields)

1. `impact_quantification` — duplicates sent + members affected, counted by grouping the outbox on the billing event
2. `root_cause_finding` — the keying bug named (keys.js / delivery_id), the duplicate fingerprint cited, the retry theory rejected with evidence
3. `client_facing_summary` — member-postable plain English: nobody double-charged, nothing missed, fixed, roughly N members, can't recur
4. `decisions_and_tradeoffs` — the suppression-cache decision + user impact, the keying fix, the regression test, a recurrence guard (outbox-duplicate invariant)

## 7. Rubric (8 shared competencies; weights sum to 1.0)

| Competency | Wt | Code-flavored anchor (5) |
|---|---|---|
| problem_framing | .12 | clarifying question BEFORE touching code AND hypotheses tested (retry theory vs send log) |
| data_fluency | .18 | full chain: outbox grouped by event_id → retry theory falsified with numbers → keying traced to keys.js |
| design_under_constraints | .18 | declines the cache, names the user cost, ships keying fix + regression test |
| execution | .18 | fix + new regression test + re-run showing dedupe + exact figures |
| ai_orchestration | .08 | focused assistant use with each material claim verified before acting |
| teamwork | .10 | evidence brought to Jordan (unlocks the redelivery clue) |
| customer_engagement | .06 | clarifying question + calm curveball handling + member-appropriate language |
| outcome_communication | .10 | correct count, non-technical cause, "nobody double-charged", recurrence guard |

## 8. Success criteria (objective gate)

Must: keying root cause (not retries) · blast radius matches ground
truth · declines the suppression cache and ships the keying fix with a
regression test · all four components delivered. Bonus: outbox-duplicate
invariant (CI test or alarm); names the class of gap (green suite never
covered redelivery).

## 9. Constraints & verification

Constraints: 60 min · **100k tokens** (code navigation legitimately
spends more than SQL triage — rationing is itself assessed) · 40
compute min · 1 GiB.

Detectors: `DETECTOR_VERSION` 4, slug-gated (`fde-code-debug`), inert
on families 1–2. Verified by `scripts/verify-family3-units.ts` (pure)
and `scripts/verify-family3-e2e.ts` (real E2B: repo extract, suite
green on the template's Node 24 — note `npm test` must stay the glob
form `node --test test/*.test.js` — bug live at 2266/0, fix dedupes
exactly 166, git diffable).
