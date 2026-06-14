// Daily LiteLLM cost rollup. Reads the previous UTC day's cost_ledger,
// sums spend, prints a one-screen rollup, and exits with status 1 if
// spend is at or above THRESHOLD_USD. Wired to a GitHub Actions daily
// cron — a non-zero exit triggers the workflow's failure email so you
// get a native alert without paying for any external service.
//
// Run locally:
//   pnpm --filter @crucible/server exec tsx scripts/check-daily-cost.ts
// With an override threshold:
//   COST_ALERT_THRESHOLD_USD=20 pnpm --filter @crucible/server exec tsx scripts/check-daily-cost.ts
// Targeting a specific UTC day (default = yesterday):
//   COST_DAY=2026-06-13 pnpm --filter @crucible/server exec tsx scripts/check-daily-cost.ts

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF
    ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`
    : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2); // distinct from threshold-exceeded (1)
}

const THRESHOLD_USD = Number(process.env.COST_ALERT_THRESHOLD_USD ?? "10");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

/** Returns YYYY-MM-DD for the target UTC day. Defaults to yesterday so a
 *  09:00 UTC cron looks at a complete previous day, not a partial today. */
function targetDay(): string {
  const override = process.env.COST_DAY;
  if (override) return override;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const day = targetDay();
  const startIso = `${day}T00:00:00.000Z`;
  const endIso = `${day}T23:59:59.999Z`;

  console.log(`[cost-alert] UTC day = ${day}`);
  console.log(`[cost-alert] threshold = $${THRESHOLD_USD.toFixed(2)}`);

  // Pull cost_ledger rows for the window. supabase-js caps select() at 1000
  // rows by default — range() bumps to 100k, plenty for a single day even
  // under heavy traffic.
  const { data, error } = await supabase
    .from("cost_ledger")
    .select("session_id, cost_usd, model, purpose")
    .gte("ts", startIso)
    .lte("ts", endIso)
    .range(0, 99_999);
  if (error) {
    console.error("[cost-alert] cost_ledger fetch failed:", error.message);
    process.exit(2);
  }

  interface Row {
    session_id: string;
    cost_usd: number | string;
    model: string | null;
    purpose: string | null;
  }
  const rows = (data ?? []) as Row[];

  let total = 0;
  const byModel = new Map<string, number>();
  const byPurpose = new Map<string, number>();
  const bySession = new Map<string, number>();
  for (const r of rows) {
    const cost = Number(r.cost_usd ?? 0);
    total += cost;
    const m = r.model ?? "unknown";
    const p = r.purpose ?? "unknown";
    byModel.set(m, (byModel.get(m) ?? 0) + cost);
    byPurpose.set(p, (byPurpose.get(p) ?? 0) + cost);
    bySession.set(r.session_id, (bySession.get(r.session_id) ?? 0) + cost);
  }

  console.log(`[cost-alert] rows: ${rows.length}, sessions: ${bySession.size}`);
  console.log(`[cost-alert] total spend: $${total.toFixed(4)}`);

  if (byModel.size > 0) {
    console.log("[cost-alert] by model:");
    for (const [m, c] of [...byModel.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${m.padEnd(20)} $${c.toFixed(4)}`);
    }
  }
  if (byPurpose.size > 0) {
    console.log("[cost-alert] by purpose:");
    for (const [p, c] of [...byPurpose.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${p.padEnd(20)} $${c.toFixed(4)}`);
    }
  }

  // Top 5 sessions — useful when investigating a spike.
  if (bySession.size > 0) {
    const top = [...bySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log("[cost-alert] top sessions by spend:");
    for (const [sid, c] of top) {
      console.log(`  ${sid}  $${c.toFixed(4)}`);
    }
  }

  if (total >= THRESHOLD_USD) {
    console.error(
      `\n[cost-alert] FAIL — total spend $${total.toFixed(4)} >= threshold $${THRESHOLD_USD.toFixed(2)}`,
    );
    process.exit(1);
  }

  console.log(
    `\n[cost-alert] OK — total spend $${total.toFixed(4)} below threshold $${THRESHOLD_USD.toFixed(2)}`,
  );
  process.exit(0);
})();
