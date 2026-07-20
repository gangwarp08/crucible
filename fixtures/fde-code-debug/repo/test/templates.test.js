import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification } from "../src/dispatch/templates.js";

test("payment_succeeded renders the amount in dollars", () => {
  const n = renderNotification({
    id: "evt_1",
    type: "payment_succeeded",
    customer_id: "cus_1",
    data: { amount_cents: 4900 },
  });
  assert.ok(n.body.includes("$49.00"));
  assert.equal(n.customer_id, "cus_1");
  assert.equal(n.event_id, "evt_1");
});

test("plan_renewed names the plan", () => {
  const n = renderNotification({
    id: "evt_2",
    type: "plan_renewed",
    customer_id: "cus_2",
    data: { plan: "Pro" },
  });
  assert.ok(n.body.includes("Pro"));
});

test("unknown type throws", () => {
  assert.throws(() =>
    renderNotification({ id: "evt_3", type: "mystery", customer_id: "cus_3", data: {} }),
  );
});
