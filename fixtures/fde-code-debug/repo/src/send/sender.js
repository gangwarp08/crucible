import { appendJsonl } from "../lib/jsonl.js";
import { logLine } from "../lib/log.js";
import { withRetry } from "./retry.js";
import { now, isoSeconds } from "../lib/clock.js";

/**
 * "Send" a notification: append it to the outbox the downstream SMS/email
 * relay tails. The append is the commit point — one outbox line is one
 * message a member receives.
 */
export async function sendNotification(notification, delivery) {
  await withRetry(
    async () => {
      appendJsonl("data/outbox.jsonl", {
        sent_at: isoSeconds(now()),
        customer_id: notification.customer_id,
        event_id: notification.event_id,
        event_type: notification.event_type,
        delivery_id: delivery.delivery_id,
        body: notification.body,
      });
    },
    {
      onAttempt: (attempt, outcome) =>
        logLine({
          status: outcome === "ok" ? "sent" : "send_error",
          delivery: delivery.delivery_id,
          event: delivery.event.id,
          customer: delivery.event.customer_id,
          attempt,
        }),
    },
  );
}
