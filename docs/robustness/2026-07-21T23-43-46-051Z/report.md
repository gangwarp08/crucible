# Robustness & Validity Report — 2026-07-21T23-43-46-051Z

Classes: genuine · Scenarios: fde-db-triage, fde-api-integration · SPEED=0.25
Runs: 4 attempted, 4 scored · Simulator spend: $0.7767 over 134 calls

## 1. Discrimination across the candidate spectrum

Mean overall score by persona (genuine spectrum ordered strong→weak). A healthy detector shows monotonic decline; inversions are flagged.

| Persona | skill | n | mean overall | expected band | in band? |
|---|---|--:|--:|--:|:--:|
| genuine-strong | strong | 2 | 2.71 | 4.2–5 | ✗ |
| genuine-median | median | 2 | 3.16 | 2.8–3.8 | ✓ |

### Per-competency mean by skill

| competency | strong | above_avg | median | below_avg | weak |
|---|--:|--:|--:|--:|--:|
| problem_framing | 2.00 | — | 3.00 | — | — |
| data_fluency | 3.50 | — | 4.50 | — | — |
| design_under_constraints | 4.00 | — | 4.50 | — | — |
| execution | 3.50 | — | 3.00 | — | — |
| ai_orchestration | 1.00 | — | 1.00 | — | — |
| teamwork | 1.00 | — | 2.00 | — | — |
| customer_engagement | 1.50 | — | 2.00 | — | — |
| outcome_communication | — | — | — | — | — |

## 2. Validity yield (scorable + realistically paced)

- Sessions created: 4
- Scorable (passes all exclusion floors): 4 (100%)
- Session duration (min): min 5.08, median 7.01, max 8.01
- Runs under 10 active min (would fail scorability floor): 4 (100%)
- Mean simulated active time: 21.15 min (pacing-driven, not a burst).

## 3. Ranked improvement backlog

1. **[MED]** genuine-strong scores outside expected band — mean 2.71 vs band 4.2–5. Either the persona prompt or the calibration band needs adjustment.
2. **[LOW]** 2 runs had ≥3 simulator JSON parse failures — Harness robustness: tighten the action-format instruction or add a repair step.

