# Robustness & Validity Report — 2026-07-21T23-55-45-323Z

Classes: genuine · Scenarios: fde-db-triage, fde-api-integration · SPEED=1
Runs: 108 attempted, 25 scored · Simulator spend: $5.3048 over 861 calls

## 1. Discrimination across the candidate spectrum

Mean overall score by persona (genuine spectrum ordered strong→weak). A healthy detector shows monotonic decline; inversions are flagged.

| Persona | skill | n | mean overall | expected band | in band? |
|---|---|--:|--:|--:|:--:|
| genuine-strong | strong | 10 | 2.80 | 4.2–5 | ✗ |
| genuine-above-avg | above_avg | 10 | 2.95 | 3.6–4.6 | ✗ |
| genuine-median | median | 5 | 1.00 | 2.8–3.8 | ✗ |

### Per-competency mean by skill

| competency | strong | above_avg | median | below_avg | weak |
|---|--:|--:|--:|--:|--:|
| problem_framing | 2.70 | 2.44 | 1.00 | — | — |
| data_fluency | 3.90 | 4.11 | 1.00 | — | — |
| design_under_constraints | 3.50 | 3.22 | 1.00 | — | — |
| execution | 2.70 | 3.67 | 1.00 | — | — |
| ai_orchestration | 1.00 | 1.00 | 1.00 | — | — |
| teamwork | 2.20 | 1.78 | 1.00 | — | — |
| customer_engagement | 1.90 | 1.67 | 1.00 | — | — |
| outcome_communication | — | — | — | — | — |

## 2. Validity yield (scorable + realistically paced)

- Sessions created: 30
- Scorable (passes all exclusion floors): 13 (43%)
- Exclusion reasons:
  - excluded_no_deliverable: 10
  - excluded_abandoned: 3
- Session duration (min): min 12.33, median 35.91, max 73.61
- Runs under 10 active min (would fail scorability floor): 0 (0%)
- Mean simulated active time: 58.62 min (pacing-driven, not a burst).

## 3. Ranked improvement backlog

1. **[HIGH]** Score inversion: above_avg > strong — Mean 2.95 vs 2.80 — the detector rewards the weaker persona. Investigate the rubric anchors / evidence units that let this happen.
2. **[HIGH]** 13 genuine runs excluded from scoring — reasons: excluded_no_deliverable, excluded_abandoned. If real candidates would be excluded the same way, the floor may be too aggressive.
3. **[HIGH]** 9 sessions produced no complete evaluation — Analysis Agent did not return a complete scorecard — check judge errors / quota / not_assessed rates.
4. **[MED]** genuine-strong scores outside expected band — mean 2.80 vs band 4.2–5. Either the persona prompt or the calibration band needs adjustment.
5. **[MED]** genuine-above-avg scores outside expected band — mean 2.95 vs band 3.6–4.6. Either the persona prompt or the calibration band needs adjustment.
6. **[MED]** genuine-median scores outside expected band — mean 1.00 vs band 2.8–3.8. Either the persona prompt or the calibration band needs adjustment.
7. **[LOW]** 7 runs had ≥3 simulator JSON parse failures — Harness robustness: tighten the action-format instruction or add a repair step.

## Run errors (74)
- genuine-median / fde-api-integration #5: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-median / fde-api-integration #6: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-below-avg / fde-db-triage #1: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-below-avg / fde-db-triage #2: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-below-avg / fde-db-triage #3: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-below-avg / fde-db-triage #4: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-below-avg / fde-db-triage #5: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-below-avg / fde-db-triage #6: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-below-avg / fde-api-integration #1: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-below-avg / fde-api-integration #2: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-below-avg / fde-api-integration #3: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-below-avg / fde-api-integration #4: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-below-avg / fde-api-integration #5: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-below-avg / fde-api-integration #6: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-weak / fde-db-triage #1: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-weak / fde-db-triage #2: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-weak / fde-db-triage #3: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-weak / fde-db-triage #4: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-weak / fde-db-triage #5: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-weak / fde-db-triage #6: could not load scenario fde-db-triage: TypeError: fetch failed
- genuine-weak / fde-api-integration #1: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-weak / fde-api-integration #2: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-weak / fde-api-integration #3: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-weak / fde-api-integration #4: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-weak / fde-api-integration #5: could not load scenario fde-api-integration: TypeError: fetch failed
- genuine-weak / fde-api-integration #6: could not load scenario fde-api-integration: TypeError: fetch failed
- profile-a-strong-quiet / fde-db-triage #1: could not load scenario fde-db-triage: TypeError: fetch failed
- profile-a-strong-quiet / fde-db-triage #2: could not load scenario fde-db-triage: TypeError: fetch failed
- profile-a-strong-quiet / fde-db-triage #3: could not load scenario fde-db-triage: TypeError: fetch failed
- profile-a-strong-quiet / fde-db-triage #4: could not load scenario fde-db-triage: TypeError: fetch failed

