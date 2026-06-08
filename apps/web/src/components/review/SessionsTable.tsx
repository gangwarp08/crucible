"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { listReviewSessions, type ReviewSession } from "@/lib/api";
import StatusBadge from "./StatusBadge";

type SortKey = "created_at" | "spend_usd" | "duration_ms";
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
        color: active ? "#ffffff" : "#858585",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        userSelect: "none",
        borderBottom: "1px solid #404040",
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
          color: "#f48771",
          background: "#252526",
          border: "1px solid #404040",
          borderRadius: 6,
        }}
      >
        <div style={{ fontSize: 14, marginBottom: 12 }}>Failed to load sessions</div>
        <div style={{ fontSize: 12, color: "#858585", marginBottom: 16 }}>{error}</div>
        <button
          onClick={() => void load()}
          style={{
            background: "#0e639c",
            color: "#fff",
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
      <div style={{ background: "#252526", border: "1px solid #404040", borderRadius: 6, overflow: "hidden" }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid #353535",
              display: "flex",
              gap: 16,
              opacity: 0.4 - i * 0.08,
            }}
          >
            {[80, 120, 80, 60, 60, 50, 50, 50].map((w, j) => (
              <div key={j} style={{ width: w, height: 10, background: "#404040", borderRadius: 4 }} />
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
          color: "#858585",
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
              background: "#3c3c3c",
              color: "#cccccc",
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
            color: "#858585",
            background: "#252526",
            border: "1px solid #404040",
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
            background: "#252526",
            border: "1px solid #404040",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead style={{ background: "#2d2d2d" }}>
              <tr>
                <th style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#858585", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #404040" }}>
                  Session
                </th>
                <th style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#858585", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #404040" }}>
                  Status
                </th>
                <SortHeader label="Created"  sortKey="created_at"  currentKey={sortKey} currentDir={sortDir} align="left"  onSort={handleSort} />
                <th style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#858585", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #404040" }}>
                  Ended
                </th>
                <SortHeader label="Duration" sortKey="duration_ms" currentKey={sortKey} currentDir={sortDir} align="right" onSort={handleSort} />
                <SortHeader label="Spend"    sortKey="spend_usd"   currentKey={sortKey} currentDir={sortDir} align="right" onSort={handleSort} />
                <th style={{ textAlign: "right", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#858585", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #404040" }}>
                  Msgs
                </th>
                <th style={{ textAlign: "right", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#858585", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #404040" }}>
                  Files
                </th>
                <th style={{ textAlign: "right", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#858585", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #404040" }}>
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
    fontFamily: "monospace",
    color: "#cccccc",
  };
  const cell: React.CSSProperties = { padding: "10px 14px", color: "#cccccc" };

  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? "#2a2d2e" : "transparent",
        borderBottom: "1px solid #353535",
        transition: "background 0.1s",
      }}
    >
      <td style={cell}>
        <Link
          href={`/review/${s.id}`}
          style={{
            color: hover ? "#4ec9ff" : "#3794ff",
            textDecoration: "none",
            fontFamily: "monospace",
            fontSize: 12,
          }}
        >
          {s.id.slice(0, 8)}…
        </Link>
      </td>
      <td style={cell}>
        <StatusBadge status={s.status} />
      </td>
      <td style={{ ...cell, color: "#858585", fontSize: 12, whiteSpace: "nowrap" }}>
        {formatDate(s.created_at)}
      </td>
      <td style={{ ...cell, color: "#858585", fontSize: 12, whiteSpace: "nowrap" }}>
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
