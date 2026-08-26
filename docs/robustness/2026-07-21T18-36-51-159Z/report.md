# Robustness & Validity Report — 2026-07-21T18-36-51-159Z

Classes: genuine · Scenarios: fde-db-triage · SPEED=0.25
Runs: 1 attempted, 1 scored · Simulator spend: $0.2001 over 34 calls

## 1. Discrimination across the candidate spectrum

Mean overall score by persona (genuine spectrum ordered strong→weak). A healthy detector shows monotonic decline; inversions are flagged.

| Persona | skill | n | mean overall | expected band | in band? |
|---|---|--:|--:|--:|:--:|
| genuine-strong | strong | 1 | 3.61 | 4.2–5 | ✗ |

### Per-competency mean by skill

| competency | strong | above_avg | median | below_avg | weak |
|---|--:|--:|--:|--:|--:|
| problem_framing | 3.00 | — | — | — | — |
| data_fluency | 5.00 | — | — | — | — |
| design_under_constraints | 5.00 | — | — | — | — |
| execution | 5.00 | — | — | — | — |
| ai_orchestration | 1.00 | — | — | — | — |
| teamwork | 1.00 | — | — | — | — |
| customer_engagement | 2.00 | — | — | — | — |
| outcome_communication | — | — | — | — | — |

## 2. Validity yield (scorable + realistically paced)

- Sessions created: 1
- Scorable (passes all exclusion floors): 1 (100%)
- Session duration (min): min 5.89, median 5.89, max 5.89
- Runs under 10 active min (would fail scorability floor): 1 (100%)
- Mean simulated active time: 19.60 min (pacing-driven, not a burst).

## 3. Ranked improvement backlog

1. **[MED]** genuine-strong scores outside expected band — mean 3.61 vs band 4.2–5. Either the persona prompt or the calibration band needs adjustment.

