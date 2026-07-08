"use client";
// Validity-instrumentation dashboard (admin-only, READ-ONLY).
//
// Seven panels reading the /api/admin/validity/* contract: not-assessed
// rates, exclusions, discrimination, band distributions, score↔outcome
// correlation, versions/drift, and a reliability PLACEHOLDER. The server
// computes every number; this component only renders. Guard rails baked in:
//   - N (and paired-N for correlation) shown on every metric
//   - insufficient_n renders literally as "insufficient N (n=X, min=Y)" —
//     never a number
//   - version context labeled on every panel; band labeled on every row
//   - correlation caveat text always visible; boundary_warning is a banner
//   - NO write controls anywhere.
// Partner keys (403) / missing key (401) get a friendly admin-only screen,
// not an error dump.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AdminOnlyError,
  getValidityCorrelation,
  getValidityDiscrimination,
  getValidityDistributions,
  getValidityExclusions,
  getValidityNotAssessed,
  getValidityVersions,
  type DistributionBand,
  type ValidityCorrelation,
  type ValidityDiscrimination,
  type ValidityDistributions,
  type ValidityEnvelope,
  type ValidityExclusions,
  type ValidityNotAssessed,
  type ValidityVersions,
} from "@/lib/api";
import { prettyCompetency } from "./format";
import { color, font, radius } from "@/styles/tokens";

// Same band vocabulary as the rest of the review surface (easy | mid | hard).
const BAND_LABEL: Record<string, string> = { easy: "Easy", mid: "Mid", hard: "Hard" };
function bandLabel(band: string | null | undefined): string {
  if (!band) return "all bands";
  return BAND_LABEL[band] ?? band;
}

/** The one legal rendering of a below-min-N metric. */
function insufficientN(n: number, min: number): string {
  return `insufficient N (n=${n}, min=${min})`;
}

function fmt(v: number | null | undefined, digits = 2): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

// ─── per-endpoint fetch state ────────────────────────────────────────────────

type PanelState<T> =
  | { kind: "loading" }
  | { kind: "ok"; data: T }
  | { kind: "error"; message: string };

type Denied = { denied: true } | { denied: false };

/** Fetch one validity endpoint; AdminOnlyError is escalated to the page. */
function usePanelData<T>(
  fetcher: () => Promise<T>,
  onDenied: () => void,
  reloadKey: number,
): PanelState<T> {
  const [state, setState] = useState<PanelState<T>>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetcher().then(
      (data) => { if (!cancelled) setState({ kind: "ok", data }); },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof AdminOnlyError) { onDenied(); return; }
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load",
        });
      },
    );
    return () => { cancelled = true; };
    // Deliberately keyed on reloadKey only — fetcher is a stable
    // module-level fn and onDenied a stable useCallback.
  }, [reloadKey]);
  return state;
}

// ─── top-level dashboard ─────────────────────────────────────────────────────

export default function ValidityDashboard() {
  const [access, setAccess] = useState<Denied>({ denied: false });
  const [reloadKey, setReloadKey] = useState(0);
  const onDenied = useCallback(() => setAccess({ denied: true }), []);

  const notAssessed = usePanelData(getValidityNotAssessed, onDenied, reloadKey);
  const exclusions = usePanelData(getValidityExclusions, onDenied, reloadKey);
  const discrimination = usePanelData(getValidityDiscrimination, onDenied, reloadKey);
  const distributions = usePanelData(getValidityDistributions, onDenied, reloadKey);
  const correlation = usePanelData(getValidityCorrelation, onDenied, reloadKey);
  const versions = usePanelData(getValidityVersions, onDenied, reloadKey);

  if (access.denied) {
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
          Validity instrumentation is asaya R&D, not partner-facing. Set the admin org key
          (top right on the review page) and reload.
        </p>
        <Link href="/review" style={{ color: color.accent.base, fontSize: 13, textDecoration: "none" }}>
          ← back to review
        </Link>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* boundary_warning: the "don't compare across versions" guard, in the UI */}
      {versions.kind === "ok" && versions.data.boundary_warning !== null && (
        <div
          style={{
            padding: "10px 16px",
            background: color.warn.soft,
            border: `1px solid ${color.warn.base}`,
            borderRadius: radius.md,
            color: color.warn.base,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          ⚠ {versions.data.boundary_warning}
        </div>
      )}

      <PanelFrame
        title="Not-assessed rates"
        subtitle="Which competencies is a scenario failing to surface? High rate on a load-bearing competency = the scenario doesn't elicit it."
        state={notAssessed}
        onRetry={() => setReloadKey((k) => k + 1)}
        render={(d) => <NotAssessedPanel data={d} />}
      />
      <PanelFrame
        title="Exclusions"
        subtitle="Why aren't sessions making the dataset? The one view over non-scorable sessions."
        state={exclusions}
        onRetry={() => setReloadKey((k) => k + 1)}
        render={(d) => <ExclusionsPanel data={d} />}
      />
      <PanelFrame
        title="Discrimination"
        subtitle="Is each competency separating candidates? Distributional spread + item-total structure (no ground-truth labels yet)."
        state={discrimination}
        onRetry={() => setReloadKey((k) => k + 1)}
        render={(d) => <DiscriminationPanel data={d} />}
      />
      <PanelFrame
        title="Band distributions"
        subtitle="Score quantiles + histograms per difficulty band. Never compare across bands without the equating context."
        state={distributions}
        onRetry={() => setReloadKey((k) => k + 1)}
        render={(d) => <DistributionsPanel data={d} />}
      />
      <PanelFrame
        title="Score ↔ outcome correlation"
        subtitle="Is the score starting to predict on-the-job performance? Paired-N gated — a number from n=8 is not a finding."
        state={correlation}
        onRetry={() => setReloadKey((k) => k + 1)}
        render={(d) => <CorrelationPanel data={d} />}
      />
      <PanelFrame
        title="Versions / drift"
        subtitle="What version was each cohort scored under? Legacy (judge v1) sessions are segregated, never pooled into current metrics."
        state={versions}
        onRetry={() => setReloadKey((k) => k + 1)}
        render={(d) => <VersionsPanel data={d} />}
      />
      <ReliabilityPlaceholder />

      <p style={{ fontSize: 11, color: color.text.muted, lineHeight: 1.5, margin: 0 }}>
        Read-only instrumentation over scorable sessions in the current version context
        (exclusions view excepted). All arithmetic is computed server-side. Metrics below
        the minimum N render as “insufficient N”, never as a number.
      </p>
    </div>
  );
}

// ─── panel chrome ────────────────────────────────────────────────────────────

function PanelFrame<T extends ValidityEnvelope>({
  title,
  subtitle,
  state,
  render,
  onRetry,
}: {
  title: string;
  subtitle: string;
  state: PanelState<T>;
  render: (data: T) => React.ReactNode;
  onRetry: () => void;
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
          alignItems: "baseline",
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
        {state.kind === "ok" && <EnvelopeBadges env={state.data} />}
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
      {state.kind === "loading" && (
        <div style={{ padding: 20, fontSize: 12, color: color.text.muted }}>Loading…</div>
      )}
      {state.kind === "error" && (
        <div style={{ padding: 20, fontSize: 12, color: color.error.base }}>
          {state.message}{" "}
          <button
            onClick={onRetry}
            style={{
              marginLeft: 8,
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
        </div>
      )}
      {state.kind === "ok" && render(state.data)}
    </section>
  );
}

/** N + version context on every panel — non-negotiable. */
function EnvelopeBadges({ env }: { env: ValidityEnvelope }) {
  const vc = env.version_context;
  const badge: React.CSSProperties = {
    fontSize: 10,
    fontFamily: font.mono,
    color: color.text.muted,
    border: `1px solid ${color.border.subtle}`,
    borderRadius: radius.sm,
    padding: "1px 6px",
    whiteSpace: "nowrap",
  };
  return (
    <span style={{ display: "flex", gap: 6, flexWrap: "wrap", marginLeft: "auto" }}>
      <span style={{ ...badge, color: color.text.secondary }}>
        N={env.generated_from.scorable_sessions_n} scorable
      </span>
      <span style={badge}>min N={env.min_n}</span>
      <span style={badge} title="Version context — metrics are never pooled across versions">
        model {vc.competency_model_version} · detector {vc.detector_version} · judge{" "}
        {vc.judge_prompt_version}
      </span>
    </span>
  );
}

// ─── shared table bits (same idiom as CohortDashboard / SuspicionPanel) ──────

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
const insufficientStyle: React.CSSProperties = {
  color: color.text.muted,
  fontStyle: "italic",
  fontFamily: font.sans,
};

function TableWrap({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>{children}</table>
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

// ─── 4.2 Not-assessed ────────────────────────────────────────────────────────

function NotAssessedPanel({ data }: { data: ValidityNotAssessed }) {
  if (data.rows.length === 0) return <EmptyNote text="No bound competencies in the current selection." />;
  return (
    <TableWrap>
      <thead>
        <tr style={{ background: color.bg.input }}>
          <th style={th}>Scenario</th>
          <th style={th}>Band</th>
          <th style={th}>Competency</th>
          <th style={th}>Load-bearing</th>
          <th style={thRight}>Bound N</th>
          <th style={thRight}>Not assessed</th>
          <th style={thRight}>Rate</th>
          <th style={th} />
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r, i) => (
          <tr key={`${r.scenario_id}-${r.band ?? "all"}-${r.competency_key}-${i}`}>
            <td style={td} title={r.scenario_id}>{r.scenario_slug}</td>
            <td style={{ ...td, color: color.text.secondary }}>{bandLabel(r.band)}</td>
            <td style={td}>{prettyCompetency(r.competency_key)}</td>
            <td style={{ ...td, color: r.load_bearing ? color.warn.base : color.text.muted }}>
              {r.load_bearing ? "load-bearing" : "—"}
            </td>
            <td style={tdNum}>{r.bound_n}</td>
            <td style={tdNum}>{r.not_assessed_n}</td>
            <td style={{ ...tdNum, color: r.load_bearing && r.rate >= 0.3 ? color.warn.base : color.text.primary }}>
              {(r.rate * 100).toFixed(0)}%
            </td>
            <td style={td}>
              <Bar frac={r.rate} tone={r.load_bearing && r.rate >= 0.3 ? color.warn.base : undefined} />
            </td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

// ─── 4.5 Exclusions ──────────────────────────────────────────────────────────

function ExclusionsPanel({ data }: { data: ValidityExclusions }) {
  const total = data.totals.scorable + data.totals.excluded;
  const weekMax = Math.max(1, ...data.over_time.map((w) => w.scorable + w.excluded));
  return (
    <div>
      <div style={{ display: "flex", gap: 24, padding: "12px 16px", borderBottom: `1px solid ${color.border.subtle}`, flexWrap: "wrap" }}>
        <MiniStat label="Sessions" value={String(total)} />
        <MiniStat label="Scorable" value={String(data.totals.scorable)} />
        <MiniStat label="Excluded" value={String(data.totals.excluded)} tone={color.warn.base} />
        <MiniStat
          label="Exclusion rate"
          value={total > 0 ? `${((data.totals.excluded / total) * 100).toFixed(0)}%` : "—"}
        />
      </div>
      {data.by_reason.length > 0 && (
        <TableWrap>
          <thead>
            <tr style={{ background: color.bg.input }}>
              <th style={th}>Exclusion reason</th>
              <th style={thRight}>N</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {data.by_reason.map((r) => (
              <tr key={r.reason}>
                <td style={{ ...td, fontFamily: font.mono, fontSize: 11 }}>{r.reason}</td>
                <td style={tdNum}>{r.n}</td>
                <td style={td}>
                  <Bar frac={data.totals.excluded > 0 ? r.n / data.totals.excluded : 0} tone={color.warn.base} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {data.over_time.length > 0 && (
        <TableWrap>
          <thead>
            <tr style={{ background: color.bg.input }}>
              <th style={th}>Week</th>
              <th style={thRight}>Scorable</th>
              <th style={thRight}>Excluded</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {data.over_time.map((w) => (
              <tr key={w.week}>
                <td style={{ ...td, fontFamily: font.mono, fontSize: 11, color: color.text.secondary }}>{w.week}</td>
                <td style={tdNum}>{w.scorable}</td>
                <td style={{ ...tdNum, color: w.excluded > 0 ? color.warn.base : color.text.muted }}>{w.excluded}</td>
                <td style={td}>
                  <Bar frac={(w.scorable + w.excluded) / weekMax} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {data.by_reason.length === 0 && data.over_time.length === 0 && (
        <EmptyNote text="No excluded sessions in the current selection." />
      )}
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
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

// ─── 4.1 Discrimination ──────────────────────────────────────────────────────

function DiscriminationPanel({ data }: { data: ValidityDiscrimination }) {
  if (data.segments.length === 0) return <EmptyNote text="No scorable evaluations in the current version context." />;
  return (
    <TableWrap>
      <thead>
        <tr style={{ background: color.bg.input }}>
          <th style={th}>Competency</th>
          <th style={thRight}>N</th>
          <th style={thRight}>Mean</th>
          <th style={thRight}>SD</th>
          <th style={thRight}>CV</th>
          <th style={thRight} title="Competency score vs overall — a structure check">Item-total r</th>
          <th style={th}>Flags</th>
        </tr>
      </thead>
      <tbody>
        {data.segments.map((s) => (
          <tr key={s.competency_key}>
            <td style={td}>{prettyCompetency(s.competency_key)}</td>
            <td style={tdNum}>{s.n}</td>
            {s.insufficient_n ? (
              <td colSpan={4} style={{ ...td, ...insufficientStyle }}>
                {insufficientN(s.n, data.min_n)}
              </td>
            ) : (
              <>
                <td style={tdNum}>{fmt(s.mean)}</td>
                <td style={tdNum}>{fmt(s.sd)}</td>
                <td style={tdNum}>{fmt(s.cv)}</td>
                <td style={{ ...tdNum, color: flagColor(s.flags, "low_item_total") }}>{fmt(s.item_total_r)}</td>
              </>
            )}
            <td style={{ ...td, fontSize: 11 }}>
              {s.flags.length === 0 ? (
                <span style={{ color: color.text.muted }}>—</span>
              ) : (
                s.flags.map((f) => (
                  <span
                    key={f}
                    style={{
                      color: color.warn.base,
                      border: `1px solid ${color.warn.base}`,
                      borderRadius: radius.sm,
                      padding: "1px 6px",
                      marginRight: 6,
                      fontFamily: font.mono,
                      fontSize: 10,
                    }}
                  >
                    {f}
                  </span>
                ))
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

function flagColor(flags: string[], flag: string): string {
  return flags.includes(flag) ? color.warn.base : color.text.primary;
}

// ─── 4.3 Band distributions ──────────────────────────────────────────────────

function DistributionsPanel({ data }: { data: ValidityDistributions }) {
  if (data.bands.length === 0) return <EmptyNote text="No scorable sessions in the current selection." />;
  return (
    <TableWrap>
      <thead>
        <tr style={{ background: color.bg.input }}>
          <th style={th}>Band</th>
          <th style={th}>Competency</th>
          <th style={thRight}>N</th>
          <th style={thRight}>p10</th>
          <th style={thRight}>p25</th>
          <th style={thRight}>p50</th>
          <th style={thRight}>p75</th>
          <th style={thRight}>p90</th>
          <th style={th}>Histogram</th>
        </tr>
      </thead>
      <tbody>
        {data.bands.map((b, i) => (
          <DistributionRow key={`${b.band}-${b.competency_key}-${i}`} row={b} minN={data.min_n} />
        ))}
      </tbody>
    </TableWrap>
  );
}

function DistributionRow({ row: b, minN }: { row: DistributionBand; minN: number }) {
  const q = b.quantiles;
  return (
    <tr>
      <td style={{ ...td, color: color.text.secondary, fontWeight: 600 }}>{bandLabel(b.band)}</td>
      <td style={td}>
        {b.competency_key === "overall" ? (
          <span style={{ fontWeight: 600 }}>Overall</span>
        ) : (
          prettyCompetency(b.competency_key)
        )}
      </td>
      <td style={tdNum}>{b.n}</td>
      {b.insufficient_n || q === null ? (
        <td colSpan={6} style={{ ...td, ...insufficientStyle }}>{insufficientN(b.n, minN)}</td>
      ) : (
        <>
          <td style={tdNum}>{fmt(q.p10, 1)}</td>
          <td style={tdNum}>{fmt(q.p25, 1)}</td>
          <td style={{ ...tdNum, fontWeight: 700 }}>{fmt(q.p50, 1)}</td>
          <td style={tdNum}>{fmt(q.p75, 1)}</td>
          <td style={tdNum}>{fmt(q.p90, 1)}</td>
          <td style={td}><Histogram buckets={b.histogram} /></td>
        </>
      )}
    </tr>
  );
}

/** Tiny inline column histogram — no chart deps. */
function Histogram({ buckets }: { buckets: Array<{ bucket: string; count: number }> }) {
  const max = Math.max(1, ...buckets.map((h) => h.count));
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: 22 }}>
      {buckets.map((h) => (
        <span
          key={h.bucket}
          title={`${h.bucket}: ${h.count}`}
          style={{
            width: 10,
            height: Math.max(2, Math.round((h.count / max) * 22)),
            background: h.count > 0 ? color.accent.deep : color.bg.input,
            borderRadius: "1px 1px 0 0",
          }}
        />
      ))}
    </span>
  );
}

// ─── 4.4 Correlation ─────────────────────────────────────────────────────────

function CorrelationPanel({ data }: { data: ValidityCorrelation }) {
  return (
    <div>
      {data.pairs.length === 0 ? (
        <EmptyNote text="No captured outcomes to correlate against yet." />
      ) : (
        <TableWrap>
          <thead>
            <tr style={{ background: color.bg.input }}>
              <th style={th}>Outcome</th>
              <th style={th}>Competency</th>
              <th style={thRight}>Paired N</th>
              <th style={thRight}>Pearson r</th>
              <th style={th}>Caveat</th>
            </tr>
          </thead>
          <tbody>
            {data.pairs.map((p, i) => (
              <tr key={`${p.outcome_type}-${p.competency_key}-${i}`}>
                <td style={{ ...td, fontFamily: font.mono, fontSize: 11 }}>{p.outcome_type}</td>
                <td style={td}>
                  {p.competency_key === "overall" ? (
                    <span style={{ fontWeight: 600 }}>Overall</span>
                  ) : (
                    prettyCompetency(p.competency_key)
                  )}
                </td>
                <td style={{ ...tdNum, fontWeight: 600 }}>{p.paired_n}</td>
                <td style={p.insufficient_n || p.r === null ? { ...td, ...insufficientStyle, textAlign: "right" } : tdNum}>
                  {p.insufficient_n || p.r === null ? insufficientN(p.paired_n, data.min_n) : fmt(p.r, 3)}
                </td>
                {/* The caveat is mandatory — always rendered, never truncated away. */}
                <td style={{ ...td, whiteSpace: "normal", fontSize: 11, color: color.text.secondary, minWidth: 220 }}>
                  {p.caveat}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <p style={{ margin: 0, padding: "8px 16px", fontSize: 11, color: color.warn.base, lineHeight: 1.5 }}>
        Correlations are computed over scorable sessions in a single version context and
        gated at paired-N ≥ {data.min_n}. A coefficient below that gate is not a finding.
      </p>
    </div>
  );
}

// ─── 4.6 Versions / drift ────────────────────────────────────────────────────

function VersionsPanel({ data }: { data: ValidityVersions }) {
  if (data.segments.length === 0) return <EmptyNote text="No evaluated sessions yet." />;
  return (
    <TableWrap>
      <thead>
        <tr style={{ background: color.bg.input }}>
          <th style={th}>Segment</th>
          <th style={th}>Competency model</th>
          <th style={th}>Detector</th>
          <th style={th}>Judge prompt</th>
          <th style={th}>Scenario</th>
          <th style={thRight}>N</th>
        </tr>
      </thead>
      <tbody>
        {data.segments.map((s, i) => (
          <tr key={`${s.competency_model_version}-${s.detector_version}-${s.judge_prompt_version}-${s.scenario_version}-${i}`} style={{ opacity: s.legacy ? 0.7 : 1 }}>
            <td style={{ ...td, fontSize: 11 }}>
              {s.legacy ? (
                <span
                  style={{
                    color: color.warn.base,
                    border: `1px solid ${color.warn.base}`,
                    borderRadius: radius.sm,
                    padding: "1px 6px",
                    fontFamily: font.mono,
                    fontSize: 10,
                  }}
                  title="Excluded from current metrics — shown here only"
                >
                  legacy (judge v1)
                </span>
              ) : (
                <span style={{ color: color.success.base }}>current</span>
              )}
            </td>
            <td style={{ ...td, fontFamily: font.mono, fontSize: 11 }}>{s.competency_model_version}</td>
            <td style={{ ...td, fontFamily: font.mono, fontSize: 11 }}>{s.detector_version}</td>
            <td style={{ ...td, fontFamily: font.mono, fontSize: 11 }}>{s.judge_prompt_version}</td>
            <td style={{ ...td, fontFamily: font.mono, fontSize: 11 }}>{s.scenario_version}</td>
            <td style={tdNum}>{s.n}</td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

// ─── 4.7 Reliability placeholder (web-only — no endpoint, no compute) ────────

function ReliabilityPlaceholder() {
  return (
    <section
      style={{
        background: color.bg.panel,
        border: `1px dashed ${color.border.default}`,
        borderRadius: radius.md,
        padding: "16px",
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: color.text.secondary,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Reliability
      </span>
      <p style={{ margin: "8px 0 0", fontSize: 12, color: color.text.muted, lineHeight: 1.6 }}>
        Coming with the replay harness — per-competency re-score variance and
        inter-model agreement will appear here once the batched replay/reinterpret
        tool exists. No data is computed for this panel today.
      </p>
    </section>
  );
}
