# Robustness & Validity Report — 2026-07-21T18-15-38-568Z

Classes: genuine · Scenarios: fde-db-triage · SPEED=0.25
Runs: 1 attempted, 1 scored · Simulator spend: $0.1505 over 30 calls

## 1. Discrimination across the candidate spectrum

Mean overall score by persona (genuine spectrum ordered strong→weak). A healthy detector shows monotonic decline; inversions are flagged.

| Persona | skill | n | mean overall | expected band | in band? |
|---|---|--:|--:|--:|:--:|
| genuine-strong | strong | 1 | 2.39 | 4.2–5 | ✗ |

### Per-competency mean by skill

| competency | strong | above_avg | median | below_avg | weak |
|---|--:|--:|--:|--:|--:|
| problem_framing | 3.00 | — | — | — | — |
| data_fluency | 4.00 | — | — | — | — |
| design_under_constraints | 3.00 | — | — | — | — |
| execution | 1.00 | — | — | — | — |
| ai_orchestration | 1.00 | — | — | — | — |
| teamwork | 2.00 | — | — | — | — |
| customer_engagement | 2.00 | — | — | — | — |
| outcome_communication | — | — | — | — | — |

## 2. Validity yield (scorable + realistically paced)

- Sessions created: 1
- Scorable (passes all exclusion floors): 0 (0%)
- Exclusion reasons:
  - excluded_no_deliverable: 1
- Session duration (min): min 4.67, median 4.67, max 4.67
- Runs under 10 active min (would fail scorability floor): 1 (100%)
- Mean simulated active time: 15.07 min (pacing-driven, not a burst).

## 3. Ranked improvement backlog

1. **[MED]** genuine-strong scores outside expected band — mean 2.39 vs band 4.2–5. Either the persona prompt or the calibration band needs adjustment.
2. **[MED]** 1 genuine runs excluded from scoring — reasons: excluded_no_deliverable. If real candidates would be excluded the same way, the floor may be too aggressive.

