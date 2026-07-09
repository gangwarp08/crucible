"use client";
// SQL query history for the recruiter review page: every db.query event the
// candidate ran (routes/query.ts logs one per call, ok or error), rendered as
// a seq-ordered table — monospace SQL (long queries truncate, click to
// expand), status, row count, and timing. Data comes from the detail
// endpoint's full event list; renders nothing when the session ran no queries
// (non-SQL scenario), mirroring SuspicionPanel's stay-invisible posture.
import { useMemo, useState } from "react";
import type { ReviewEvent } from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";
import { formatRelativeMs } from "./format";

const SQL_TRUNCATE_CHARS = 160;

interface SqlQueryRow {
  seq: number;
  ts: string;
  sql: string;
  status: string | null;
  rowCount: number | null;
  durationMs: number | null;
  error: string | null;
}

function parseQueries(events: ReviewEvent[]): SqlQueryRow[] {
  const out: SqlQueryRow[] = [];
  for (const e of events) {
    if (e.type !== "db.query") continue;
    const p: Record<string, unknown> = e.payload ?? {};
    if (typeof p["sql"] !== "string") continue;
    out.push({
      seq: e.seq,
      ts: e.ts,
      sql: p["sql"],
      status: typeof p["status"] === "string" ? p["status"] : null,
      rowCount: typeof p["row_count"] === "number" ? p["row_count"] : null,
      durationMs: typeof p["duration_ms"] === "number" ? p["duration_ms"] : null,
      error: typeof p["error"] === "string" ? p["error"] : null,
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function statusColor(status: string | null): string {
  if (status === "ok") return color.success.base;
  if (status === "error") return color.error.base;
  return color.text.muted;
}

function QueryRow({ q, index, startMs }: { q: SqlQueryRow; index: number; startMs: number }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = q.sql.length > SQL_TRUNCATE_CHARS;
  const shownSql = expanded || !isLong ? q.sql : `${q.sql.slice(0, SQL_TRUNCATE_CHARS)}…`;
  const tMs = new Date(q.ts).getTime() - startMs;

  return (
    <tr style={{ borderBottom: `1px solid ${color.border.subtle}`, verticalAlign: "top" }}>
      <td style={{ ...td, color: color.text.muted }}>{index + 1}</td>
      <td style={{ ...td, whiteSpace: "nowrap", color: color.text.muted }}>{formatRelativeMs(tMs)}</td>
      <td
        style={{
          ...td,
          color: color.text.primary,
          cursor: isLong ? "pointer" : "default",
          whiteSpace: expanded ? "pre-wrap" : "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: 0, // defer to the table-layout width; ellipsis needs a bound
          wordBreak: "break-word",
        }}
        title={isLong ? (expanded ? "Click to collapse" : "Click to expand full query") : undefined}
        onClick={() => { if (isLong) setExpanded((x) => !x); }}
      >
        {shownSql}
        {q.error !== null && (
          <div style={{ color: color.error.base, marginTop: 4, whiteSpace: "pre-wrap" }}>
            {q.error}
          </div>
        )}
      </td>
      <td style={{ ...td, color: statusColor(q.status), whiteSpace: "nowrap" }}>
        {q.status ?? "—"}
      </td>
      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
        {q.rowCount !== null ? q.rowCount : "—"}
      </td>
      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
        {q.durationMs !== null ? `${q.durationMs}ms` : "—"}
      </td>
    </tr>
  );
}

export default function SqlHistoryPanel({
  events,
  sessionStart,
}: {
  events: ReviewEvent[];
  sessionStart: string;
}) {
  const queries = useMemo(() => parseQueries(events), [events]);
  if (queries.length === 0) return null;

  const startMs = new Date(sessionStart).getTime();
  const errorCount = queries.filter((q) => q.status === "error").length;

  return (
    <section
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        marginBottom: 16,
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
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: color.text.secondary, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          SQL Query History
        </span>
        <span style={{ fontSize: 11, color: color.text.muted }}>
          {queries.length} {queries.length === 1 ? "query" : "queries"}
          {errorCount > 0 ? ` · ${errorCount} failed` : ""}
        </span>
      </header>

      <div style={{ maxHeight: 420, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, tableLayout: "fixed" }}>
          <thead>
            <tr style={{ background: color.bg.input }}>
              <th style={{ ...th, width: 36 }}>#</th>
              <th style={{ ...th, width: 52 }}>t+</th>
              <th style={th}>SQL</th>
              <th style={{ ...th, width: 56 }}>Status</th>
              <th style={{ ...th, width: 56, textAlign: "right" }}>Rows</th>
              <th style={{ ...th, width: 64, textAlign: "right" }}>Time</th>
            </tr>
          </thead>
          <tbody>
            {queries.map((q, i) => (
              <QueryRow key={q.seq} q={q} index={i} startMs={startMs} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 12px",
  fontSize: 10,
  fontWeight: 600,
  color: color.text.secondary,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  borderBottom: `1px solid ${color.border.default}`,
  position: "sticky",
  top: 0,
  background: color.bg.input,
};

const td: React.CSSProperties = {
  padding: "6px 12px",
  color: color.text.secondary,
  fontFamily: font.mono,
  fontVariantNumeric: "tabular-nums",
  fontSize: 11,
};
