"use client";
// P4.1 — cohort dashboard: every candidate who took one scenario, ranked.
// Columns: rank, candidate/session, band, per-competency mini-cells, overall,
// AI-Fluency label, scorable/excluded, suspicion flag (informational).
// Aggregates header (n / scorable / excluded / mean / stddev) is computed
// server-side (services/cohort.ts) — this component only renders.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  getCohort,
  NotFoundError,
  type CohortResponse,
  type CohortSessionRow,
} from "@/lib/api";
import { aiFluencyLabel } from "@/lib/ai-fluency";
import { prettyCompetency, formatDateShort } from "./format";
import { color, radius, font, scoreColor } from "@/styles/tokens";

// Display-only threshold for the ⚑ suspicion flag; the raw score always shows
// in the tooltip. Informational — never part of any score.
const SUSPICION_FLAG_THRESHOLD = 40;

const BAND_LABEL: Record<string, string> = { easy: "Easy", mid: "Mid", hard: "Hard" };

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; cohort: CohortResponse }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export default function CohortDashboard({ scenarioId }: { scenarioId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const cohort = await getCohort(scenarioId);
      setState({ kind: "ok", cohort });
    } catch (e) {
      if (e instanceof NotFoundError) setState({ kind: "not_found" });
      else setState({ kind: "error", message: e instanceof Error ? e.message : "Failed to load cohort" });
    }
  }, [scenarioId]);
  useEffect(() => { void load(); }, [load]);

  // Stable competency columns: union of keys across rows, alphabetical.
  const competencyKeys = useMemo(() => {
    if (state.kind !== "ok") return [];
    const keys = new Set<string>();
    for (const r of state.cohort.rows) for (const c of r.competencies) keys.add(c.key);
    return [...keys].sort();
  }, [state]);

  if (state.kind === "loading") {
    return <Message text="Loading cohort…" tone="muted" />;
  }
  if (state.kind === "not_found") {
    return <Message text="Scenario not found (or not visible to your organization)." tone="muted" />;
  }
  if (state.kind === "error") {
    return (
      <div>
        <Message text={state.message} tone="error" />
        <button onClick={() => void load()} style={retryBtn}>Retry</button>
      </div>
    );
  }

  const { scenario, rows, aggregates } = state.cohort;

  return (
    <div>
      {/* Aggregates header */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 24,
          flexWrap: "wrap",
          padding: "14px 16px",
          background: color.bg.panel,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.md,
          marginBottom: 16,
        }}
      >
        <Stat label="Candidates" value={String(aggregates.n)} />
        <Stat label="Scorable" value={String(aggregates.scorable_count)} />
        <Stat label="Excluded" value={String(aggregates.excluded_count)} />
        <Stat
          label="Mean (scorable)"
          value={aggregates.mean !== null ? aggregates.mean.toFixed(2) : "—"}
        />
        <Stat
          label="Std dev"
          value={aggregates.stddev !== null ? aggregates.stddev.toFixed(2) : "—"}
        />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: color.text.muted }}>
          {scenario.title} · {scenario.role.toUpperCase()}
        </span>
      </div>

      {rows.length === 0 ? (
        <Message text="No sessions for this scenario yet." tone="muted" />
      ) : (
        <div
          style={{
            background: color.bg.panel,
            border: `1px solid ${color.border.default}`,
            borderRadius: radius.md,
            overflowX: "auto",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead style={{ background: color.bg.elevated }}>
              <tr>
                <Th align="right">#</Th>
                <Th align="left">Candidate</Th>
                <Th align="left">Band</Th>
                {competencyKeys.map((k) => (
                  <Th key={k} align="right" title={prettyCompetency(k)}>
                    {abbrev(k)}
                  </Th>
                ))}
                <Th align="right">Overall</Th>
                <Th align="left">AI-Fluency</Th>
                <Th align="left">Status</Th>
                <Th align="right" title="Suspicion score (informational, never scored)">
                  Susp.
                </Th>
                <Th align="left">Started</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <CohortRowView key={r.session_id} row={r} competencyKeys={competencyKeys} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: 11, color: color.text.muted, marginTop: 10, lineHeight: 1.5 }}>
        Excluded sessions are counted but never averaged. AI-Fluency and suspicion are
        informational presentations — neither changes any score.
      </p>
    </div>
  );
}

function CohortRowView({
  row: r,
  competencyKeys,
}: {
  row: CohortSessionRow;
  competencyKeys: string[];
}) {
  const [hover, setHover] = useState(false);
  const byKey = new Map(r.competencies.map((c) => [c.key, c]));
  const excluded = r.scorable === false;
  const flagged = r.suspicion.score >= SUSPICION_FLAG_THRESHOLD;

  const cell: React.CSSProperties = {
    padding: "9px 12px",
    color: color.text.primary,
    borderBottom: `1px solid ${color.border.subtle}`,
    whiteSpace: "nowrap",
  };
  const numCell: React.CSSProperties = {
    ...cell,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    fontFamily: font.mono,
  };

  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ background: hover ? color.bg.hover : "transparent", opacity: excluded ? 0.65 : 1 }}
    >
      <td style={{ ...numCell, color: color.text.secondary }}>{r.rank ?? "—"}</td>
      <td style={cell}>
        <Link
          href={`/review/${r.session_id}`}
          style={{ color: hover ? color.accent.hover : color.accent.base, textDecoration: "none", fontSize: 12 }}
        >
          {r.candidate_label ?? `${r.session_id.slice(0, 8)}…`}
        </Link>
      </td>
      <td style={{ ...cell, fontSize: 12, color: color.text.secondary }}>
        {r.difficulty_band ? (BAND_LABEL[r.difficulty_band] ?? r.difficulty_band) : "—"}
      </td>
      {competencyKeys.map((k) => {
        const c = byKey.get(k);
        // Narrow to a plain number once — assessed cells always carry a score.
        const score = c && c.assessed && c.score !== null ? c.score : null;
        return (
          <td key={k} style={numCell} title={`${prettyCompetency(k)}${score !== null ? `: ${score}/5` : ": not assessed"}`}>
            {score !== null ? (
              <span style={{ color: scoreColor(score), fontWeight: 600 }}>{score}</span>
            ) : (
              <span style={{ color: color.text.muted }}>—</span>
            )}
          </td>
        );
      })}
      <td style={numCell}>
        {r.overall_score !== null ? (
          <span style={{ color: scoreColor(r.overall_score), fontWeight: 600 }}>
            {r.overall_score.toFixed(2)}
          </span>
        ) : r.evaluation_status === "error" ? (
          <span style={{ color: color.error.base, fontSize: 11 }}>ERR</span>
        ) : (
          <span style={{ color: color.text.muted }}>—</span>
        )}
      </td>
      <td style={{ ...cell, fontSize: 12, color: r.ai_fluency ? color.text.primary : color.text.muted }}>
        {aiFluencyLabel(r.ai_fluency)}
      </td>
      <td style={{ ...cell, fontSize: 11 }}>
        {excluded ? (
          <span
            style={{ color: color.warn.base, fontWeight: 600, letterSpacing: "0.03em" }}
            title={r.exclusion_reason ?? "excluded"}
          >
            EXCLUDED
          </span>
        ) : r.scorable === true ? (
          <span style={{ color: color.success.base }}>scorable</span>
        ) : (
          <span style={{ color: color.text.muted }}>{r.status ?? "—"}</span>
        )}
      </td>
      <td
        style={{ ...numCell, color: flagged ? color.warn.base : color.text.muted }}
        title={`Suspicion ${r.suspicion.score}/100 (informational, v${r.suspicion.version})`}
      >
        {flagged ? `⚑ ${r.suspicion.score}` : r.suspicion.score}
      </td>
      <td style={{ ...cell, fontSize: 12, color: color.text.secondary }}>
        {formatDateShort(r.created_at)}
      </td>
    </tr>
  );
}

// ── bits ─────────────────────────────────────────────────────────────────────

/** "data_fluency" → "DF"; "ai_orchestration" → "AO" — compact column headers,
 *  full name in the title tooltip. */
function abbrev(key: string): string {
  return key.split("_").map((w) => w.charAt(0).toUpperCase()).join("");
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: color.text.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: color.text.primary, fontFamily: font.mono }}>
        {value}
      </div>
    </div>
  );
}

function Th({
  children,
  align,
  title,
}: {
  children: React.ReactNode;
  align: "left" | "right";
  title?: string;
}) {
  return (
    <th
      title={title}
      style={{
        textAlign: align,
        padding: "9px 12px",
        fontSize: 11,
        fontWeight: 600,
        color: color.text.secondary,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        borderBottom: `1px solid ${color.border.default}`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Message({ text, tone }: { text: string; tone: "muted" | "error" }) {
  return (
    <div
      style={{
        padding: 32,
        textAlign: "center",
        color: tone === "error" ? color.error.base : color.text.secondary,
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}

const retryBtn: React.CSSProperties = {
  marginTop: 12,
  background: color.accent.base,
  color: color.text.inverse,
  border: "none",
  padding: "6px 18px",
  borderRadius: radius.lg,
  cursor: "pointer",
  fontSize: 13,
};
