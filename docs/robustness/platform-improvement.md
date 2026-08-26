# Platform Improvement Log

Living doc. Records findings **about the Crucible platform itself** (detector v4,
Analysis Agent judge, scenarios, scorability, budgets, infra) surfaced by the
robustness simulation runs. This is the "list of improvements" deliverable to be
shared at the end of the full run. Append a dated entry per finding; keep the ranked
backlog at the top current. Distinguish CONFIRMED (reproduced) from SUSPECTED.

Related: [persona-improvement.md](./persona-improvement.md) (harness-side persona
tuning — NOT platform issues). Harness: `apps/server/scripts/robustness/`.

---

## Ranked backlog (keep current)

| # | Sev | Area | Finding | Status |
|---|---|---|---|---|
| 1 | MED | Judge / rubric | `ai_orchestration` scores 1.00 (floor) when a candidate never uses the AI assistant — a strong candidate who didn't need it is penalized rather than marked not-assessed. Consider not_assessed when there are zero assistant turns. | SUSPECTED |
| 2 | MED | Judge / rubric | `outcome_communication` frequently not-assessed — appears to need a client-channel message; a strong `client_facing_summary` in the deliverable may not count on its own. Verify the detector credits the deliverable field. | SUSPECTED |
| 3 | MED | Scenario | `fde-code-debug` (git_repo) can't be meaningfully scored on execution without candidate-facing terminal test-running — the scenario expects `npm test` / rerun, but there's no clean harness path yet. Is there a candidate test-runner surface? | OPEN |
| 4 | LOW | Scenario | `fde-api-integration` discrimination looked weak/noisy vs `fde-db-triage` in v1 (strong sometimes < median). Re-measure with v2 personas before concluding scenario vs persona. | INVESTIGATING |
| 5 | — | Infra (NOT platform) | Overnight run failures were the local dev machine sleeping (connections died), not a platform defect. Mitigated harness-side (caffeinate + longer retry). Noted so it isn't mis-filed as a platform bug. | RESOLVED (harness) |
| 6 | — | Infra (NOT platform) | The 108-run pass (2026-07-23T18-13) collapsed (0 scorable, 85 abandoned) because the ONE simulator LiteLLM key was minted with a fixed TTL (`duration`) shorter than the ~16h wall-clock of a full SPEED=1 pass. It expired mid-run (2026-07-24 10:53 UTC) → every remaining session got `401 expired_key` and aborted. NOT a persona regression. Fixed harness-side: simChat now auto-re-mints on expiry. Bad run purged from Supabase + disk. | RESOLVED (harness) |

---

## What's working well (validated)

- **Discrimination is real**: with correct persona behavior, strong (4.3–4.4) separates
  cleanly from weak (1.7 in an earlier clean batch) — spread ≥ 1.5, monotonic.
- **Scorability floors behave**: sessions with no deliverable / <10 active min are
  correctly excluded (`excluded_no_deliverable`, `excluded_abandoned`).
- **Org isolation works**: synthetic sessions attribute to the dedicated `robustness-sim`
  org via minted links; visible to that org's review key + admin; out of the default tenant.
- **Budget/ceiling controls held**: per-session budget + global daily ceiling enforced;
  no runaway spend (~$5 across all runs so far vs $100 wallet).
- **Realistic durations**: pacing produced 12–74 min sessions (median ~36 min), 0% under
  the 10-min active floor — valid-run data that looks human, not action bursts.

---

## Finding log

### 2026-07-23 — from the 108-run pass + v2 validation batch
- CONFIRMED: `ai_orchestration` = 1.00 whenever `ask_assistant` count is 0 (every v1 run).
  Once v2 personas used the assistant, the competency began to vary. **Question for the
  platform**: should zero-assistant sessions be `ai_orchestration: not_assessed` rather
  than a 1.00 that penalizes competent unaided work? (backlog #1)
- SUSPECTED: `outcome_communication` shows `—` (not assessed) unless the candidate posts
  a client-facing message; the deliverable's summary field alone may not trigger it.
  Verify against `evidence-extractor.ts` `client_update_count` / outcome detectors. (#2)
- Data quality note: the overnight failures were infra (machine sleep), so v1 aggregate
  scores (strong 2.8 / above_avg 2.95) are NOT reliable platform signal — superseded by
  the v2 batch. Only clean, caffeinated runs feed platform conclusions from here.

### 2026-08-08 — root-caused the 108-run collapse: simulator key expiry (backlog #6)
- CONFIRMED (from the run's own `runs.jsonl`): the dominant abort was
  `401 Authentication Error - Expired Key` (key expiry 2026-07-24 10:53 UTC), not a
  persona or scoring problem. Sessions that ran *before* expiry had full activity
  (13 queries, assistant use, client msgs, accruedSeconds up to 27k); those *after*
  died on their first sim call → `excluded_abandoned`. The report's "median 0.85 min"
  was those post-expiry corpses, a red herring.
- Root cause: `mintSimulatorKey` issues one key with a fixed `duration` TTL
  (`SIM_KEY_MINUTES`, default 600m), but a full genuine pass at SPEED=1/CONCURRENCY=4
  runs ~16h. TTL < wall-clock ⇒ guaranteed mid-run expiry.
- Fix (harness): `llm.ts` now owns the live key and `simChat` transparently re-mints on
  an expired-key 401 (concurrency-deduped) and retries, so a run of any length survives.
  `revokeSimulatorKey` also reaps the re-minted replacement. The collapsed run's 108
  sessions (+ evaluations/cascade) were purged from Supabase and the local run dir deleted.
