# Robustness & Validity Harness

Multi-agent, persona-driven harness that drives **real** candidate sessions with
AI personas at **human pace**, to (a) prove the detector discriminates across the
candidate spectrum and (b) generate valid-run data that lasts realistic time —
not a burst of actions.

Every model call (the platform's persona/assistant/judge AND the candidate
simulator) goes through the LiteLLM gateway → Gemini. Nothing here changes
budget/timeout/detector logic (CLAUDE.md Hard Rules).

## Files

| File | Role |
|---|---|
| `shared.ts` | Generalized session driver (create/auth/WS/query/docs/chat/files/deliverable) + telemetry readback. |
| `pacing.ts` | Human-cadence timing model (seeded, `SPEED` multiplier). The "realistic time" core. |
| `llm.ts` | Simulator LiteLLM key mint/revoke + Gemini chat + token/cost accounting. |
| `personas.ts` | Persona taxonomy. Genuine spectrum + calibration profiles are committed; cheater/malicious/performance are defined but gated. |
| `candidate-agent.ts` | The LLM agent loop: Gemini decides each action; loop executes it with pacing. |
| `manifest.ts` | Run matrix expansion + `--dry-run` cost model. |
| `report.ts` | Discrimination matrix, validity yield, ranked improvement backlog. |
| `run.ts` | Orchestrator: dry-run, concurrency pool, wallet cap, output writing. |

## Usage

Dry-run (no infra, no spend — prints manifest + cost projection):

```bash
pnpm --filter @crucible/server exec tsx scripts/robustness/run.ts --dry-run \
  CLASSES=genuine SCENARIOS=fde-db-triage,fde-api-integration,fde-code-debug TRIALS=6
```

Single smoke run (fast pace, one session):

```bash
pnpm --filter @crucible/server exec tsx scripts/robustness/run.ts \
  CLASSES=genuine SCENARIOS=fde-db-triage TRIALS=1 SPEED=0.25 CONCURRENCY=1
```

Full genuine-spectrum pass at real time:

```bash
pnpm --filter @crucible/server exec tsx scripts/robustness/run.ts \
  CLASSES=genuine SCENARIOS=fde-db-triage,fde-api-integration,fde-code-debug \
  TRIALS=6 SPEED=1 CONCURRENCY=8 WALLET_USD=100
```

Enable other phases later: `CLASSES=cheater`, `CLASSES=malicious`, `CLASSES=performance`.

## Env / flags

- `SERVER_URL` (default `http://127.0.0.1:3001`)
- `CLASSES` — `genuine,cheater,malicious,performance` (default `genuine`)
- `SCENARIOS` — comma slugs (default 3 families)
- `TRIALS` — runs per persona × scenario (default 6)
- `SPEED` — pacing multiplier; `1` = real time (default), `0.25`/`0.1` for fast validation
- `CONCURRENCY` — parallel live sessions (default 6)
- `WALLET_USD` — hard cap for simulator spend; the pool stops launching at this (default 100)
- `MAX_STEPS` — agent action cap per session (default 40)
- `SIM_MODEL` — simulator model alias (default `gemini-flash`)

## Preconditions for a live run

1. Dev server up (`pnpm dev`), Supabase reachable, scenarios seeded.
2. **Gemini wallet funded** — both the per-session candidate keys and the
   simulator key draw on it. If unfunded, `run.ts` SKIPs cleanly at key-mint.
3. For malicious/performance phases: use the dedicated test org and temporarily
   raise `GLOBAL_DAILY_SPEND_CEILING_USD` for the window (ops step; Hard Rule —
   requires sign-off).

## Outputs

`docs/robustness/<runId>/` → `manifest.json`, `runs.jsonl` (one line per run),
`report.md` (discrimination matrix + validity yield + improvement backlog).
`runs.jsonl` also lists every synthetic `sessionId` so they can be excluded from
recruiter metrics or promoted into calibration data deliberately.
