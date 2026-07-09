"use client";
// Costs dashboard (admin-only, READ-ONLY) — the operator's billing cockpit.
//
// One GET to /api/admin/costs/overview renders four sections: a headline
// strip, LiteLLM gateway spend, internal usage (our sessions table), and
// static fixed-plan service cards. The server computes every number; this
// component only renders. Guard rails baked in:
//   - gateway-down is NOT a failure: litellm.available=false renders as an
//     "unreachable" card and the rest of the page still shows
//   - the from/to date filter refetches ONLY /internal (the section endpoints
//     exist exactly for this) — GET only, no write controls anywhere
//   - every money figure renders $X.XX; generated_at is always visible
// Partner keys (403) / missing key (401) get a friendly admin-only screen,
// not an error dump.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AdminOnlyError,
  getCostsInternal,
  getCostsOverview,
  type CostsFilters,
  type CostsOverview,
  type InternalUsageSection,
  type LitellmSpendSection,
} from "@/lib/api";
import { color, font, radius } from "@/styles/tokens";

// ─── formatting ──────────────────────────────────────────────────────────────

/** The one legal rendering of a money figure: $X.XX (or — for no data). */
function usd(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
}

function fmtHours(v: number): string {
  return v.toFixed(2);
}

/** Date input value (YYYY-MM-DD) → ISO datetime bounds the server accepts. */
function toFilters(from: string, to: string): CostsFilters {
  const f: CostsFilters = {};
  if (from) f.from = `${from}T00:00:00.000Z`;
  if (to) f.to = `${to}T23:59:59.999Z`;
  return f;
}

// ─── fetch state ─────────────────────────────────────────────────────────────

type FetchState<T> =
  | { kind: "loading" }
  | { kind: "ok"; data: T }
  | { kind: "error"; message: string }
  | { kind: "denied" };

// ─── top-level dashboard ─────────────────────────────────────────────────────

export default function CostsDashboard() {
  const [state, setState] = useState<FetchState<CostsOverview>>({ kind: "loading" });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [internalBusy, setInternalBusy] = useState(false);
  const [internalError, setInternalError] = useState<string | null>(null);

  // Initial load + retry: the full overview, honoring any set date window.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    setInternalError(null);
    getCostsOverview(toFilters(from, to)).then(
      (data) => { if (!cancelled) setState({ kind: "ok", data }); },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof AdminOnlyError) { setState({ kind: "denied" }); return; }
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load",
        });
      },
    );
    return () => { cancelled = true; };
    // Deliberately keyed on reloadKey only — date changes go through
    // applyFilters, which refreshes just the internal section.
  }, [reloadKey]);

  // Date filter → refetch ONLY /internal and splice it into the payload.
  const applyFilters = useCallback(() => {
    setInternalBusy(true);
    setInternalError(null);
    getCostsInternal(toFilters(from, to)).then(
      (r) => {
        setState((s) =>
          s.kind === "ok"
            ? { kind: "ok", data: { ...s.data, internal: r.internal, generated_at: r.generated_at } }
            : s,
        );
        setInternalBusy(false);
      },
      (err: unknown) => {
        setInternalBusy(false);
        if (err instanceof AdminOnlyError) { setState({ kind: "denied" }); return; }
        setInternalError(err instanceof Error ? err.message : "Failed to load");
      },
    );
  }, [from, to]);

  if (state.kind === "denied") {
    return (
      <div
        style={{
          padding: 48,
          textAlign: "center",
          background: color.bg.panel,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.md,
        }}
      >
        <div style={{ fontSize: 15, color: color.text.primary, fontWeight: 600, marginBottom: 8 }}>
          Admin only — this view requires the asaya admin key
        </div>
        <p style={{ fontSize: 13, color: color.text.secondary, margin: "0 0 16px" }}>
          The costs dashboard is asaya operations, not partner-facing. Set the admin org key
          (top right on the review page) and reload.
        </p>
        <Link href="/review" style={{ color: color.accent.base, fontSize: 13, textDecoration: "none" }}>
          ← back to review
        </Link>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div
        style={{
          padding: 48,
          textAlign: "center",
          background: color.bg.panel,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.md,
          fontSize: 12,
          color: color.text.muted,
        }}
      >
        Loading costs…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div
        style={{
          padding: 48,
          textAlign: "center",
          background: color.bg.panel,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.md,
        }}
      >
        <div style={{ fontSize: 13, color: color.error.base, marginBottom: 12 }}>{state.message}</div>
        <RetryButton onClick={() => setReloadKey((k) => k + 1)} />
      </div>
    );
  }

  const { litellm, internal, fixed_services, generated_at } = state.data;
  const fixedTotal = fixed_services.reduce((s, f) => s + f.est_monthly_usd, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* a. headline strip */}
      <section
        style={{
          display: "flex",
          gap: 24,
          padding: "14px 16px",
          background: color.bg.panel,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.md,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        <HeadlineStat
          label="LiteLLM month-to-date"
          value={litellm.available ? usd(litellm.month_to_date_usd) : "—"}
          hint={litellm.available ? "gateway spend since the 1st (UTC)" : "gateway unreachable"}
          tone={litellm.available ? undefined : color.warn.base}
        />
        <HeadlineStat label="Internal cost (window)" value={usd(internal.cost.total_usd)} hint="sum of sessions.spend_usd" />
        <HeadlineStat label="Sessions" value={String(internal.sessions.total)} hint="in window" />
        <HeadlineStat label="Sandbox hours" value={fmtHours(internal.sandbox_hours.total)} hint="E2B compute time" />
        <HeadlineStat label="Est. fixed monthly" value={usd(fixedTotal)} hint="sum of fixed-plan estimates" />
        <span style={{ marginLeft: "auto", fontSize: 10, color: color.text.muted, fontFamily: font.mono }}>
          generated {generated_at}
        </span>
      </section>

      {/* b. Fixed-plan services */}
      <Panel
        title="Fixed services"
        subtitle="Static plan estimates with link-outs — no provider billing APIs are queried. Edit the FIXED_SERVICES constant on the server to update a card."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 12,
            padding: 16,
          }}
        >
          {fixed_services.map((s) => (
            <div
              key={s.name}
              style={{
                border: `1px solid ${color.border.default}`,
                borderRadius: radius.md,
                padding: "12px 14px",
                background: color.bg.elevated,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: color.text.primary }}>{s.name}</span>
                <span style={{ fontSize: 11, color: color.text.secondary }}>{s.plan}</span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 13,
                    fontWeight: 600,
                    fontFamily: font.mono,
                    color: color.accent.base,
                  }}
                >
                  {usd(s.est_monthly_usd)}/mo
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 11, color: color.text.muted, lineHeight: 1.5, flex: 1 }}>
                {s.notes}
              </p>
              <a
                href={s.dashboard_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 11, color: color.accent.base, textDecoration: "none" }}
              >
                Open billing →
              </a>
            </div>
          ))}
        </div>
      </Panel>

      {/* c. LiteLLM gateway */}
      <Panel
        title="LiteLLM gateway"
        subtitle="Model spend as the gateway accounts it — daily totals (last 30 days), per-model split, and the top per-key (≈ per-session) spenders."
      >
        <LitellmPanel data={litellm} />
      </Panel>

      {/* d. Internal usage */}
      <Panel
        title="Internal usage"
        subtitle="Our own accounting: sessions.spend_usd per session, budget utilization against the per-session cap, and sandbox time by scenario."
        headerRight={
          <DateFilter
            from={from}
            to={to}
            setFrom={setFrom}
            setTo={setTo}
            onApply={applyFilters}
            busy={internalBusy}
          />
        }
      >
        {internalError !== null && (
          <div style={{ padding: "10px 16px", fontSize: 12, color: color.error.base, borderBottom: `1px solid ${color.border.subtle}` }}>
            {internalError}{" "}
            <RetryButton onClick={applyFilters} />
          </div>
        )}
        <div style={{ opacity: internalBusy ? 0.5 : 1 }}>
          <InternalPanel data={internal} />
        </div>
      </Panel>

      <p style={{ fontSize: 11, color: color.text.muted, lineHeight: 1.5, margin: 0 }}>
        Read-only cockpit — all arithmetic is computed server-side; fixed-plan figures are
        static estimates, not live billing. Generated {generated_at}.
      </p>
    </div>
  );
}

// ─── panel chrome ────────────────────────────────────────────────────────────

function Panel({
  title,
  subtitle,
  headerRight,
  children,
}: {
  title: string;
  subtitle: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          background: color.bg.elevated,
          borderBottom: `1px solid ${color.border.default}`,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: color.text.primary,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {title}
        </span>
        {headerRight !== undefined && <span style={{ marginLeft: "auto" }}>{headerRight}</span>}
      </header>
      <p
        style={{
          margin: 0,
          padding: "8px 16px",
          fontSize: 11,
          color: color.text.muted,
          borderBottom: `1px solid ${color.border.subtle}`,
          lineHeight: 1.5,
        }}
      >
        {subtitle}
      </p>
      {children}
    </section>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        color: color.accent.base,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.sm,
        padding: "2px 10px",
        fontSize: 11,
        cursor: "pointer",
      }}
    >
      Retry
    </button>
  );
}

function HeadlineStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string | undefined;
}) {
  return (
    <div>
      <div style={{ fontSize: 10, color: color.text.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: tone ?? color.text.primary, fontFamily: font.mono }}>
        {value}
      </div>
      {hint !== undefined && <div style={{ fontSize: 10, color: color.text.muted }}>{hint}</div>}
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string | undefined }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: color.text.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: tone ?? color.text.primary, fontFamily: font.mono }}>
        {value}
      </div>
    </div>
  );
}

// ─── shared table bits (same idiom as ValidityDashboard) ─────────────────────

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 10,
  fontWeight: 600,
  color: color.text.secondary,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  borderBottom: `1px solid ${color.border.default}`,
  whiteSpace: "nowrap",
};
const thRight: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = {
  padding: "7px 12px",
  fontSize: 12,
  color: color.text.primary,
  borderBottom: `1px solid ${color.border.subtle}`,
  whiteSpace: "nowrap",
};
const tdNum: React.CSSProperties = {
  ...td,
  textAlign: "right",
  fontFamily: font.mono,
  fontVariantNumeric: "tabular-nums",
};

function TableWrap({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>{children}</table>
    </div>
  );
}

function SubHeading({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "10px 16px 4px",
        fontSize: 10,
        fontWeight: 600,
        color: color.text.secondary,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
      }}
    >
      {text}
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <div style={{ padding: 20, fontSize: 12, color: color.text.muted }}>{text}</div>;
}

/** Simple inline bar (0..1) — no chart deps. */
function Bar({ frac, tone }: { frac: number; tone?: string | undefined }) {
  const clamped = Math.max(0, Math.min(1, frac));
  return (
    <span
      style={{
        display: "inline-block",
        width: 80,
        height: 6,
        background: color.bg.input,
        borderRadius: radius.sm,
        verticalAlign: "middle",
      }}
    >
      <span
        style={{
          display: "block",
          width: `${clamped * 100}%`,
          height: "100%",
          background: tone ?? color.accent.deep,
          borderRadius: radius.sm,
        }}
      />
    </span>
  );
}

// ─── date filter (GET-only refetch of /internal) ─────────────────────────────

const dateInput: React.CSSProperties = {
  background: color.bg.input,
  color: color.text.primary,
  border: `1px solid ${color.border.default}`,
  borderRadius: radius.sm,
  padding: "3px 8px",
  fontSize: 11,
  fontFamily: font.mono,
  colorScheme: "dark",
};

function DateFilter({
  from,
  to,
  setFrom,
  setTo,
  onApply,
  busy,
}: {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  onApply: () => void;
  busy: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <label style={{ fontSize: 10, color: color.text.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        from
      </label>
      <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={dateInput} />
      <label style={{ fontSize: 10, color: color.text.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        to
      </label>
      <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={dateInput} />
      <button
        onClick={onApply}
        disabled={busy}
        style={{
          background: "transparent",
          color: color.accent.base,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.sm,
          padding: "3px 10px",
          fontSize: 11,
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Loading…" : "Apply"}
      </button>
    </span>
  );
}

// ─── b. LiteLLM section ──────────────────────────────────────────────────────

function LitellmPanel({ data }: { data: LitellmSpendSection }) {
  if (!data.available) {
    return (
      <div style={{ padding: 16 }}>
        <div
          style={{
            padding: "12px 16px",
            background: color.warn.soft,
            border: `1px solid ${color.warn.base}`,
            borderRadius: radius.md,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: color.warn.base, marginBottom: 4 }}>
            gateway unreachable
          </div>
          <div style={{ fontSize: 11, color: color.text.secondary, fontFamily: font.mono }}>
            {data.error ?? "no error detail"}
          </div>
          <div style={{ fontSize: 11, color: color.text.muted, marginTop: 6 }}>
            Internal and fixed-service sections below are unaffected.
          </div>
        </div>
      </div>
    );
  }

  // Per-day totals + per-model totals over the 30-day window, both derived
  // from the same daily_by_model rows.
  const byDay = new Map<string, number>();
  const byModel = new Map<string, number>();
  for (const r of data.daily_by_model) {
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.spend_usd);
    byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.spend_usd);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dayMax = Math.max(1e-9, ...days.map(([, v]) => v));
  const models = [...byModel.entries()].sort(([, a], [, b]) => b - a);
  const modelMax = Math.max(1e-9, ...models.map(([, v]) => v));
  const keyMax = Math.max(1e-9, ...data.top_keys.map((k) => k.spend_usd));

  return (
    <div>
      <SubHeading text="Daily spend (last 30 days, all models)" />
      {days.length === 0 ? (
        <EmptyNote text="No gateway spend recorded in the window." />
      ) : (
        <TableWrap>
          <thead>
            <tr style={{ background: color.bg.input }}>
              <th style={th}>Date</th>
              <th style={thRight}>Spend</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {days.map(([date, spend]) => (
              <tr key={date}>
                <td style={{ ...td, fontFamily: font.mono, fontSize: 11, color: color.text.secondary }}>{date}</td>
                <td style={tdNum}>{usd(spend)}</td>
                <td style={td}>
                  <Bar frac={spend / dayMax} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {models.length > 0 && (
        <>
          <SubHeading text="Spend by model (window total)" />
          <TableWrap>
            <thead>
              <tr style={{ background: color.bg.input }}>
                <th style={th}>Model</th>
                <th style={thRight}>Spend</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {models.map(([model, spend]) => (
                <tr key={model}>
                  <td style={{ ...td, fontFamily: font.mono, fontSize: 11 }}>{model}</td>
                  <td style={tdNum}>{usd(spend)}</td>
                  <td style={td}>
                    <Bar frac={spend / modelMax} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </>
      )}

      <SubHeading text="Top keys (all-time spend per key)" />
      {data.top_keys.length === 0 ? (
        <EmptyNote text="No key spend recorded yet." />
      ) : (
        <TableWrap>
          <thead>
            <tr style={{ background: color.bg.input }}>
              <th style={th}>Key alias</th>
              <th style={th}>Hash</th>
              <th style={thRight}>Spend</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {data.top_keys.map((k, i) => (
              <tr key={`${k.key_hash_prefix ?? k.key_alias ?? "key"}-${i}`}>
                <td style={{ ...td, fontFamily: font.mono, fontSize: 11 }}>
                  {k.key_alias ?? <span style={{ color: color.text.muted }}>—</span>}
                </td>
                <td style={{ ...td, fontFamily: font.mono, fontSize: 11, color: color.text.muted }}>
                  {k.key_hash_prefix ?? "—"}
                </td>
                <td style={tdNum}>{usd(k.spend_usd)}</td>
                <td style={td}>
                  <Bar frac={k.spend_usd / keyMax} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}

// ─── c. internal section ─────────────────────────────────────────────────────

const DAILY_ROWS = 14;

function InternalPanel({ data }: { data: InternalUsageSection }) {
  const distMax = Math.max(1, ...data.budget.distribution.map((b) => b.n));
  const scenarioMax = Math.max(1e-9, ...data.sandbox_hours.by_scenario.map((s) => s.hours));
  const daily = data.daily.slice(-DAILY_ROWS);
  const orgMax = Math.max(1e-9, ...data.by_org.map((o) => o.cost_usd));

  return (
    <div>
      {/* cost + budget stats */}
      <div
        style={{
          display: "flex",
          gap: 24,
          padding: "12px 16px",
          borderBottom: `1px solid ${color.border.subtle}`,
          flexWrap: "wrap",
        }}
      >
        <MiniStat label="Total cost" value={usd(data.cost.total_usd)} />
        <MiniStat label="Avg / session" value={usd(data.cost.avg_usd)} />
        <MiniStat label="p90 / session" value={usd(data.cost.p90_usd)} />
        <MiniStat label="Sessions" value={String(data.sessions.total)} />
        <MiniStat
          label="Avg budget util"
          value={
            data.budget.avg_utilization !== null
              ? `${(data.budget.avg_utilization * 100).toFixed(0)}%`
              : "—"
          }
        />
        <MiniStat
          label="Hit budget"
          value={String(data.budget.hit_budget_n)}
          tone={data.budget.hit_budget_n > 0 ? color.warn.base : undefined}
        />
        <MiniStat label="Sandbox hours" value={fmtHours(data.sandbox_hours.total)} />
      </div>

      {data.sessions.total === 0 ? (
        <EmptyNote text="No sessions in the selected window." />
      ) : (
        <>
          {/* budget utilization distribution */}
          <SubHeading text="Budget utilization (spend / budget, sessions with a positive budget)" />
          <TableWrap>
            <thead>
              <tr style={{ background: color.bg.input }}>
                <th style={th}>Bucket</th>
                <th style={thRight}>Sessions</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {data.budget.distribution.map((b) => (
                <tr key={b.bucket}>
                  <td style={{ ...td, fontFamily: font.mono, fontSize: 11 }}>{b.bucket}</td>
                  <td style={tdNum}>{b.n}</td>
                  <td style={td}>
                    <Bar frac={b.n / distMax} tone={b.bucket === "≥100%" && b.n > 0 ? color.warn.base : undefined} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>

          {/* sandbox hours by scenario */}
          <SubHeading text="Sandbox hours by scenario" />
          {data.sandbox_hours.by_scenario.length === 0 ? (
            <EmptyNote text="No sandbox time recorded in the window." />
          ) : (
            <TableWrap>
              <thead>
                <tr style={{ background: color.bg.input }}>
                  <th style={th}>Scenario</th>
                  <th style={thRight}>Hours</th>
                  <th style={thRight}>Sessions</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {data.sandbox_hours.by_scenario.map((s) => (
                  <tr key={s.scenario_slug}>
                    <td style={{ ...td, fontFamily: font.mono, fontSize: 11 }}>{s.scenario_slug}</td>
                    <td style={tdNum}>{fmtHours(s.hours)}</td>
                    <td style={tdNum}>{s.sessions}</td>
                    <td style={td}>
                      <Bar frac={s.hours / scenarioMax} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}

          {/* daily sessions + cost */}
          <SubHeading text={`Daily sessions + cost (last ${daily.length} of ${data.daily.length} days)`} />
          <TableWrap>
            <thead>
              <tr style={{ background: color.bg.input }}>
                <th style={th}>Date</th>
                <th style={thRight}>Sessions</th>
                <th style={thRight}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.date}>
                  <td style={{ ...td, fontFamily: font.mono, fontSize: 11, color: color.text.secondary }}>{d.date}</td>
                  <td style={tdNum}>{d.sessions}</td>
                  <td style={tdNum}>{usd(d.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>

          {/* by org */}
          <SubHeading text="By organization" />
          <TableWrap>
            <thead>
              <tr style={{ background: color.bg.input }}>
                <th style={th}>Organization</th>
                <th style={thRight}>Sessions</th>
                <th style={thRight}>Cost</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {data.by_org.map((o) => (
                <tr key={o.org_id}>
                  <td style={td} title={o.org_id}>{o.org_name}</td>
                  <td style={tdNum}>{o.sessions}</td>
                  <td style={tdNum}>{usd(o.cost_usd)}</td>
                  <td style={td}>
                    <Bar frac={o.cost_usd / orgMax} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </>
      )}
    </div>
  );
}
