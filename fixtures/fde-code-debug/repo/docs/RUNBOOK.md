# On-call runbook — vantage-notify

## Nightly batch

Runs at 03:30 US/Eastern after the provider's gateway closes the day's feed.
Green run prints one summary line:
`vantage-notify: deliveries=<n> sent=<n> deduped=<n> invalid=<n>`

## Triage recipes

**Did a member get duplicate messages?**
Group the outbox by the billing event:

```
sort data/outbox.jsonl | grep <cus_id>        # eyeball a member's lines
```

**Did sends fail?**

```
grep -c "status=send_error" data/send.log     # attempt-level errors
grep -c "status=failed" data/send.log         # deliveries that exhausted retries
```

A healthy run has zero of both. The relay flake (VAN-887) has not recurred
since the retry wrapper shipped.

## Known noise

- The gateway redelivers on slow acks — `attempt=2`/`attempt=3` lines in the
  feed are normal and expected to be **deduped**, not sent.
- `invalid` counts a handful of malformed staging-tenant lines most nights.
