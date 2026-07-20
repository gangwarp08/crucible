import { readDeliveries } from "./ingest/feed.js";
import { validateDelivery, InvalidDeliveryError } from "./ingest/validate.js";
import { createDedupeStore } from "./dispatch/store.js";
import { dispatchDelivery } from "./dispatch/dispatcher.js";
import { initLog } from "./lib/log.js";

const FEED_PATH = process.argv[2] ?? "data/events.jsonl";

async function main() {
  initLog("data/send.log");
  const deliveries = readDeliveries(FEED_PATH);

  const store = createDedupeStore();
  let sent = 0;
  let deduped = 0;
  let invalid = 0;

  for (const raw of deliveries) {
    let delivery;
    try {
      delivery = validateDelivery(raw);
    } catch (err) {
      if (err instanceof InvalidDeliveryError) {
        invalid += 1;
        continue;
      }
      throw err;
    }
    const outcome = await dispatchDelivery(delivery, store);
    if (outcome === "sent") sent += 1;
    else deduped += 1;
  }

  console.log(
    `vantage-notify: deliveries=${deliveries.length} sent=${sent} deduped=${deduped} invalid=${invalid}`,
  );
}

main().catch((err) => {
  console.error("vantage-notify: fatal:", err);
  process.exit(1);
});
