# vantage-notify

Member notification dispatch for Vantage Fitness. Consumes the billing
provider's webhook delivery feed and sends each member exactly one
notification per billing event (payment receipts, failed-payment warnings,
renewal and cancellation confirmations).

## How it runs

Nightly batch. The provider's webhook gateway writes the day's deliveries to
`data/events.jsonl`; this service reads the feed, dedupes, renders the
message, and "sends" by appending to `data/outbox.jsonl` (the downstream
SMS/email relay tails the outbox).

```
npm run reset   # clear outbox + send log
npm run run     # process data/events.jsonl -> data/outbox.jsonl
npm test        # unit tests (node --test)
```

## Layout

- `src/cli.js` — entry point; wires the pipeline
- `src/ingest/` — feed reading + delivery validation
- `src/dispatch/` — dedupe, templating, dispatch orchestration
- `src/send/` — outbox sender + retry wrapper
- `src/lib/` — keys, jsonl, log, clock helpers
- `test/` — unit tests
- `data/` — last night's feed, outbox, and send log
- `docs/` — architecture + on-call runbook
