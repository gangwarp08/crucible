"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { listReviewSessions, type ReviewSession } from "@/lib/api";
import StatusBadge from "./StatusBadge";
import { scoreColor } from "./format";

type SortKey = "created_at" | "spend_usd" | "duration_ms" | "overall_score";
type SortDir = "asc" | "desc";

// ── formatters ───────────────────────────────────────────────────────────────

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalSecs = Math.round(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSpend(usd: number | string | null): string {
  if (usd === null) return "—";
  const n = typeof usd === "string" ? parseFloat(usd) : usd;
  if (Number.isNaN(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ── header cell with sort indicator ──────────────────────────────────────────

function SortHeader({
  label,
  sortKey,
  currentKey,
  currentDir,
  align,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  align: "left" | "right";
  onSort: (k: SortKey) => void;
}) {
  const active = currentKey === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{
        textAlign: align,
        padding: "10px 14px",
        cursor: "pointer",
        color: active ? "#e6e6ea" : "#9999a3",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        userSelect: "none",
        borderBottom: "1px solid #2a2a36",
        whiteSpace: "nowrap",
      }}
    >
      {label}
      <span style={{ marginLeft: 4, opacity: active ? 1 : 0.3 }}>
        {active && currentDir === "asc" ? "▴" : "▾"}
      </span>
    </th>
  );
}

// ── main component ───────────────────────────────────────────────────────────

export default function SessionsTable() {
  const [sessions, setSessions] = useState<ReviewSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  async function load() {
    setError(null);
    setSessions(null);
    try {
      const data = await listReviewSessions();
      setSessions(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sessions");
    }
  }

  useEffect(() => { void load(); }, []);

  function handleSort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "created_at" ? "desc" : "desc"); }
  }

  const filteredSorted = useMemo(() => {
    if (!sessions) return [];
    const filtered =
      statusFilter === "all"
        ? sessions
        : sessions.filter((s) => s.status === statusFilter);

    const sorted = [...filtered].sort((a, b) => {
      let av: number, bv: number;
      if (sortKey === "created_at") {
        av = new Date(a.created_at).getTime();
        bv = new Date(b.created_at).getTime();
      } else if (sortKey === "spend_usd") {
        av = typeof a.spend_usd === "string" ? parseFloat(a.spend_usd) : a.spend_usd;
        bv = typeof b.spend_usd === "string" ? parseFloat(b.spend_usd) : b.spend_usd;
      } else if (sortKey === "overall_score") {
        // Unevaluated sessions sort to the bottom in BOTH directions so the
        // recruiter sees scored sessions first when ranking by overall.
        const aHas = typeof a.overall_score === "number";
        const bHas = typeof b.overall_score === "number";
        if (!aHas && !bHas) return 0;
        if (!aHas) return 1;
        if (!bHas) return -1;
        av = a.overall_score!;
        bv = b.overall_score!;
      } else {
        av = a.duration_ms ?? 0;
        bv = b.duration_ms ?? 0;
      }
      const cmp = av - bv;
      return sortDir === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [sessions, sortKey, sortDir, statusFilter]);

  // ── states ───────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div
        style={{
          padding: 32,
          textAlign: "center",
          color: "#ff7a7a",
          background: "#15151b",
          border: "1px solid #2a2a36",
          borderRadius: 6,
        }}
      >
        <div style={{ fontSize: 14, marginBottom: 12 }}>Failed to load sessions</div>
        <div style={{ fontSize: 12, color: "#9999a3", marginBottom: 16 }}>{error}</div>
        <button
          onClick={() => void load()}
          style={{
            background: "#7c7fff",
            color: "#e6e6ea",
            border: "none",
            padding: "6px 18px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (sessions === null) {
    return (
      <div style={{ background: "#15151b", border: "1px solid #2a2a36", borderRadius: 6, overflow: "hidden" }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid #22222b",
              display: "flex",
              gap: 16,
              opacity: 0.4 - i * 0.08,
            }}
          >
            {[80, 120, 80, 60, 60, 50, 50, 50].map((w, j) => (
              <div key={j} style={{ width: w, height: 10, background: "#2a2a36", borderRadius: 4 }} />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Filter bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
          fontSize: 13,
          color: "#9999a3",
        }}
      >
        <span>{filteredSorted.length} of {sessions.length} sessions</span>
        <span style={{ flex: 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              background: "#0f0f14",
              color: "#e6e6ea",
              border: "1px solid #555",
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 12,
              outline: "none",
            }}
          >
            <option value="all">All</option>
            <option value="completed">Completed</option>
            <option value="timed_out">Expired</option>
            <option value="active">Active</option>
            <option value="error">Error</option>
            <option value="aborted">Aborted</option>
          </select>
        </label>
      </div>

      {filteredSorted.length === 0 ? (
        <div
          style={{
            padding: 48,
            textAlign: "center",
            color: "#9999a3",
            background: "#15151b",
            border: "1px solid #2a2a36",
            borderRadius: 6,
            fontSize: 14,
          }}
        >
          {sessions.length === 0
            ? "No sessions yet. Sessions appear here once candidates begin assessments."
            : "No sessions match this filter."}
        </div>
      ) : (
        <div
          style={{
            background: "#15151b",
            border: "1px solid #2a2a36",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead style={{ background: "#1c1c24" }}>
              <tr>
                <th style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#9999a3", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #2a2a36" }}>
                  Session
                </th>
                <th style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#9999a3", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #2a2a36" }}>
                  Status
                </th>
                <SortHeader label="Overall"  sortKey="overall_score" currentKey={sortKey} currentDir={sortDir} align="right" onSort={handleSort} />
                <SortHeader label="Created"  sortKey="created_at"  currentKey={sortKey} currentDir={sortDir} align="left"  onSort={handleSort} />
                <th style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#9999a3", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #2a2a36" }}>
                  Ended
                </th>
                <SortHeader label="Duration" sortKey="duration_ms" currentKey={sortKey} currentDir={sortDir} align="right" onSort={handleSort} />
                <SortHeader label="Spend"    sortKey="spend_usd"   currentKey={sortKey} currentDir={sortDir} align="right" onSort={handleSort} />
                <th style={{ textAlign: "right", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#9999a3", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #2a2a36" }}>
                  Msgs
                </th>
                <th style={{ textAlign: "right", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#9999a3", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #2a2a36" }}>
                  Files
                </th>
                <th style={{ textAlign: "right", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#9999a3", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #2a2a36" }}>
                  Events
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredSorted.map((s) => (
                <Row key={s.id} session={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ session: s }: { session: ReviewSession }) {
  const [hover, setHover] = useState(false);
  const numCell: React.CSSProperties = {
    textAlign: "right",
    padding: "10px 14px",
    fontVariantNumeric: "tabular-nums",
    fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
    color: "#e6e6ea",
  };
  const cell: React.CSSProperties = { padding: "10px 14px", color: "#e6e6ea" };

  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? "#1f1f28" : "transparent",
        borderBottom: "1px solid #22222b",
        transition: "background 0.1s",
      }}
    >
      <td style={cell}>
        <Link
          href={`/review/${s.id}`}
          style={{
            color: hover ? "#9396ff" : "#7c7fff",
            textDecoration: "none",
            fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
            fontSize: 12,
          }}
        >
          {s.id.slice(0, 8)}…
        </Link>
      </td>
      <td style={cell}>
        <StatusBadge status={s.status} />
      </td>
      <td style={{ ...numCell, color: "#e6e6ea" }}>
        {typeof s.overall_score === "number" ? (
          <>
            <span style={{ color: scoreColor(Math.round(s.overall_score)), fontWeight: 600 }}>
              {s.overall_score.toFixed(2)}
            </span>
            <span style={{ color: "#6a6a78", fontSize: 11, marginLeft: 2 }}>/5</span>
          </>
        ) : s.evaluation_status === "error" ? (
          <span
            style={{ color: "#ff7a7a", fontWeight: 500, fontSize: 11 }}
            title="Evaluation errored; open the session to re-run"
          >
            ERR
          </span>
        ) : (
          <span style={{ color: "#6a6a78" }}>—</span>
        )}
      </td>
      <td style={{ ...cell, color: "#9999a3", fontSize: 12, whiteSpace: "nowrap" }}>
        {formatDate(s.created_at)}
      </td>
      <td style={{ ...cell, color: "#9999a3", fontSize: 12, whiteSpace: "nowrap" }}>
        {formatDate(s.ended_at)}
      </td>
      <td style={numCell}>{formatDuration(s.duration_ms)}</td>
      <td style={numCell}>{formatSpend(s.spend_usd)}</td>
      <td style={numCell}>{s.messages}</td>
      <td style={numCell}>{s.file_saves}</td>
      <td style={numCell}>{s.event_count}</td>
    </tr>
  );
}
