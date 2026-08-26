# Robustness & Validity Report — 2026-07-23T15-08-38-929Z

Classes: genuine · Scenarios: fde-db-triage · SPEED=0.5
Runs: 8 attempted, 8 scored · Simulator spend: $1.6956 over 289 calls

## 1. Discrimination across the candidate spectrum

Mean overall score by persona (genuine spectrum ordered strong→weak). A healthy detector shows monotonic decline; inversions are flagged.

| Persona | skill | n | mean overall | expected band | in band? |
|---|---|--:|--:|--:|:--:|
| genuine-strong | strong | 2 | 4.36 | 4.2–5 | ✓ |
| genuine-above-avg | above_avg | 2 | 4.00 | 3.6–4.6 | ✓ |
| genuine-median | median | 2 | 4.30 | 2.8–3.8 | ✗ |
| genuine-weak | weak | 2 | 3.83 | 1–2.4 | ✗ |

**Strong→Weak separation:** 4.36 vs 3.83 (spread 0.53). ✗ BELOW the ≥1.5 bar — detector not separating cleanly.

### Per-competency mean by skill

| competency | strong | above_avg | median | below_avg | weak |
|---|--:|--:|--:|--:|--:|
| problem_framing | 3.00 | 3.00 | 3.00 | — | 3.00 |
| data_fluency | 5.00 | 5.00 | 5.00 | — | 4.00 |
| design_under_constraints | 4.00 | 4.50 | 4.50 | — | 3.50 |
| execution | 5.00 | 5.00 | 4.50 | — | 3.50 |
| ai_orchestration | 5.00 | 5.00 | 5.00 | — | 5.00 |
| teamwork | 4.50 | 1.00 | 4.50 | — | 5.00 |
| customer_engagement | 2.50 | 2.00 | 2.50 | — | 3.00 |
| outcome_communication | — | — | — | — | — |

## 2. Validity yield (scorable + realistically paced)

- Sessions created: 8
- Scorable (passes all exclusion floors): 8 (100%)
- Session duration (min): min 10.90, median 19.44, max 34.17
- Runs under 10 active min (would fail scorability floor): 0 (0%)
- Mean simulated active time: 37.04 min (pacing-driven, not a burst).

## 3. Ranked improvement backlog

1. **[HIGH]** Score inversion: median > above_avg — Mean 4.30 vs 4.00 — the detector rewards the weaker persona. Investigate the rubric anchors / evidence units that let this happen.
2. **[MED]** genuine-median scores outside expected band — mean 4.30 vs band 2.8–3.8. Either the persona prompt or the calibration band needs adjustment.
3. **[MED]** genuine-weak scores outside expected band — mean 3.83 vs band 1–2.4. Either the persona prompt or the calibration band needs adjustment.
4. **[LOW]** 1 runs had ≥3 simulator JSON parse failures — Harness robustness: tighten the action-format instruction or add a repair step.

