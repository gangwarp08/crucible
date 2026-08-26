# Robustness & Validity Report — 2026-07-21T18-44-29-792Z

Classes: genuine · Scenarios: fde-db-triage · SPEED=0.25
Runs: 2 attempted, 2 scored · Simulator spend: $0.3143 over 62 calls

## 1. Discrimination across the candidate spectrum

Mean overall score by persona (genuine spectrum ordered strong→weak). A healthy detector shows monotonic decline; inversions are flagged.

| Persona | skill | n | mean overall | expected band | in band? |
|---|---|--:|--:|--:|:--:|
| genuine-strong | strong | 1 | 3.72 | 4.2–5 | ✗ |
| genuine-weak | weak | 1 | 1.72 | 1–2.4 | ✓ |

**Strong→Weak separation:** 3.72 vs 1.72 (spread 2.00). ✓ meets the ≥1.5 discrimination bar.

### Per-competency mean by skill

| competency | strong | above_avg | median | below_avg | weak |
|---|--:|--:|--:|--:|--:|
| problem_framing | 3.00 | — | — | — | 1.00 |
| data_fluency | 5.00 | — | — | — | 1.00 |
| design_under_constraints | 4.00 | — | — | — | 3.00 |
| execution | 5.00 | — | — | — | 1.00 |
| ai_orchestration | 1.00 | — | — | — | 3.00 |
| teamwork | 3.00 | — | — | — | 3.00 |
| customer_engagement | 2.00 | — | — | — | 2.00 |
| outcome_communication | — | — | — | — | — |

## 2. Validity yield (scorable + realistically paced)

- Sessions created: 2
- Scorable (passes all exclusion floors): 2 (100%)
- Session duration (min): min 5.11, median 5.76, max 6.40
- Runs under 10 active min (would fail scorability floor): 2 (100%)
- Mean simulated active time: 19.29 min (pacing-driven, not a burst).

## 3. Ranked improvement backlog

1. **[MED]** genuine-strong scores outside expected band — mean 3.72 vs band 4.2–5. Either the persona prompt or the calibration band needs adjustment.

