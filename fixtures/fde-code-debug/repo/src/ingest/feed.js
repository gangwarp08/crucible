import { readJsonl } from "../lib/jsonl.js";

/**
 * Read the provider's delivery feed. Each line is one webhook DELIVERY:
 *
 *   {
 *     "delivery_id":  "dlv_...",   // unique per delivery attempt
 *     "attempt":      1,           // gateway redelivery counter
 *     "delivered_at": "...",       // when the gateway handed it to us
 *     "event": {
 *       "id":          "evt_...",  // the billing event itself
 *       "type":        "payment_succeeded" | ...,
 *       "customer_id": "cus_...",
 *       "occurred_at": "...",
 *       "data":        { ... }
 *     }
 *   }
 *
 * The gateway delivers at least once — the same event.id can appear under
 * multiple delivery_ids. Order within the file follows delivered_at.
 */
export function readDeliveries(path) {
  return readJsonl(path);
}
