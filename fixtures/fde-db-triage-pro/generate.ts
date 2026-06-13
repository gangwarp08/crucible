// Deterministic synthetic dataset generator for the fde-db-triage-pro
// scenario (Tier 1.5). Forks fixtures/fde-db-triage with three findable
// issues of differing business impact:
//
//   Issue 1 — Revenue double-count (HIGH).
//     Identical to the base scenario: a webhook-retry bug duplicated ~8% of
//     succeeded payments in BUG_MONTHS (Apr+May 2026). Discriminator: dedup
//     by external_payment_id.
//
//   Issue 2 — Churn miscount (HIGH).
//     Subscription statuses are split deterministically into three groups —
//     active, churned, and paused — and the seed file labels them. A naive
//     churn query lumps `paused` in with `churned`; the true churn rate is
//     only `churned`. The gap is large enough to materially mis-state
//     retention. Paused subs keep paying recently (~70% of months), so they
//     are clearly NOT zombie/abandoned subs — they're an explicit third
//     state the naive query misclassifies. Discriminator: GROUP BY status
//     and inspect the three counts.
//
//   Issue 3 — Cosmetic count inflation (LOW).
//     30 internal/test customers are appended to the customers table with
//     distinctive names (`Internal Sandbox NN`, `Test_Acct_NNN`), plan
//     'internal', and NO subscriptions and NO payments. They inflate
//     COUNT(*) on customers from 400 → 430 but have $0 financial impact.
//     This is the trap the teammate (Sam) pushes as "what leadership cares
//     about." Discriminator: name LIKE 'Test_%' OR LIKE 'Internal Sandbox%'.
//
// Run: pnpm exec tsx fixtures/fde-db-triage-pro/generate.ts
//
// Writes (overwrites) into this directory:
//   schema.sql        — portable subset; runs in Postgres and sqlite3
//   seed.sql          — INSERT statements sorted by primary key, byte-
//                       identical on re-run
//   ground_truth.json — issues + impacts + HIGH/HIGH/LOW ranking
//   queries.sql       — SQL proofs of all three issues
//
// All randomness flows through a single mulberry32 PRNG seeded from a FNV-1a
// hash of "fde-db-triage-pro-v1" — re-running yields byte-identical output.
// Date arithmetic uses a fixed REFERENCE_DATE.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Determinism primitives ─────────────────────────────────────────────────

const SEED_LABEL = "fde-db-triage-pro-v1";
const REFERENCE_DATE = "2026-05-31T23:59:59Z";
const REPORTING_WINDOW = ["2026-03", "2026-04", "2026-05"];
const BUG_MONTHS = ["2026-04", "2026-05"];

// Deterministic subscription-status mix. 500 total = 310 active + 80 churned
// + 110 paused. Naive churn = (churned + paused) / total = 38%. True churn =
// churned / total = 16%. Delta = 22 pp, 110 misclassified.
const N_ACTIVE_SUBS = 310;
const N_CHURNED_SUBS = 80;
const N_PAUSED_SUBS = 110;
const N_TOTAL_SUBS = N_ACTIVE_SUBS + N_CHURNED_SUBS + N_PAUSED_SUBS;

const N_REAL_CUSTOMERS = 400;
const N_TEST_CUSTOMERS = 30;

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

/** Fisher-Yates shuffle using the seeded RNG — deterministic given the
 *  same RNG state. Mutates the input array. */
function rngShuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// ─── Domain helpers ─────────────────────────────────────────────────────────

const REF_MS = Date.parse(REFERENCE_DATE);
const ONE_DAY = 86_400_000;

function isoMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function fmtUtc(d: Date): string {
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

// ─── Row types ──────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  name: string;
  plan: string;
  created_at: string;
  is_test: boolean;
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

function generateRealCustomers(n: number): Customer[] {
  const rows: Customer[] = [];
  for (let i = 0; i < n; i++) {
    const ageDays = rngInt(30, 1100);
    const created = new Date(REF_MS - ageDays * ONE_DAY - rngInt(0, ONE_DAY - 1));
    const plan = rngWeighted(PLAN_DISTRIBUTION).plan;
    rows.push({
      id: `cus_${String(i + 1).padStart(4, "0")}`,
      name: fakeCompanyName(),
      plan,
      created_at: fmtUtc(created),
      is_test: false,
    });
  }
  return rows;
}

/** Internal/test customers. Distinctive names (`Internal Sandbox NN`,
 *  `Test_Acct_NNN`), plan="internal". Sorted after real customers by id so
 *  they appear at the tail of the customers table. No subscriptions and
 *  no payments — only inflate COUNT(*) on customers. */
function generateTestCustomers(n: number, startIndex: number): Customer[] {
  const rows: Customer[] = [];
  // First 20 are "Internal Sandbox NN", next 10 are "Test_Acct_NNN".
  const nSandbox = 20;
  const nTestAcct = n - nSandbox;
  for (let i = 0; i < nSandbox; i++) {
    const ageDays = rngInt(15, 800);
    const created = new Date(REF_MS - ageDays * ONE_DAY - rngInt(0, ONE_DAY - 1));
    rows.push({
      id: `cus_${String(startIndex + i + 1).padStart(4, "0")}`,
      name: `Internal Sandbox ${String(i + 1).padStart(2, "0")}`,
      plan: "internal",
      created_at: fmtUtc(created),
      is_test: true,
    });
  }
  for (let i = 0; i < nTestAcct; i++) {
    const ageDays = rngInt(15, 800);
    const created = new Date(REF_MS - ageDays * ONE_DAY - rngInt(0, ONE_DAY - 1));
    rows.push({
      id: `cus_${String(startIndex + nSandbox + i + 1).padStart(4, "0")}`,
      name: `Test_Acct_${String(i + 1).padStart(3, "0")}`,
      plan: "internal",
      created_at: fmtUtc(created),
      is_test: true,
    });
  }
  return rows;
}

function generateSubscriptions(
  n: number,
  realCustomers: Customer[],
): Subscription[] {
  // Build a deterministic status array of exactly N_ACTIVE + N_CHURNED +
  // N_PAUSED entries, then shuffle with the seeded RNG so the assignment
  // is random-looking but reproducible.
  const statusPool: string[] = [
    ...Array(N_ACTIVE_SUBS).fill("active"),
    ...Array(N_CHURNED_SUBS).fill("churned"),
    ...Array(N_PAUSED_SUBS).fill("paused"),
  ];
  if (statusPool.length !== n) {
    throw new Error(
      `[gen] status pool size (${statusPool.length}) ≠ requested subscription count (${n})`,
    );
  }
  rngShuffle(statusPool);

  const rows: Subscription[] = [];
  for (let i = 0; i < n; i++) {
    const cust = realCustomers[i % realCustomers.length]!;
    const plan = rngWeighted(PLAN_DISTRIBUTION);
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
    const desiredMs = REF_MS - rngInt(ageDaysMin, ageDaysMax) * ONE_DAY;
    const startMs = Math.max(custMs + ONE_DAY, desiredMs);
    rows.push({
      id: `sub_${String(i + 1).padStart(4, "0")}`,
      customer_id: cust.id,
      plan: plan.plan,
      mrr_cents: plan.mrr_cents,
      started_at: fmtUtc(new Date(startMs)),
      status: statusPool[i]!,
    });
  }
  return rows;
}

function generateBasePayments(subscriptions: Subscription[]): Payment[] {
  const earliest = REF_MS - 365 * ONE_DAY;
  const rows: Payment[] = [];
  let counter = 0;

  for (const sub of subscriptions) {
    const startMs = Math.max(Date.parse(sub.started_at + "Z"), earliest);
    const billDay = rngInt(1, 28);
    let cursor = new Date(startMs);
    cursor.setUTCDate(billDay);
    if (cursor.getTime() < startMs) cursor.setUTCMonth(cursor.getUTCMonth() + 1);

    while (cursor.getTime() <= REF_MS) {
      // Status gates: churned subs stop paying after a few months; paused
      // subs skip 30% of months but keep paying recently — so candidates
      // see paused subs as ALIVE, not zombie.
      if (sub.status === "churned" && rng() < 0.6) break;
      if (sub.status === "paused" && rng() < 0.3) {
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        continue;
      }

      // Status mix: 85% succeeded, 10% refunded, 5% failed.
      const r = rng();
      const status = r < 0.85 ? "succeeded" : r < 0.95 ? "refunded" : "failed";

      const jitter = status === "failed" ? 0 : rngInt(-500, 500);
      const amount_cents = sub.mrr_cents + jitter;

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
  // Same red herring as the base scenario: a handful of succeeded payments
  // per month land within 30 minutes of the UTC month boundary.
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
      const lastDayMs = (() => {
        const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
        return next.getTime() - ONE_DAY;
      })();
      let placed: number;
      if (toggle++ % 2 === 0) {
        const day = new Date(lastDayMs);
        day.setUTCHours(23, rngInt(30, 59), rngInt(0, 59), 0);
        placed = day.getTime();
      } else {
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
  // Identical to the base scenario: in BUG_MONTHS, ~8% of succeeded payments
  // are double-inserted (same external_payment_id + amount + sub; +2-12s
  // offset).
  const succeededInBugMonths = payments
    .filter((p) => p.status === "succeeded" && BUG_MONTHS.includes(p.month_bucket))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const perMonth = new Map<string, Payment[]>();
  for (const p of succeededInBugMonths) {
    const arr = perMonth.get(p.month_bucket);
    if (arr) arr.push(p);
    else perMonth.set(p.month_bucket, [p]);
  }

  const dups: Payment[] = [];
  let counter = payments.length;

  for (const [month, ps] of perMonth) {
    const target = Math.max(2, Math.floor(0.08 * ps.length));
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
    void month;
  }
  return dups;
}

// ─── Ground truth ───────────────────────────────────────────────────────────

interface IssueRevenue {
  id: "revenue_double_count";
  impact: "HIGH";
  naive_monthly_cents: Record<string, number>;
  corrected_monthly_cents: Record<string, number>;
  overstatement_cents: number;
  overstatement_by_month_cents: Record<string, number>;
  duplicate_count_by_month: Record<string, number>;
  succeeded_count_by_month: Record<string, number>;
  discriminator: string;
}

interface IssueChurn {
  id: "churn_paused_miscount";
  impact: "HIGH";
  total_subscriptions: number;
  active_count: number;
  churned_count: number;
  paused_count: number;
  naive_churn_rate: number;
  true_churn_rate: number;
  delta_pp: number;
  misclassified_subscription_count: number;
  discriminator: string;
}

interface IssueCosmetic {
  id: "cosmetic_count_inflation";
  impact: "LOW";
  total_customers: number;
  real_customer_count: number;
  test_customer_count: number;
  test_customer_revenue_cents: number;
  inflation_pct: number;
  discriminator: string;
}

type Issue = IssueRevenue | IssueChurn | IssueCosmetic;

interface GroundTruth {
  reference_date: string;
  reporting_window: string[];
  bug_months: string[];
  issues: Issue[];
  impact_ranking: string[];
  impact_tier_by_issue: Record<string, "HIGH" | "LOW">;
  totals: {
    customers: number;
    real_customers: number;
    test_customers: number;
    subscriptions: number;
    base_payments: number;
    duplicate_payments: number;
    payments: number;
  };
  root_cause_narrative: string;
}

const ROOT_CAUSE_NARRATIVE =
  "Three issues are present, of differing business impact:\n\n" +
  "  Issue 1 (HIGH) — Revenue double-count. In Apr+May 2026 a webhook-retry " +
  "bug double-inserted ~8% of succeeded payments. Duplicates share " +
  "external_payment_id + amount_cents + subscription_id and differ by id and " +
  "a few seconds of created_at. Dedup by external_payment_id (e.g. SELECT " +
  "MIN(id) per external_payment_id, JOIN back) before SUMing amount_cents — " +
  "filtering to status = 'succeeded'. Refunds and UTC month-boundary " +
  "timestamps are red herrings and do not close the gap.\n\n" +
  "  Issue 2 (HIGH) — Churn miscount. The subscriptions table has three " +
  "statuses — active, churned, paused. A naive churn query that treats " +
  "paused as churned (e.g. WHERE status != 'active') materially overstates " +
  "churn: naive ≈ 38%, true (churned-only) ≈ 16%. Paused subs are still " +
  "paying recently (the data shows recent payments for paused subs), so they " +
  "are not lost relationships. Discriminator: GROUP BY status on the " +
  "subscriptions table.\n\n" +
  "  Issue 3 (LOW) — Cosmetic customer-count inflation. 30 customers with " +
  "names matching 'Internal Sandbox %' or 'Test_Acct_%' (plan='internal') " +
  "exist in the customers table with no subscriptions and no payments. They " +
  "inflate COUNT(*) FROM customers from 400 → 430 but produce $0 in revenue. " +
  "This is the trap the teammate (Sam) pushes as 'what leadership cares " +
  "about.' Discriminator: name pattern + JOIN to confirm zero financial " +
  "impact.";

function computeGroundTruth(
  payments: Payment[],
  basePayments: Payment[],
  duplicatePayments: Payment[],
  realCustomers: Customer[],
  testCustomers: Customer[],
  subscriptions: Subscription[],
): GroundTruth {
  // ── Issue 1: revenue ──
  const naive: Record<string, number> = {};
  const corrected: Record<string, number> = {};
  const succeededCountByMonth: Record<string, number> = {};
  const dupCountByMonth: Record<string, number> = {};

  for (const month of REPORTING_WINDOW) {
    naive[month] = 0;
    corrected[month] = 0;
    succeededCountByMonth[month] = 0;
  }

  for (const p of payments) {
    if (p.status !== "succeeded") continue;
    if (!REPORTING_WINDOW.includes(p.month_bucket)) continue;
    naive[p.month_bucket]! += p.amount_cents;
    succeededCountByMonth[p.month_bucket] =
      (succeededCountByMonth[p.month_bucket] ?? 0) + 1;
  }

  const seenEpid = new Set<string>();
  const sortedSucc = payments
    .filter((p) => p.status === "succeeded")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of sortedSucc) {
    if (seenEpid.has(p.external_payment_id)) continue;
    seenEpid.add(p.external_payment_id);
    if (!REPORTING_WINDOW.includes(p.month_bucket)) continue;
    corrected[p.month_bucket]! += p.amount_cents;
  }

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

  const issueRevenue: IssueRevenue = {
    id: "revenue_double_count",
    impact: "HIGH",
    naive_monthly_cents: naive,
    corrected_monthly_cents: corrected,
    overstatement_cents: overstatement,
    overstatement_by_month_cents: overstatementByMonth,
    duplicate_count_by_month: dupCountByMonth,
    succeeded_count_by_month: succeededCountByMonth,
    discriminator:
      "Dedup payments by external_payment_id (keep MIN(id)) before SUM, " +
      "filtered to status='succeeded'. Refunds are red herrings.",
  };

  // ── Issue 2: churn ──
  let active = 0, churned = 0, paused = 0;
  for (const s of subscriptions) {
    if (s.status === "active") active++;
    else if (s.status === "churned") churned++;
    else if (s.status === "paused") paused++;
  }
  const total = subscriptions.length;
  const naiveChurn = (churned + paused) / total;
  const trueChurn = churned / total;
  const issueChurn: IssueChurn = {
    id: "churn_paused_miscount",
    impact: "HIGH",
    total_subscriptions: total,
    active_count: active,
    churned_count: churned,
    paused_count: paused,
    naive_churn_rate: Number(naiveChurn.toFixed(4)),
    true_churn_rate: Number(trueChurn.toFixed(4)),
    delta_pp: Number(((naiveChurn - trueChurn) * 100).toFixed(2)),
    misclassified_subscription_count: paused,
    discriminator:
      "GROUP BY status on subscriptions; paused is a third state that is NOT " +
      "churn. Paused subs have recent payments — they are alive.",
  };

  // ── Issue 3: cosmetic count ──
  const totalCustomers = realCustomers.length + testCustomers.length;
  const inflationPct = (testCustomers.length / realCustomers.length) * 100;
  const issueCosmetic: IssueCosmetic = {
    id: "cosmetic_count_inflation",
    impact: "LOW",
    total_customers: totalCustomers,
    real_customer_count: realCustomers.length,
    test_customer_count: testCustomers.length,
    test_customer_revenue_cents: 0,
    inflation_pct: Number(inflationPct.toFixed(2)),
    discriminator:
      "customers.name LIKE 'Test_%' OR LIKE 'Internal Sandbox%'. These " +
      "customers have no subscriptions and contribute $0 to revenue.",
  };

  return {
    reference_date: REFERENCE_DATE,
    reporting_window: REPORTING_WINDOW,
    bug_months: BUG_MONTHS,
    issues: [issueRevenue, issueChurn, issueCosmetic],
    impact_ranking: [
      "revenue_double_count",
      "churn_paused_miscount",
      "cosmetic_count_inflation",
    ],
    impact_tier_by_issue: {
      revenue_double_count: "HIGH",
      churn_paused_miscount: "HIGH",
      cosmetic_count_inflation: "LOW",
    },
    totals: {
      customers: totalCustomers,
      real_customers: realCustomers.length,
      test_customers: testCustomers.length,
      subscriptions: subscriptions.length,
      base_payments: basePayments.length,
      duplicate_payments: duplicatePayments.length,
      payments: payments.length,
    },
    root_cause_narrative: ROOT_CAUSE_NARRATIVE,
  };
}

// ─── Serializers ────────────────────────────────────────────────────────────

const SCHEMA_SQL = `-- fde-db-triage-pro synthetic schema (GENERATED — do not edit by hand)
-- Portable subset that runs in both Postgres (\\i schema.sql) and SQLite (.read schema.sql).
-- Regenerate via:  pnpm exec tsx fixtures/fde-db-triage-pro/generate.ts

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
CREATE INDEX subscriptions_status         ON subscriptions (status);
CREATE INDEX customers_name               ON customers (name);
`;

const QUERIES_SQL = `-- Sample queries proving each Tier 1.5 issue is findable (GENERATED).
-- Output columns vary per query; tag column identifies the issue.

-- ─── Issue 1 (HIGH) — Revenue double-count ─────────────────────────────────
-- Naive monthly succeeded revenue (what the dashboard shows — includes duplicates).
SELECT 'issue1_naive' AS tag, substr(created_at, 1, 7) AS month, SUM(amount_cents) AS cents
FROM payments
WHERE status = 'succeeded'
  AND substr(created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
GROUP BY substr(created_at, 1, 7)
ORDER BY month;

-- Corrected monthly succeeded revenue: dedup by external_payment_id (keep MIN id).
WITH dedup AS (
  SELECT MIN(id) AS keep_id
  FROM payments
  WHERE status = 'succeeded'
  GROUP BY external_payment_id
)
SELECT 'issue1_corrected' AS tag, substr(p.created_at, 1, 7) AS month, SUM(p.amount_cents) AS cents
FROM payments p
JOIN dedup d ON d.keep_id = p.id
WHERE substr(p.created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
GROUP BY substr(p.created_at, 1, 7)
ORDER BY month;

-- Duplicate fingerprint: external_payment_ids appearing more than once.
SELECT 'issue1_duplicates' AS tag, external_payment_id, COUNT(*) AS n
FROM payments
WHERE status = 'succeeded'
GROUP BY external_payment_id
HAVING COUNT(*) > 1
ORDER BY external_payment_id
LIMIT 10;

-- ─── Issue 2 (HIGH) — Churn paused miscount ────────────────────────────────
-- Status distribution: three states, not two.
SELECT 'issue2_status_split' AS tag, status, COUNT(*) AS n
FROM subscriptions
GROUP BY status
ORDER BY status;

-- Naive churn (treats paused as churned) vs true churn (churned only).
SELECT 'issue2_naive_churn' AS tag,
  ROUND(100.0 * SUM(CASE WHEN status IN ('churned','paused') THEN 1 ELSE 0 END) / COUNT(*), 2) AS pct
FROM subscriptions;

SELECT 'issue2_true_churn' AS tag,
  ROUND(100.0 * SUM(CASE WHEN status = 'churned' THEN 1 ELSE 0 END) / COUNT(*), 2) AS pct
FROM subscriptions;

-- Proof paused subs are alive (recent payments).
SELECT 'issue2_paused_recent_payments' AS tag, COUNT(*) AS n
FROM subscriptions s
JOIN payments p ON p.subscription_id = s.id
WHERE s.status = 'paused'
  AND p.status = 'succeeded'
  AND substr(p.created_at, 1, 7) IN ('2026-04', '2026-05');

-- ─── Issue 3 (LOW) — Cosmetic customer-count inflation ─────────────────────
-- Test/internal customer count (the trap: inflates COUNT(*) but $0 revenue).
SELECT 'issue3_test_customer_count' AS tag, COUNT(*) AS n
FROM customers
WHERE name LIKE 'Test\\_%' ESCAPE '\\' OR name LIKE 'Internal Sandbox%';

-- Total revenue attributable to those customers (should be 0).
SELECT 'issue3_test_customer_revenue' AS tag, COALESCE(SUM(p.amount_cents), 0) AS cents
FROM customers c
LEFT JOIN subscriptions s ON s.customer_id = c.id
LEFT JOIN payments p ON p.subscription_id = s.id AND p.status = 'succeeded'
WHERE c.name LIKE 'Test\\_%' ESCAPE '\\' OR c.name LIKE 'Internal Sandbox%';
`;

function serializeSeed(
  customers: Customer[],
  subscriptions: Subscription[],
  payments: Payment[],
): string {
  const parts: string[] = [];
  parts.push("-- fde-db-triage-pro synthetic seed (GENERATED — do not edit by hand)");
  parts.push("-- Regenerate via: pnpm exec tsx fixtures/fde-db-triage-pro/generate.ts");
  parts.push("BEGIN;");
  parts.push("");

  parts.push("-- customers (real + test/internal, sorted by id)");
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
  const realCustomers = generateRealCustomers(N_REAL_CUSTOMERS);
  const testCustomers = generateTestCustomers(N_TEST_CUSTOMERS, realCustomers.length);
  const subscriptions = generateSubscriptions(N_TOTAL_SUBS, realCustomers);
  const basePayments = generateBasePayments(subscriptions);
  injectTimezoneRedHerring(basePayments);
  const dups = injectDuplicates(basePayments);
  const allPayments = [...basePayments, ...dups].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  // Customers sorted by id keeps real customers first (cus_0001..cus_0400)
  // and test customers at the tail (cus_0401..cus_0430). Already in that
  // order by construction; the explicit sort is defensive.
  const allCustomers = [...realCustomers, ...testCustomers].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const ground = computeGroundTruth(
    allPayments,
    basePayments,
    dups,
    realCustomers,
    testCustomers,
    subscriptions,
  );

  const here = dirname(fileURLToPath(import.meta.url));
  mkdirSync(here, { recursive: true });

  writeFileSync(resolve(here, "schema.sql"), SCHEMA_SQL);
  writeFileSync(resolve(here, "queries.sql"), QUERIES_SQL);
  writeFileSync(
    resolve(here, "seed.sql"),
    serializeSeed(allCustomers, subscriptions, allPayments),
  );
  writeFileSync(
    resolve(here, "ground_truth.json"),
    JSON.stringify(ground, null, 2) + "\n",
  );

  console.log("[fde-db-triage-pro] generator complete");
  console.log("  real customers:      ", realCustomers.length);
  console.log("  test customers:      ", testCustomers.length);
  console.log("  total customers:     ", allCustomers.length);
  console.log("  subscriptions:       ", subscriptions.length);
  console.log(
    "    status mix:          active=", ground.issues[1]!.id === "churn_paused_miscount"
      ? (ground.issues[1] as IssueChurn).active_count : "?",
    " churned=", ground.issues[1]!.id === "churn_paused_miscount"
      ? (ground.issues[1] as IssueChurn).churned_count : "?",
    " paused=", ground.issues[1]!.id === "churn_paused_miscount"
      ? (ground.issues[1] as IssueChurn).paused_count : "?",
  );
  console.log("  base payments:       ", basePayments.length);
  console.log("  duplicate payments:  ", dups.length);
  console.log("  total payments:      ", allPayments.length);
  console.log();
  console.log("  Issue 1 overstatement (cents):", (ground.issues[0] as IssueRevenue).overstatement_cents);
  console.log("  Issue 2 naive vs true churn:  ",
    (ground.issues[1] as IssueChurn).naive_churn_rate,
    "vs",
    (ground.issues[1] as IssueChurn).true_churn_rate,
    "(Δ", (ground.issues[1] as IssueChurn).delta_pp, "pp)",
  );
  console.log("  Issue 3 test-account count:   ", (ground.issues[2] as IssueCosmetic).test_customer_count);
  console.log("  ranking:                       ", ground.impact_ranking.join(" > "));
}

main();
