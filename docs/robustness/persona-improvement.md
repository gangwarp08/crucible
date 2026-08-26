# Persona Improvement Log

Living doc. Records what we learn about making the AI candidate personas **realistic
(close to a real human run)** and **discriminating** (skill maps to score) across
robustness simulation runs. Append a dated entry per iteration; keep the "Current
persona design principles" section at the top current.

Related: [platform-improvement.md](./platform-improvement.md) (findings about the
platform itself). Harness: `apps/server/scripts/robustness/`.

---

## Current persona design principles (keep current)

1. **Behave at the persona's true level — including mistakes.** Never "help" a weak
   persona do better than it would. Weakness must be genuine (shallow queries, poor
   verification, deferring to the teammate), not just a lower final number.
2. **Do the whole job, not just the puzzle.** A capable candidate (a) uses the
   in-session AI assistant to sanity-check/unblock, and (b) keeps the client updated
   and coordinates with the teammate — sending the client a findings summary before
   submitting. Scale this to skill: strong does it well and proactively; weak barely.
3. **Efficiency is part of skill.** Strong personas converge — once the root cause is
   verified with evidence, they summarize and submit. They do NOT burn the whole clock
   re-checking (that produced worse deliverables than a more efficient mid persona).
4. **Human pacing, not bursts.** Reading time ∝ text length, composing ∝ output length,
   think-gaps + occasional "stuck" gaps, seeded per-run jitter (`pacing.ts`). Weaker
   personas read/type slower and idle more. Target realistic durations (10–40 min).
5. **Always hand something in.** Like a real candidate under a deadline, submit a
   best-effort deliverable even when out of time (forced-submission fallback), so the
   run is scorable and the score reflects work actually done.

---

## Iteration log

### 2026-07-23 — v2 behavior fix (assistant + communication + efficiency)

**Problem (from the 108-run overnight pass, runId 2026-07-21T23-55-45-323Z):**
- `ask_assistant = 0` across **every** run → `ai_orchestration` floored at 1.00 for
  all personas (no signal, and it dragged every overall score down).
- Personas barely messaged stakeholders → `teamwork`, `customer_engagement`,
  `outcome_communication` starved / not-assessed.
- Strong persona over-investigated → hit the wall-clock ceiling → produced a WORSE
  deliverable than the more efficient above_avg persona → **strong < above_avg
  inversion**.

**Change:** system prompt now (a) directs assistant use + a client findings-summary
before submit, scaled to persona skill; (b) tells strong personas to converge and
submit once the root cause is verified.

**Result (validation batch, db-triage, SPEED=0.5):**
| persona | before (overall) | after | assistant calls | client msgs |
|---|--:|--:|--:|--:|
| genuine-strong | 2.56–3.61 | **4.33–4.39** | 0 → 2 | 0 → 1–2 |
| genuine-above-avg | ~3.6 (noisy) | 3.94–4.06 | 0 → 1–4 | 0 → 1 |

Strong now lands in its expected band (4.2–5.0) and above above_avg — inversion fixed.

### 2026-07-23 — v3 differentiation fix (v2 over-corrected, flattening discrimination)

**Problem:** the v2 fix put "do the whole job — use the assistant, communicate, be
thorough" in the SHARED prompt, so it applied to every persona. A capable model told
to play "weak" still solved the task. Result (db-triage, 2 trials each):

| persona | v2 mean overall | assistant calls | verdict |
|---|--:|--:|---|
| genuine-strong | 4.36 | 2 | ok |
| genuine-above-avg | 4.00 | 1–4 | ok |
| genuine-median | **4.30** | 3–4 | too high |
| genuine-weak | **3.83** | 5–9 | way too high |

Spread strong→weak only **0.53** (need ≥1.5). Weak ran 15–22 queries and used the
assistant 9×. **Core lesson: a strong LLM playing a weak candidate defaults to
competence unless weakness is made concrete and capped.**

**Change (v3):**
- Moved the "use assistant / communicate / be thorough" guidance OUT of the shared
  prompt and INTO the strong/above_avg briefs only.
- Shared prompt now states the persona is a hard CEILING on competence: "do NOT solve
  the problem better than your persona would, even if you can see the answer."
- Gave median/below_avg/weak concrete FAILURE MODES + hard caps: weak runs only 3–5
  simple queries, never checks data-quality (duplicates/test rows), accepts the
  teammate's theory untested, never verifies, and submits the naive WRONG numbers.

**Result:** (pending re-validation batch — strong/median/weak × 2).

**Meta-lesson for all future persona work:** differentiate by *concrete behavior and
hard caps*, not adjectives. "Weak" alone doesn't lower an LLM's output; "run ≤5 simple
queries, accept the teammate's theory, submit the un-deduplicated numbers" does.

### 2026-07-23 — v4 imperative strong/above_avg briefs → CLEAN monotonic gradient ✓

**Problem after v3:** weak was fixed (1.39) but strong regressed to 3.30 and stopped
using the assistant — moving excellence guidance into the strong brief made it
*descriptive*, which the model ignored.

**Change:** rewrote strong/above_avg briefs as IMPERATIVE must-do directives ("you MUST
run a data-quality check, verify every number, use the assistant at least once, be
efficient (~12–18 queries), submit the correct de-duplicated numbers").

**Result (db-triage, 2 trials each) — validated discriminating spectrum:**
| persona | mean overall | in band | assistant | client msgs |
|---|--:|:--:|--:|--:|
| genuine-strong | **4.55** | ✓ | 3 | 2–4 |
| genuine-above-avg | **4.28** | ✓ | 0–1 | 0–1 |
| genuine-median | **2.83** | ✓ | 0 | 0–1 |
| genuine-below-avg | **1.69** | ✓ | 0 | 1 |
| genuine-weak | **1.39** | ✓ | 0 | 0 |

Fully monotonic; strong→weak spread **3.16** (bar ≥1.5). Durations 6–18 min, all
scorable. **This is the persona design we run the full pass on.**

**Meta-lesson (reinforced):** LLM personas obey IMPERATIVE directives ("you MUST X"),
not descriptive adjectives ("you are thorough"). Encode both the *floor* behaviors for
strong personas and the *caps/failure-modes* for weak ones as explicit instructions.

**Still open / next:**
- Profiles A–D not yet re-measured with v4 shared prompt (full run will measure).
- below_avg (1.69) sits close to weak (1.39) — watch with 6 trials; may widen its brief.
- api-integration discrimination: re-measure in the full run (was noisy in v1).
- code-debug personas need terminal test-running to score execution (see platform doc).
