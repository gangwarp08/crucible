import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDelivery, InvalidDeliveryError } from "../src/ingest/validate.js";

const GOOD = {
  delivery_id: "dlv_100",
  attempt: 1,
  delivered_at: "2026-07-15T03:31:02Z",
  event: {
    id: "evt_100",
    type: "plan_renewed",
    customer_id: "cus_42",
    occurred_at: "2026-07-15T01:00:00Z",
    data: { plan: "Pro" },
  },
};

test("accepts a well-formed delivery", () => {
  assert.equal(validateDelivery(GOOD), GOOD);
});

test("rejects a missing delivery_id", () => {
  const bad = { ...GOOD, delivery_id: undefined };
  assert.throws(() => validateDelivery(bad), InvalidDeliveryError);
});

test("rejects an unknown event type", () => {
  const bad = { ...GOOD, event: { ...GOOD.event, type: "gift_card_issued" } };
  assert.throws(() => validateDelivery(bad), InvalidDeliveryError);
});

test("rejects a bad attempt counter", () => {
  const bad = { ...GOOD, attempt: 0 };
  assert.throws(() => validateDelivery(bad), InvalidDeliveryError);
});
