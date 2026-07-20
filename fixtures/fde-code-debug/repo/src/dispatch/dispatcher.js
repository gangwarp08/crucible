import { makeIdempotencyKey } from "../lib/keys.js";
import { renderNotification } from "./templates.js";
import { sendNotification } from "../send/sender.js";

/**
 * Dispatch one validated delivery: dedupe, render, send.
 * Returns "sent" or "deduped" so the CLI can report totals.
 */
export async function dispatchDelivery(delivery, store) {
  const key = makeIdempotencyKey(delivery);
  if (store.has(key)) {
    return "deduped";
  }
  const notification = renderNotification(delivery.event);
  await sendNotification(notification, delivery);
  store.add(key);
  return "sent";
}
