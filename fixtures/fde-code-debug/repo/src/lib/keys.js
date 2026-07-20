// Idempotency keys for the notification pipeline.
//
// The billing provider's webhook gateway delivers AT LEAST once: a slow ack
// or a gateway timeout means the same billing event shows up in the feed
// again as a fresh delivery. The outbox layer is the single place that
// guarantees a member never gets the same notification twice.

/**
 * One notification per billing event per member, no matter how many times
 * the feed hands it to us.
 */
export function makeIdempotencyKey(delivery) {
  return `${delivery.event.customer_id}:${delivery.event.type}:${delivery.delivery_id}`;
}

/**
 * Storage key for the member's notification preferences row.
 */
export function makePreferenceKey(customerId, channel) {
  return `pref:${customerId}:${channel}`;
}
