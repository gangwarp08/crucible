const EVENT_TYPES = new Set([
  "payment_succeeded",
  "payment_failed",
  "plan_renewed",
  "plan_canceled",
]);

export class InvalidDeliveryError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "InvalidDeliveryError";
  }
}

/** Shape-check one delivery before it enters the pipeline. Throws on the
 *  first problem — the CLI counts and skips invalid lines. */
export function validateDelivery(delivery) {
  if (!delivery || typeof delivery !== "object") {
    throw new InvalidDeliveryError("delivery is not an object");
  }
  if (typeof delivery.delivery_id !== "string" || !delivery.delivery_id.startsWith("dlv_")) {
    throw new InvalidDeliveryError("missing/bad delivery_id");
  }
  if (!Number.isInteger(delivery.attempt) || delivery.attempt < 1) {
    throw new InvalidDeliveryError("missing/bad attempt");
  }
  const ev = delivery.event;
  if (!ev || typeof ev !== "object") {
    throw new InvalidDeliveryError("missing event");
  }
  if (typeof ev.id !== "string" || !ev.id.startsWith("evt_")) {
    throw new InvalidDeliveryError("missing/bad event.id");
  }
  if (!EVENT_TYPES.has(ev.type)) {
    throw new InvalidDeliveryError(`unknown event type: ${ev.type}`);
  }
  if (typeof ev.customer_id !== "string" || !ev.customer_id.startsWith("cus_")) {
    throw new InvalidDeliveryError("missing/bad customer_id");
  }
  return delivery;
}
