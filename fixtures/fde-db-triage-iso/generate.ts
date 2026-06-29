// Deterministic synthetic dataset generator for the fde-db-triage-iso ISOMORPH.
// Same radical structure as fde-db-triage (webhook-retry duplicate bug, dedup by
// external_payment_id, status filter, refund + UTC red herrings, 3-month window)
// but a DIFFERENT seed → different incidental values (amounts, which rows are
// duplicated, corrected figures). Used by verify-isomorph-equivalence.ts.
//
// Per docs/scenarios/crucible_scenario_fde-db-triage.md §3:
//   customers (~400) / subscriptions (~500) / payments (~5000 over 12 months)
// with a webhook-retry bug duplicating ~8% of succeeded payments in the last
// 2 months (Apr + May 2026), plus a normal volume of refunds (red herring 1)
// and a handful of UTC timestamps near month boundaries (red herring 2).
//
// Run: pnpm exec tsx fixtures/fde-db-triage/generate.ts
//
// Writes (overwrites) into this directory:
//   schema.sql        — portable subset, runs in Postgres and sqlite3
//   seed.sql          — INSERT statements, sorted by primary key, byte-identical on re-run
//   ground_truth.json — naive vs corrected monthly revenue + overstatement
//   queries.sql       — the sample SQL the verifier executes against schema+seed
//
// All randomness flows through a single mulberry32 PRNG seeded from a FNV-1a
// hash of "fde-db-triage-v1" — re-running yields byte-identical output. Date
// arithmetic uses a fixed REFERENCE_DATE (no `new Date()`), so the file does
// not drift with the wall clock.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Determinism primitives ─────────────────────────────────────────────────

const SEED_LABEL = "fde-db-triage-iso-v1";
const REFERENCE_DATE = "2026-05-31T23:59:59Z"; // end of May 2026 — last 12 months = Jun 2025 → May 2026
const REPORTING_WINDOW = ["2026-03", "2026-04", "2026-05"]; // three complete months
const BUG_MONTHS = ["2026-04", "2026-05"]; // duplicate injection window

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(fnv1a(SEED_LABEL));

function rngInt(min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

function rngPick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function rngWeighted<T>(items: readonly { v: T; w: number }[]): T {
  const total = items.reduce((a, b) => a + b.w, 0);
  let r = rng() * total;
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it.v;
  }
  return items[items.length - 1]!.v;
}

function rngHex(nChars: number): string {
  let out = "";
  while (out.length < nChars) {
    out += Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  }
  return out.slice(0, nChars);
}

// ─── Domain helpers ─────────────────────────────────────────────────────────

const REF_MS = Date.parse(REFERENCE_DATE);
const ONE_DAY = 86_400_000;

function isoMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function fmtUtc(d: Date): string {
  // YYYY-MM-DD HH:MM:SS — portable across Postgres and SQLite as TEXT
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

function sqlStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

// ─── First names + company suffixes (synthetic; no real PII) ────────────────

const FIRST_NAMES = [
  "Avery", "Blake", "Casey", "Drew", "Emery", "Finley", "Gray", "Harper",
  "Indigo", "Jules", "Kai", "Lane", "Morgan", "Nova", "Oakley", "Parker",
  "Quinn", "Reese", "Sage", "Taylor", "Umi", "Vale", "Wren", "Xan",
  "Yael", "Zion", "Ash", "Bay", "Cove", "Dune",
];

const LAST_NAMES = [
  "Holdings", "Labs", "Systems", "Works", "Industries", "Collective",
  "Studios", "Group", "Partners", "Co", "Foundry", "Forge", "Logic",
  "Metrics", "Networks", "Dynamics", "Cloud", "Signals", "Outpost", "Atlas",
];

function fakeCompanyName(): string {
  return `${rngPick(FIRST_NAMES)} ${rngPick(LAST_NAMES)}`;
}

// ─── Plan catalog ───────────────────────────────────────────────────────────

const PLANS = [
  { plan: "starter",    mrr_cents:    50_000, weight: 0.45 },
  { plan: "pro",        mrr_cents:   200_000, weight: 0.30 },
  { plan: "scale",      mrr_cents:   800_000, weight: 0.18 },
  { plan: "enterprise", mrr_cents: 2_500_000, weight: 0.07 },
] as const;

const PLAN_DISTRIBUTION = PLANS.map((p) => ({ v: p, w: p.weight }));

const SUBSCRIPTION_STATUSES = ["active", "active", "active", "active", "churned", "paused"];
const CUSTOMER_PLAN_AT_SIGNUP_NOTE = "snapshot plan at signup — actual billing plan lives on subscriptions";

// ─── Row types ──────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  name: string;
  plan: string;
  created_at: string;
}

interface Subscription {
  id: string;
  customer_id: string;
  plan: string;
  mrr_cents: number;
  started_at: string;
  status: string;
}

interface Payment {
  id: string;
  external_payment_id: string;
  subscription_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  created_at: string;
  created_at_ms: number;
  month_bucket: string;
}

// ─── Generation ─────────────────────────────────────────────────────────────

function generateCustomers(n: number): Customer[] {
  const rows: Customer[] = [];
  // Spread signups across the trailing ~3 years so subscriptions have a
  // realistic backdrop of older customers to draw from.
  for (let i = 0; i < n; i++) {
    const ageDays = rngInt(30, 1100);
    const created = new Date(REF_MS - ageDays * ONE_DAY - rngInt(0, ONE_DAY - 1));
    const plan = rngWeighted(PLAN_DISTRIBUTION).plan;
    rows.push({
      id: `cus_${String(i + 1).padStart(4, "0")}`,
      name: fakeCompanyName(),
      plan,
      created_at: fmtUtc(created),
    });
  }
  return rows;
}

function generateSubscriptions(
  n: number,
  customers: Customer[],
): Subscription[] {
  const rows: Subscription[] = [];
  for (let i = 0; i < n; i++) {
    const cust = customers[i % customers.length]!;
    const plan = rngWeighted(PLAN_DISTRIBUTION);
    // Subscription age distribution chosen so most subs are billing throughout
    // the 12-month reporting window — ~70% started ≥12mo ago, ~20% started
    // 6–12mo ago, ~10% in the trailing 6 months. Aligns with a mature B2B
    // SaaS book of business and gets payments count near the spec's ~5000.
    const ageBucket = rng();
    let ageDaysMin: number, ageDaysMax: number;
    if (ageBucket < 0.70) {
      ageDaysMin = 365;
      ageDaysMax = 900;
    } else if (ageBucket < 0.90) {
      ageDaysMin = 180;
      ageDaysMax = 365;
    } else {
      ageDaysMin = 15;
      ageDaysMax = 180;
    }
    const custMs = Date.parse(cust.created_at + "Z");
    // Can't start before the customer existed; otherwise honour the bucket.
    const desiredMs = REF_MS - rngInt(ageDaysMin, ageDaysMax) * ONE_DAY;
    const startMs = Math.max(custMs + ONE_DAY, desiredMs);
    const status = rngPick(SUBSCRIPTION_STATUSES);
    rows.push({
      id: `sub_${String(i + 1).padStart(4, "0")}`,
      customer_id: cust.id,
      plan: plan.plan,
      mrr_cents: plan.mrr_cents,
      started_at: fmtUtc(new Date(startMs)),
      status,
    });
  }
  return rows;
}

function generateBasePayments(subscriptions: Subscription[]): Payment[] {
  // Walk each subscription month-by-month from its start (clamped to the last
  // 12 months) up to the reference date. Active subs almost always pay;
  // churned/paused subs pay until they stop.
  const earliest = REF_MS - 365 * ONE_DAY;
  const rows: Payment[] = [];
  let counter = 0;

  for (const sub of subscriptions) {
    const startMs = Math.max(Date.parse(sub.started_at + "Z"), earliest);
    // Pick a billing-day of the month for this subscription.
    const billDay = rngInt(1, 28);
    let cursor = new Date(startMs);
    cursor.setUTCDate(billDay);
    if (cursor.getTime() < startMs) cursor.setUTCMonth(cursor.getUTCMonth() + 1);

    while (cursor.getTime() <= REF_MS) {
      // Active churned/paused gates
      if (sub.status === "churned" && rng() < 0.6) break;
      if (sub.status === "paused" && rng() < 0.3) {
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        continue;
      }

      // Status mix: 85% succeeded, 10% refunded, 5% failed (red herring 1: refunds)
      const r = rng();
      const status = r < 0.85 ? "succeeded" : r < 0.95 ? "refunded" : "failed";

      // Amount: mrr ± up to 500 cents of proration jitter (succeeded/refunded);
      // failed amounts are the raw attempt, no jitter.
      const jitter = status === "failed" ? 0 : rngInt(-500, 500);
      const amount_cents = sub.mrr_cents + jitter;

      // Within-day timestamp jitter; red herring 2 candidates handled below.
      const hh = rngInt(0, 23);
      const mm = rngInt(0, 59);
      const ss = rngInt(0, 59);
      const at = new Date(cursor.getTime());
      at.setUTCHours(hh, mm, ss, 0);

      counter += 1;
      rows.push({
        id: `pay_${String(counter).padStart(6, "0")}`,
        external_payment_id: `evt_${rngHex(8)}`,
        subscription_id: sub.id,
        amount_cents,
        currency: "USD",
        status,
        created_at: fmtUtc(at),
        created_at_ms: at.getTime(),
        month_bucket: isoMonth(at),
      });

      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return rows;
}

function injectTimezoneRedHerring(payments: Payment[]): void {
  // Red herring 2: a handful of succeeded payments per month land within
  // 30 minutes of the UTC month boundary, so binning by local time would
  // mis-bucket them. Small relative to revenue — distractor only.
  const succeededByMonth = new Map<string, Payment[]>();
  for (const p of payments) {
    if (p.status !== "succeeded") continue;
    const arr = succeededByMonth.get(p.month_bucket);
    if (arr) arr.push(p);
    else succeededByMonth.set(p.month_bucket, [p]);
  }
  for (const [month, ps] of succeededByMonth) {
    const target = 6;
    const picks = new Set<number>();
    while (picks.size < Math.min(target, ps.length)) {
      picks.add(rngInt(0, ps.length - 1));
    }
    let toggle = 0;
    for (const idx of picks) {
      const p = ps[idx]!;
      const d = new Date(p.created_at_ms);
      // Half: last-30-min of month boundary; half: first-30-min of next month.
      const lastDayMs = (() => {
        const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
        return next.getTime() - ONE_DAY;
      })();
      let placed: number;
      if (toggle++ % 2 === 0) {
        // Last 30 min of month (in UTC).
        const day = new Date(lastDayMs);
        day.setUTCHours(23, rngInt(30, 59), rngInt(0, 59), 0);
        placed = day.getTime();
      } else {
        // First 30 min of next month (in UTC).
        const nextStart = lastDayMs + ONE_DAY;
        const day = new Date(nextStart);
        day.setUTCHours(0, rngInt(0, 29), rngInt(0, 59), 0);
        placed = day.getTime();
      }
      p.created_at_ms = placed;
      p.created_at = fmtUtc(new Date(placed));
      p.month_bucket = isoMonth(new Date(placed));
    }
  }
}

function injectDuplicates(payments: Payment[]): Payment[] {
  // Root cause: in BUG_MONTHS, ~8% of succeeded payments were double-inserted
  // by a webhook-retry bug. Duplicates share external_payment_id +
  // amount_cents + subscription_id; differ by id and a few seconds of
  // created_at. Sort the source rows by id for stable sampling so the choice
  // is fully deterministic.
  const succeededInBugMonths = payments
    .filter((p) => p.status === "succeeded" && BUG_MONTHS.includes(p.month_bucket))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Per-month count.
  const perMonth = new Map<string, Payment[]>();
  for (const p of succeededInBugMonths) {
    const arr = perMonth.get(p.month_bucket);
    if (arr) arr.push(p);
    else perMonth.set(p.month_bucket, [p]);
  }

  const dups: Payment[] = [];
  // Use a counter that continues from the highest existing pay_ id.
  let counter = payments.length;

  for (const [month, ps] of perMonth) {
    const target = Math.max(2, Math.floor(0.08 * ps.length));
    // Deterministic spaced selection so we don't bunch the dupes at the head.
    const stride = Math.max(1, Math.floor(ps.length / target));
    const picks: Payment[] = [];
    for (let k = 0; k < target; k++) {
      picks.push(ps[(k * stride) % ps.length]!);
    }
    for (const orig of picks) {
      counter += 1;
      const offsetSec = rngInt(2, 12);
      const at = new Date(orig.created_at_ms + offsetSec * 1000);
      dups.push({
        id: `pay_${String(counter).padStart(6, "0")}`,
        external_payment_id: orig.external_payment_id,
        subscription_id: orig.subscription_id,
        amount_cents: orig.amount_cents,
        currency: orig.currency,
        status: orig.status,
        created_at: fmtUtc(at),
        created_at_ms: at.getTime(),
        month_bucket: isoMonth(at),
      });
    }
    // Reflect in dataset metadata; logged below.
    void month;
  }
  return dups;
}

// ─── Ground truth ───────────────────────────────────────────────────────────

interface GroundTruth {
  reference_date: string;
  reporting_window: string[];
  bug_months: string[];
  naive_monthly_cents: Record<string, number>;
  corrected_monthly_cents: Record<string, number>;
  overstatement_cents: number;
  overstatement_by_month_cents: Record<string, number>;
  duplicate_count_by_month: Record<string, number>;
  succeeded_count_by_month: Record<string, number>;
  totals: {
    payments: number;
    customers: number;
    subscriptions: number;
    base_payments: number;
    duplicate_payments: number;
  };
  // Plain-English root-cause narrative, used by the Analysis Agent's judge
  // prompt to grade root-cause + dedup-method evidence in the deliverable.
  // Synthetic with the rest of the fixture; bug-spoiler — keep on the server.
  root_cause_narrative: string;
}

const ROOT_CAUSE_NARRATIVE =
  "In the bug months (Apr + May 2026) a webhook-retry bug double-inserted " +
  "~8% of succeeded payments. Duplicates share external_payment_id + " +
  "amount_cents + subscription_id and differ only by id and a few seconds " +
  "of created_at. The correct method is to dedup by external_payment_id " +
  "(e.g. SELECT MIN(id) per external_payment_id, JOIN back) before SUMing " +
  "amount_cents — filtering to status = 'succeeded'. Refunds (~10% of all " +
  "payments, normally distributed) and UTC month-boundary timestamps are " +
  "red herrings and do not close the gap.";

function computeGroundTruth(
  payments: Payment[],
  basePayments: Payment[],
  duplicatePayments: Payment[],
  customers: Customer[],
  subscriptions: Subscription[],
): GroundTruth {
  const naive: Record<string, number> = {};
  const corrected: Record<string, number> = {};
  const succeededCountByMonth: Record<string, number> = {};
  const dupCountByMonth: Record<string, number> = {};

  for (const month of REPORTING_WINDOW) {
    naive[month] = 0;
    corrected[month] = 0;
    succeededCountByMonth[month] = 0;
  }

  // Naive: SUM(amount_cents) WHERE status='succeeded' — no dedup, includes dups.
  for (const p of payments) {
    if (p.status !== "succeeded") continue;
    if (!REPORTING_WINDOW.includes(p.month_bucket)) continue;
    naive[p.month_bucket]! += p.amount_cents;
    succeededCountByMonth[p.month_bucket] = (succeededCountByMonth[p.month_bucket] ?? 0) + 1;
  }

  // Corrected: dedup by external_payment_id (keep one row per epid) and
  // filter to succeeded only.
  const seenEpid = new Set<string>();
  // Iterate sorted by id so the "kept" row is the earliest insertion — matches
  // the candidate's likely SQL (MIN(id) GROUP BY external_payment_id).
  const sortedSucc = payments
    .filter((p) => p.status === "succeeded")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of sortedSucc) {
    if (seenEpid.has(p.external_payment_id)) continue;
    seenEpid.add(p.external_payment_id);
    if (!REPORTING_WINDOW.includes(p.month_bucket)) continue;
    corrected[p.month_bucket]! += p.amount_cents;
  }

  // Duplicate count per month.
  for (const m of BUG_MONTHS) dupCountByMonth[m] = 0;
  for (const d of duplicatePayments) {
    if (REPORTING_WINDOW.includes(d.month_bucket)) {
      dupCountByMonth[d.month_bucket] = (dupCountByMonth[d.month_bucket] ?? 0) + 1;
    }
  }

  const overstatementByMonth: Record<string, number> = {};
  let overstatement = 0;
  for (const m of REPORTING_WINDOW) {
    const diff = naive[m]! - corrected[m]!;
    overstatementByMonth[m] = diff;
    overstatement += diff;
  }

  return {
    reference_date: REFERENCE_DATE,
    reporting_window: REPORTING_WINDOW,
    bug_months: BUG_MONTHS,
    naive_monthly_cents: naive,
    corrected_monthly_cents: corrected,
    overstatement_cents: overstatement,
    overstatement_by_month_cents: overstatementByMonth,
    duplicate_count_by_month: dupCountByMonth,
    succeeded_count_by_month: succeededCountByMonth,
    totals: {
      payments: payments.length,
      customers: customers.length,
      subscriptions: subscriptions.length,
      base_payments: basePayments.length,
      duplicate_payments: duplicatePayments.length,
    },
    root_cause_narrative: ROOT_CAUSE_NARRATIVE,
  };
}

// ─── Serializers ────────────────────────────────────────────────────────────

const SCHEMA_SQL = `-- fde-db-triage-iso synthetic schema (GENERATED — do not edit by hand)
-- Portable subset that runs in both Postgres (\\i schema.sql) and SQLite (.read schema.sql).
-- Regenerate via:  pnpm exec tsx fixtures/fde-db-triage-iso/generate.ts

DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS customers;

CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  plan         TEXT NOT NULL,
  mrr          INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  status       TEXT NOT NULL
);

CREATE TABLE payments (
  id                   TEXT PRIMARY KEY,
  external_payment_id  TEXT NOT NULL,
  subscription_id      TEXT NOT NULL,
  amount_cents         INTEGER NOT NULL,
  currency             TEXT NOT NULL,
  status               TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE INDEX payments_external_payment_id ON payments (external_payment_id);
CREATE INDEX payments_created_at          ON payments (created_at);
CREATE INDEX payments_status              ON payments (status);
`;

const QUERIES_SQL = `-- Sample queries used by verify-fde-db-triage.ts (GENERATED — do not edit by hand).
-- Demonstrates the discriminator: naive SUM vs deduped SUM, grouped by month.
-- Output columns are: tag | month | cents.

-- Naive monthly succeeded revenue (what the dashboard shows — includes duplicates).
SELECT 'naive' AS tag, substr(created_at, 1, 7) AS month, SUM(amount_cents) AS cents
FROM payments
WHERE status = 'succeeded'
  AND substr(created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
GROUP BY substr(created_at, 1, 7)
ORDER BY month;

-- Corrected monthly succeeded revenue: dedup by external_payment_id (keep MIN id),
-- then filter to succeeded only.
WITH dedup AS (
  SELECT MIN(id) AS keep_id
  FROM payments
  WHERE status = 'succeeded'
  GROUP BY external_payment_id
)
SELECT 'corrected' AS tag, substr(p.created_at, 1, 7) AS month, SUM(p.amount_cents) AS cents
FROM payments p
JOIN dedup d ON d.keep_id = p.id
WHERE substr(p.created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
GROUP BY substr(p.created_at, 1, 7)
ORDER BY month;

-- Proof: external_payment_ids that appear more than once (the bug fingerprint).
-- These are confined to the bug months (Apr + May 2026).
SELECT 'duplicates' AS tag, external_payment_id, COUNT(*) AS n
FROM payments
WHERE status = 'succeeded'
GROUP BY external_payment_id
HAVING COUNT(*) > 1
ORDER BY external_payment_id
LIMIT 10;
`;

function serializeSeed(
  customers: Customer[],
  subscriptions: Subscription[],
  payments: Payment[],
): string {
  const parts: string[] = [];
  parts.push("-- fde-db-triage-iso synthetic seed (GENERATED — do not edit by hand)");
  parts.push("-- Regenerate via: pnpm exec tsx fixtures/fde-db-triage-iso/generate.ts");
  parts.push("BEGIN;");
  parts.push("");

  parts.push("-- customers");
  for (const c of customers) {
    parts.push(
      `INSERT INTO customers (id, name, plan, created_at) VALUES (` +
        `${sqlStr(c.id)}, ${sqlStr(c.name)}, ${sqlStr(c.plan)}, ${sqlStr(c.created_at)});`,
    );
  }
  parts.push("");

  parts.push("-- subscriptions");
  for (const s of subscriptions) {
    parts.push(
      `INSERT INTO subscriptions (id, customer_id, plan, mrr, started_at, status) VALUES (` +
        `${sqlStr(s.id)}, ${sqlStr(s.customer_id)}, ${sqlStr(s.plan)}, ${s.mrr_cents}, ` +
        `${sqlStr(s.started_at)}, ${sqlStr(s.status)});`,
    );
  }
  parts.push("");

  parts.push("-- payments");
  for (const p of payments) {
    parts.push(
      `INSERT INTO payments (id, external_payment_id, subscription_id, amount_cents, currency, status, created_at) VALUES (` +
        `${sqlStr(p.id)}, ${sqlStr(p.external_payment_id)}, ${sqlStr(p.subscription_id)}, ` +
        `${p.amount_cents}, ${sqlStr(p.currency)}, ${sqlStr(p.status)}, ${sqlStr(p.created_at)});`,
    );
  }
  parts.push("");
  parts.push("COMMIT;");
  parts.push("");
  return parts.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  void CUSTOMER_PLAN_AT_SIGNUP_NOTE;
  const customers = generateCustomers(400);
  const subscriptions = generateSubscriptions(500, customers);
  const basePayments = generateBasePayments(subscriptions);
  injectTimezoneRedHerring(basePayments);
  const dups = injectDuplicates(basePayments);
  const allPayments = [...basePayments, ...dups].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const ground = computeGroundTruth(
    allPayments,
    basePayments,
    dups,
    customers,
    subscriptions,
  );

  const here = dirname(fileURLToPath(import.meta.url));
  mkdirSync(here, { recursive: true });

  writeFileSync(resolve(here, "schema.sql"), SCHEMA_SQL);
  writeFileSync(resolve(here, "queries.sql"), QUERIES_SQL);
  writeFileSync(resolve(here, "seed.sql"), serializeSeed(customers, subscriptions, allPayments));
  writeFileSync(
    resolve(here, "ground_truth.json"),
    JSON.stringify(ground, null, 2) + "\n",
  );

  // Summary to stdout (not part of any committed file; just for the operator).
  console.log("[fde-db-triage-iso] generator complete");
  console.log("  customers:           ", customers.length);
  console.log("  subscriptions:       ", subscriptions.length);
  console.log("  base payments:       ", basePayments.length);
  console.log("  duplicate payments:  ", dups.length);
  console.log("  total payments:      ", allPayments.length);
  console.log("  reference_date:      ", ground.reference_date);
  console.log("  reporting_window:    ", ground.reporting_window.join(", "));
  console.log("  bug_months:          ", ground.bug_months.join(", "));
  console.log();
  console.log("  naive monthly (cents):    ", ground.naive_monthly_cents);
  console.log("  corrected monthly (cents):", ground.corrected_monthly_cents);
  console.log("  overstatement (cents):    ", ground.overstatement_cents);
  console.log("  dupes per month:          ", ground.duplicate_count_by_month);
}

main();
