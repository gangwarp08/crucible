# vantage-notify — architecture

```
provider webhook gateway
        │  (writes the day's deliveries)
        ▼
data/events.jsonl ──▶ ingest (feed + validate)
                          │
                          ▼
                     dispatch (dedupe ▸ template ▸ send)
                          │
                          ▼
                data/outbox.jsonl ──▶ downstream SMS/email relay
                data/send.log        (attempt log, greppable)
```

## Delivery contract

The billing provider's gateway delivers **at least once**. A slow ack or a
gateway timeout means the same billing event (`event.id`) is redelivered
later under a new `delivery_id` with `attempt > 1`. Redelivery is normal
operation, not an error — **the dispatch layer owns idempotency**: one
notification per billing event per member, however many times the feed
hands it to us.

## Commit point

`sendNotification` appends to `data/outbox.jsonl`; one outbox line is one
message a member actually receives. The send log (`data/send.log`) records
every attempt with `status=sent` / `status=send_error` / `status=failed`.

## Invariants

1. Every valid delivery is either sent or deduped — never dropped silently.
2. One outbox line per billing event (idempotency).
3. The outbox append is atomic per line (single process, append mode).
