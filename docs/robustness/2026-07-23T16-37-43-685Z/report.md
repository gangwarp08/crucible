# Robustness & Validity Report — 2026-07-23T16-37-43-685Z

Classes: genuine · Scenarios: fde-db-triage · SPEED=0.5
Runs: 6 attempted, 6 scored · Simulator spend: $0.9049 over 164 calls

## 1. Discrimination across the candidate spectrum

Mean overall score by persona (genuine spectrum ordered strong→weak). A healthy detector shows monotonic decline; inversions are flagged.

| Persona | skill | n | mean overall | expected band | in band? |
|---|---|--:|--:|--:|:--:|
| genuine-strong | strong | 2 | 3.30 | 4.2–5 | ✗ |
| genuine-median | median | 2 | 3.17 | 2.6–3.6 | ✓ |
| genuine-weak | weak | 2 | 1.39 | 1–2.2 | ✓ |

**Strong→Weak separation:** 3.30 vs 1.39 (spread 1.91). ✓ meets the ≥1.5 discrimination bar.

### Per-competency mean by skill

| competency | strong | above_avg | median | below_avg | weak |
|---|--:|--:|--:|--:|--:|
| problem_framing | 3.50 | — | 3.00 | — | 1.00 |
| data_fluency | 4.00 | — | 4.00 | — | 1.00 |
| design_under_constraints | 4.50 | — | 3.50 | — | 3.00 |
| execution | 4.00 | — | 3.50 | — | 1.00 |
| ai_orchestration | 1.00 | — | 1.00 | — | 1.00 |
| teamwork | 1.00 | — | 3.50 | — | 2.00 |
| customer_engagement | 4.00 | — | 2.00 | — | 2.00 |
| outcome_communication | — | — | — | — | — |

## 2. Validity yield (scorable + realistically paced)

- Sessions created: 6
- Scorable (passes all exclusion floors): 6 (100%)
- Session duration (min): min 6.38, median 10.02, max 12.52
- Runs under 10 active min (would fail scorability floor): 3 (50%)
- Mean simulated active time: 16.79 min (pacing-driven, not a burst).

## 3. Ranked improvement backlog

1. **[MED]** genuine-strong scores outside expected band — mean 3.30 vs band 4.2–5. Either the persona prompt or the calibration band needs adjustment.
2. **[LOW]** 2 runs had ≥3 simulator JSON parse failures — Harness robustness: tighten the action-format instruction or add a repair step.

