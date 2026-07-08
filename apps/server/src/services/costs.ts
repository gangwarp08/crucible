// Costs dashboard aggregation (/api/admin/costs/*) — the operator's personal
// billing cockpit. READ-ONLY over (a) the LiteLLM gateway's spend API, (b) our
// own sessions table, and (c) a static fixed-plan services constant. This
// module adds NO writes and NO new accounting: per-session cost is the figure
// the server already tallies into sessions.spend_usd (mirrored per-call in
// cost_ledger); this is the cockpit that reads the instrument.
//
// Hard boundaries:
//   - LITELLM_MASTER_KEY is used ONLY in the Authorization header of gateway
//     requests. It is never logged, never included in any returned payload or
//     error string (sanitize() strips it defensively before anything leaves
//     this module).
//   - The gateway being down must not break the dashboard: litellmSpend()
//     never throws — it degrades to { available: false, error } and the
//     internal + fixed sections still render.
//   - Fixed-plan providers (Railway/Vercel/Supabase/E2B/Langfuse/Redis) are
//     NOT queried — no provider billing APIs. They surface as static link-out
//     cards (FIXED_SERVICES below).

import { env } from "../env.js";
import { supabase } from "./supabase.js";

export class CostsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CostsError";
  }
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** Strip the master key from any string that might leave this module. The key
 *  only ever travels in a request header, so this should never fire — it is
 *  defense in depth, not the primary control. */
function sanitize(s: string): string {
  return s.split(env.LITELLM_MASTER_KEY).join("[redacted]");
}

// ── (a) LiteLLM gateway spend ─────────────────────────────────────────────────
//
// Endpoints (LiteLLM proxy spend API, master-key admin calls — the same
// gateway the litellm-budget skill pins for /key/*). NOTE: our gateway runs
// OSS LiteLLM — /global/spend/report is Enterprise-gated (400s with a license
// nag), so this uses the free-tier surface, verified live against the Railway
// gateway:
//   GET /user/daily/activity?start_date&end_date → { results: [{ date,
//       metrics: { spend, ... }, breakdown: { models: { <model>: { metrics:
//       { spend } } } } }] } — admin (master key) sees proxy-wide activity.
//   GET /global/spend/keys?limit=N → [{ api_key (token hash), key_alias,
//       total_spend }] — ALL-TIME spend per key, ordered by spend.
// Response shapes drift across LiteLLM versions, so parsing is defensive:
// unrecognized rows are skipped, never fatal.

const LITELLM_TIMEOUT_MS = 10_000;
const SPEND_WINDOW_DAYS = 30;
const TOP_KEYS_LIMIT = 10;

export interface LitellmDailyModelSpend {
  date: string; // YYYY-MM-DD (UTC)
  model: string;
  spend_usd: number;
}

export interface LitellmTopKey {
  /** e.g. "session-<uuid>" for per-session keys (see litellm-budget skill). */
  key_alias: string | null;
  /** Truncated token hash — enough to eyeball, never a usable credential. */
  key_hash_prefix: string | null;
  /** ALL-TIME spend for this key (the OSS endpoint is not windowed). */
  spend_usd: number;
}

export interface LitellmSpendSection {
  available: boolean;
  error: string | null;
  /** Daily spend by model, last 30 days. */
  daily_by_model: LitellmDailyModelSpend[];
  /** Sum of gateway spend since the 1st of the current UTC month. */
  month_to_date_usd: number | null;
  /** Top per-key (≈ per-session) spenders inside the 30-day window. */
  top_keys: LitellmTopKey[];
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function gatewayGet(path: string): Promise<unknown> {
  const res = await fetch(`${env.LITELLM_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${env.LITELLM_MASTER_KEY}` },
    signal: AbortSignal.timeout(LITELLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Body is intentionally dropped from the surfaced error — status only.
    throw new Error(`gateway responded ${res.status} on ${path.split("?")[0]}`);
  }
  return res.json();
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export async function litellmSpend(): Promise<LitellmSpendSection> {
  const now = new Date();
  const end = utcDay(now);
  const start = utcDay(new Date(now.getTime() - SPEND_WINDOW_DAYS * 86_400_000));
  const monthStart = `${end.slice(0, 8)}01`; // 1st of current month — always inside the 30-day window

  try {
    const [dailyRaw, byKeyRaw] = await Promise.all([
      gatewayGet(`/user/daily/activity?start_date=${start}&end_date=${end}`),
      gatewayGet(`/global/spend/keys?limit=${TOP_KEYS_LIMIT}`),
    ]);

    // Daily-by-model: results[] rows carry { date, metrics: { spend },
    // breakdown: { models: { <model>: { metrics: { spend } } } } }. Anything
    // unparseable is skipped, never fatal.
    const daily_by_model: LitellmDailyModelSpend[] = [];
    let monthToDate = 0;
    const results = asArray((dailyRaw as { results?: unknown })?.results);
    for (const row of asArray(results)) {
      const r = row as { date?: unknown; metrics?: unknown; breakdown?: unknown };
      const date = typeof r.date === "string" ? r.date.slice(0, 10) : null;
      if (!date) continue;
      if (date >= monthStart) {
        monthToDate += asNum((r.metrics as { spend?: unknown } | undefined)?.spend);
      }
      const models = (r.breakdown as { models?: unknown } | undefined)?.models;
      if (models && typeof models === "object") {
        for (const [model, entry] of Object.entries(models as Record<string, unknown>)) {
          const spend = asNum((entry as { metrics?: { spend?: unknown } } | null)?.metrics?.spend);
          daily_by_model.push({ date, model: model || "unknown", spend_usd: round4(spend) });
        }
      }
    }
    daily_by_model.sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model));

    // Top keys: rows look like { api_key (token HASH, not a raw credential),
    // key_alias, total_spend }. The hash is truncated anyway — belt and braces.
    const top_keys = asArray(byKeyRaw)
      .map((row) => {
        const r = row as { key_alias?: unknown; api_key?: unknown; total_spend?: unknown; spend?: unknown };
        return {
          key_alias: typeof r.key_alias === "string" && r.key_alias !== "" ? sanitize(r.key_alias) : null,
          key_hash_prefix: typeof r.api_key === "string" ? sanitize(r.api_key).slice(0, 16) : null,
          spend_usd: round4(asNum(r.total_spend ?? r.spend)),
        };
      })
      .filter((k) => k.spend_usd > 0 || k.key_alias !== null)
      .sort((a, b) => b.spend_usd - a.spend_usd)
      .slice(0, TOP_KEYS_LIMIT);

    return {
      available: true,
      error: null,
      daily_by_model,
      month_to_date_usd: round4(monthToDate),
      top_keys,
    };
  } catch (err) {
    // Gateway down / slow / shape mismatch: degrade, never throw — the
    // dashboard renders the internal + fixed sections without this one.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      error: sanitize(msg),
      daily_by_model: [],
      month_to_date_usd: null,
      top_keys: [],
    };
  }
}

// ── (b) Internal usage (our DB) ───────────────────────────────────────────────
//
// Per-session cost = sessions.spend_usd — the server's own running tally
// (persistSessionUpdate after every LLM call; cost_ledger holds the per-call
// rows behind it). We read the session-level figure: it IS the stored
// accounting, not a recomputation.

export interface InternalUsageFilters {
  from?: string | undefined; // ISO datetime, on sessions.created_at
  to?: string | undefined;
}

export interface InternalUsageSection {
  window: { from: string | null; to: string | null };
  sessions: {
    total: number;
    by_status: Array<{ status: string; n: number }>;
    scorable: { scorable_n: number; excluded_n: number; pending_n: number };
  };
  cost: {
    total_usd: number;
    avg_usd: number | null;
    p90_usd: number | null;
  };
  budget: {
    /** Mean spend/budget ratio across sessions with a positive budget. */
    avg_utilization: number | null;
    /** Utilization histogram: [0,25) [25,50) [50,75) [75,100) [100,∞) percent. */
    distribution: Array<{ bucket: string; n: number }>;
    /** Sessions that hit the cap: end_reason='budget' OR spend >= budget. */
    hit_budget_n: number;
  };
  sandbox_hours: {
    total: number;
    by_scenario: Array<{ scenario_slug: string; hours: number; sessions: number }>;
  };
  daily: Array<{ date: string; sessions: number; cost_usd: number }>;
  by_org: Array<{ org_id: string; org_name: string; sessions: number; cost_usd: number }>;
}

interface CostSessionRow {
  id: string;
  status: string | null;
  scorable: boolean | null;
  end_reason: string | null;
  spend_usd: number | string | null;
  budget_usd: number | string | null;
  duration_ms: number | string | null;
  scenario_id: string | null;
  org_id: string | null;
  created_at: string;
}

const UTIL_BUCKETS = ["0–25%", "25–50%", "50–75%", "75–100%", "≥100%"] as const;

function quantile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function requireClient(): NonNullable<typeof supabase> {
  if (!supabase) throw new CostsError("Supabase service-role client unavailable");
  return supabase;
}

export async function internalUsage(
  filters: InternalUsageFilters = {},
): Promise<InternalUsageSection> {
  const db = requireClient();

  let q = db
    .from("sessions")
    .select(
      "id, status, scorable, end_reason, spend_usd, budget_usd, duration_ms, scenario_id, org_id, created_at",
    )
    // supabase-js caps select() at 1000 rows by default; range() lifts it —
    // 50k sessions is far beyond pilot scale (same pattern as check-daily-cost).
    .range(0, 49_999);
  if (filters.from) q = q.gte("created_at", filters.from);
  if (filters.to) q = q.lte("created_at", filters.to);
  const { data, error } = await q;
  if (error) throw new CostsError(`sessions read failed: ${error.message}`);
  const rows = (data ?? []) as CostSessionRow[];

  // Label maps (read-only lookups; failures degrade to raw ids, not errors).
  const scenarioSlug = new Map<string, string>();
  const orgName = new Map<string, string>();
  const [scen, orgs] = await Promise.all([
    db.from("scenarios").select("id, slug"),
    db.from("orgs").select("id, name"),
  ]);
  for (const s of (scen.data ?? []) as Array<{ id: string; slug: string }>) scenarioSlug.set(s.id, s.slug);
  for (const o of (orgs.data ?? []) as Array<{ id: string; name: string }>) orgName.set(o.id, o.name);

  // Status / scorable splits.
  const byStatus = new Map<string, number>();
  let scorableN = 0, excludedN = 0, pendingN = 0;

  // Cost + budget + sandbox + trends, one pass.
  const spends: number[] = [];
  const utils: number[] = [];
  const utilBuckets = new Array<number>(UTIL_BUCKETS.length).fill(0);
  let hitBudget = 0;
  let sandboxMsTotal = 0;
  const byScenario = new Map<string, { ms: number; sessions: number }>();
  const byDay = new Map<string, { sessions: number; cost: number }>();
  const byOrg = new Map<string, { sessions: number; cost: number }>();

  for (const r of rows) {
    const status = r.status ?? "unknown";
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    if (r.scorable === true) scorableN++;
    else if (r.scorable === false) excludedN++;
    else pendingN++;

    const spend = Number(r.spend_usd ?? 0) || 0;
    spends.push(spend);

    const budget = Number(r.budget_usd ?? 0) || 0;
    if (budget > 0) {
      const u = spend / budget;
      utils.push(u);
      const idx = u >= 1 ? 4 : Math.min(Math.floor(u * 4), 3);
      utilBuckets[idx]! += 1;
    }
    if (r.end_reason === "budget" || (budget > 0 && spend >= budget)) hitBudget++;

    const ms = Number(r.duration_ms ?? 0) || 0;
    if (ms > 0) {
      sandboxMsTotal += ms;
      const sk = r.scenario_id ?? "no-scenario";
      const cur = byScenario.get(sk) ?? { ms: 0, sessions: 0 };
      cur.ms += ms;
      cur.sessions += 1;
      byScenario.set(sk, cur);
    }

    const day = r.created_at.slice(0, 10);
    const d = byDay.get(day) ?? { sessions: 0, cost: 0 };
    d.sessions += 1;
    d.cost += spend;
    byDay.set(day, d);

    const ok = r.org_id ?? "no-org";
    const o = byOrg.get(ok) ?? { sessions: 0, cost: 0 };
    o.sessions += 1;
    o.cost += spend;
    byOrg.set(ok, o);
  }

  const total = spends.reduce((s, v) => s + v, 0);
  const sorted = [...spends].sort((a, b) => a - b);

  return {
    window: { from: filters.from ?? null, to: filters.to ?? null },
    sessions: {
      total: rows.length,
      by_status: [...byStatus.entries()]
        .map(([status, n]) => ({ status, n }))
        .sort((a, b) => b.n - a.n),
      scorable: { scorable_n: scorableN, excluded_n: excludedN, pending_n: pendingN },
    },
    cost: {
      total_usd: round4(total),
      avg_usd: rows.length > 0 ? round4(total / rows.length) : null,
      p90_usd: sorted.length > 0 ? round4(quantile(sorted, 0.9)) : null,
    },
    budget: {
      avg_utilization:
        utils.length > 0 ? round4(utils.reduce((s, v) => s + v, 0) / utils.length) : null,
      distribution: UTIL_BUCKETS.map((bucket, i) => ({ bucket, n: utilBuckets[i]! })),
      hit_budget_n: hitBudget,
    },
    sandbox_hours: {
      total: round4(sandboxMsTotal / 3_600_000),
      by_scenario: [...byScenario.entries()]
        .map(([sid, v]) => ({
          scenario_slug: scenarioSlug.get(sid) ?? sid,
          hours: round4(v.ms / 3_600_000),
          sessions: v.sessions,
        }))
        .sort((a, b) => b.hours - a.hours),
    },
    daily: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, sessions: v.sessions, cost_usd: round4(v.cost) })),
    by_org: [...byOrg.entries()]
      .map(([id, v]) => ({
        org_id: id,
        org_name: orgName.get(id) ?? id,
        sessions: v.sessions,
        cost_usd: round4(v.cost),
      }))
      .sort((a, b) => b.sessions - a.sessions),
  };
}

// ── (c) Fixed-plan services (static link-out cards) ──────────────────────────
//
// ★ OPERATOR-EDITABLE ★ — this constant IS the data. When you change a plan,
// upgrade a tier, or re-estimate a monthly figure, edit the entry here and
// redeploy; the dashboard renders it verbatim. There are deliberately NO
// provider billing API calls (no extra keys, no extra failure modes) —
// dashboard_url links straight to each provider's billing page for the real
// number.

export interface FixedService {
  name: string;
  plan: string;
  est_monthly_usd: number;
  dashboard_url: string;
  notes: string;
}

export const FIXED_SERVICES: readonly FixedService[] = [
  {
    name: "Railway",
    plan: "Hobby",
    est_monthly_usd: 5,
    dashboard_url: "https://railway.com/account/billing",
    notes: "Hosts the Fastify server AND the LiteLLM gateway. $5/mo includes usage credit; overage bills per-resource.",
  },
  {
    name: "Vercel",
    plan: "Hobby",
    est_monthly_usd: 0,
    dashboard_url: "https://vercel.com/account/billing",
    notes: "Next.js web app (candidate + review UI). Free tier.",
  },
  {
    name: "Supabase",
    plan: "Free",
    est_monthly_usd: 0,
    dashboard_url: "https://supabase.com/dashboard/org/_/billing",
    notes: "Postgres + Auth + RLS (sessions, telemetry, cost_ledger).",
  },
  {
    name: "E2B",
    plan: "Hobby (usage-based)",
    est_monthly_usd: 10,
    dashboard_url: "https://e2b.dev/dashboard?tab=billing",
    notes: "Candidate sandboxes. USAGE-BASED — estimate from the internal section's sandbox_hours × the sandbox's per-hour compute rate; check the E2B dashboard for the actual figure.",
  },
  {
    name: "Langfuse",
    plan: "Hobby (cloud)",
    est_monthly_usd: 0,
    dashboard_url: "https://cloud.langfuse.com",
    notes: "Our own debugging observability (not candidate/recruiter-facing). Billing lives under Organization Settings.",
  },
  {
    name: "Redis",
    plan: "Railway add-on",
    est_monthly_usd: 0,
    dashboard_url: "https://railway.com/account/billing",
    notes: "App-side session/rate-limit state. Runs as a Railway service — its usage is inside the Railway bill above. Edit this entry if Redis moves to a dedicated provider.",
  },
];

export function fixedServices(): FixedService[] {
  return FIXED_SERVICES.map((s) => ({ ...s }));
}
