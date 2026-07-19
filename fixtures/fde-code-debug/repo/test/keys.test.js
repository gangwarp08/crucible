import { test } from "node:test";
import assert from "node:assert/strict";
import { makeIdempotencyKey, makePreferenceKey } from "../src/lib/keys.js";

function delivery(overrides = {}) {
  return {
    delivery_id: "dlv_001",
    attempt: 1,
    delivered_at: "2026-07-15T03:31:02Z",
    event: {
      id: "evt_001",
      type: "payment_succeeded",
      customer_id: "cus_001",
      occurred_at: "2026-07-15T01:12:44Z",
      data: { amount_cents: 4900 },
    },
    ...overrides,
  };
}

test("key is stable for the same delivery", () => {
  const d = delivery();
  assert.equal(makeIdempotencyKey(d), makeIdempotencyKey(d));
});

test("different events produce different keys", () => {
  const a = delivery();
  const b = delivery({
    delivery_id: "dlv_002",
    event: { ...delivery().event, id: "evt_002", type: "payment_failed" },
  });
  assert.notEqual(makeIdempotencyKey(a), makeIdempotencyKey(b));
});

test("key includes the customer", () => {
  const d = delivery();
  assert.ok(makeIdempotencyKey(d).includes("cus_001"));
});

test("preference key shape", () => {
  assert.equal(makePreferenceKey("cus_9", "sms"), "pref:cus_9:sms");
});
