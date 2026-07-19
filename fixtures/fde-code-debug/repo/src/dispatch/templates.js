const TEMPLATES = {
  payment_succeeded: (ev) =>
    `Hi! Your Vantage Fitness payment of $${centsToDollars(ev.data.amount_cents)} went through. See you at the gym!`,
  payment_failed: (ev) =>
    `Heads up — your Vantage Fitness payment of $${centsToDollars(ev.data.amount_cents)} didn't go through. Please update your card to keep your membership active.`,
  plan_renewed: (ev) =>
    `Your Vantage Fitness ${ev.data.plan} membership has renewed. Thanks for staying with us!`,
  plan_canceled: (ev) =>
    `Your Vantage Fitness membership has been canceled. You have access until the end of the billing period.`,
};

function centsToDollars(cents) {
  return (cents / 100).toFixed(2);
}

export function renderNotification(event) {
  const render = TEMPLATES[event.type];
  if (!render) {
    throw new Error(`no template for event type: ${event.type}`);
  }
  return {
    customer_id: event.customer_id,
    event_id: event.id,
    event_type: event.type,
    body: render(event),
  };
}
