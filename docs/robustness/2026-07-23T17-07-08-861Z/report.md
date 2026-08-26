# Robustness & Validity Report — 2026-07-23T17-07-08-861Z

Classes: genuine · Scenarios: fde-db-triage · SPEED=0.5
Runs: 10 attempted, 10 scored · Simulator spend: $1.4324 over 284 calls

## 1. Discrimination across the candidate spectrum

Mean overall score by persona (genuine spectrum ordered strong→weak). A healthy detector shows monotonic decline; inversions are flagged.

| Persona | skill | n | mean overall | expected band | in band? |
|---|---|--:|--:|--:|:--:|
| genuine-strong | strong | 2 | 4.55 | 4.2–5 | ✓ |
| genuine-above-avg | above_avg | 2 | 4.28 | 3.6–4.6 | ✓ |
| genuine-median | median | 2 | 2.83 | 2.6–3.6 | ✓ |
| genuine-below-avg | below_avg | 2 | 1.69 | 1.8–3 | ✗ |
| genuine-weak | weak | 2 | 1.39 | 1–2.2 | ✓ |

**Strong→Weak separation:** 4.55 vs 1.39 (spread 3.17). ✓ meets the ≥1.5 discrimination bar.

### Per-competency mean by skill

| competency | strong | above_avg | median | below_avg | weak |
|---|--:|--:|--:|--:|--:|
| problem_framing | 4.00 | 3.00 | 3.00 | 1.50 | 1.00 |
| data_fluency | 5.00 | 5.00 | 4.00 | 2.00 | 1.00 |
| design_under_constraints | 4.50 | 5.00 | 4.50 | 3.00 | 3.00 |
| execution | 5.00 | 5.00 | 2.50 | 1.00 | 1.00 |
| ai_orchestration | 5.00 | 3.00 | 1.00 | 1.00 | 1.00 |
| teamwork | 3.00 | 5.00 | 1.50 | 2.00 | 2.00 |
| customer_engagement | 5.00 | 2.00 | 2.00 | 2.00 | 2.00 |
| outcome_communication | — | — | — | — | — |

## 2. Validity yield (scorable + realistically paced)

- Sessions created: 10
- Scorable (passes all exclusion floors): 10 (100%)
- Session duration (min): min 6.40, median 9.72, max 18.46
- Runs under 10 active min (would fail scorability floor): 5 (50%)
- Mean simulated active time: 18.87 min (pacing-driven, not a burst).

## 3. Ranked improvement backlog

No issues detected by the automated heuristics. Review the discrimination table manually.

