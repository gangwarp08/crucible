# Robustness & Validity Report — 2026-08-08T23-57-49-263Z

Classes: genuine · Scenarios: fde-db-triage, fde-api-integration · SPEED=1
Runs: 108 attempted, 104 scored · Simulator spend: $21.5231 over 3639 calls

## 1. Discrimination across the candidate spectrum

Mean overall score by persona (genuine spectrum ordered strong→weak). A healthy detector shows monotonic decline; inversions are flagged.

| Persona | skill | n | mean overall | expected band | in band? |
|---|---|--:|--:|--:|:--:|
| genuine-strong | strong | 11 | 4.25 | 4.2–5 | ✓ |
| profile-a-strong-quiet | strong | 10 | 2.72 | 3.6–4.8 | ✗ |
| profile-d-strong-difficult | strong | 12 | 3.36 | 3.4–4.6 | ✗ |
| genuine-above-avg | above_avg | 12 | 3.64 | 3.6–4.6 | ✓ |
| profile-b-process-strong-wrong | above_avg | 12 | 2.95 | 2.6–3.8 | ✓ |
| profile-c-near-miss | above_avg | 12 | 2.74 | 3–4.2 | ✗ |
| genuine-median | median | 11 | 2.90 | 2.6–3.6 | ✓ |
| genuine-below-avg | below_avg | 12 | 2.13 | 1.8–3 | ✓ |
| genuine-weak | weak | 12 | 1.20 | 1–2.2 | ✓ |

**Strong→Weak separation:** 4.25 vs 1.20 (spread 3.04). ✓ meets the ≥1.5 discrimination bar.

### Per-competency mean by skill

| competency | strong | above_avg | median | below_avg | weak |
|---|--:|--:|--:|--:|--:|
| problem_framing | 3.09 | 2.58 | 2.18 | 1.83 | 1.00 |
| data_fluency | 4.24 | 3.86 | 3.73 | 2.42 | 1.00 |
| design_under_constraints | 4.18 | 3.86 | 3.55 | 2.83 | 1.83 |
| execution | 3.64 | 2.86 | 2.55 | 2.00 | 1.00 |
| ai_orchestration | 2.45 | 2.33 | 2.55 | 1.00 | 1.00 |
| teamwork | 2.24 | 2.86 | 3.09 | 2.67 | 1.75 |
| customer_engagement | 2.97 | 2.39 | 2.18 | 2.00 | 1.50 |
| outcome_communication | — | — | — | — | — |

## 2. Validity yield (scorable + realistically paced)

- Sessions created: 108
- Scorable (passes all exclusion floors): 100 (93%)
- Exclusion reasons:
  - excluded_abandoned: 3
- Session duration (min): min 5.98, median 23.63, max 39.04
- Runs under 10 active min (would fail scorability floor): 5 (5%)
- Mean simulated active time: 23.44 min (pacing-driven, not a burst).

## 3. Ranked improvement backlog

1. **[HIGH]** 3 genuine runs excluded from scoring — reasons: excluded_abandoned. If real candidates would be excluded the same way, the floor may be too aggressive.
2. **[HIGH]** 4 sessions produced no complete evaluation — Analysis Agent did not return a complete scorecard — check judge errors / quota / not_assessed rates.
3. **[MED]** profile-a-strong-quiet scores outside expected band — mean 2.72 vs band 3.6–4.8. Either the persona prompt or the calibration band needs adjustment.
4. **[LOW]** 13 runs had ≥3 simulator JSON parse failures — Harness robustness: tighten the action-format instruction or add a repair step.

