"use client";
import Link from "next/link";
import type { ReviewSessionDetail } from "@/lib/api";
import StatusBadge from "./StatusBadge";
import {
  formatDuration,
  formatSpend,
  formatDateTime,
} from "./format";

interface Props {
  detail: ReviewSessionDetail;
}

function Stat({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: "#5E6B64",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          color: "#28352F",
          fontFamily: mono ? "monospace" : "inherit",
          fontVariantNumeric: mono ? "tabular-nums" : "normal",
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default function SessionSummary({ detail }: Props) {
  const { session } = detail;
  const messages = detail.transcript.filter((t) => t.role !== "system").length;
  const fileSaves = detail.fileSnapshots.length;

  return (
    <section
      style={{
        background: "#FBF6EA",
        border: "1px solid #DED3BF",
        borderRadius: 6,
        padding: 20,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Link
            href="/review"
            style={{
              color: "#C67C5B",
              textDecoration: "none",
              fontSize: 13,
            }}
          >
            ← Back
          </Link>
          <span style={{ color: "#8A9389" }}>·</span>
          <span
            style={{
              fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
              fontSize: 13,
              color: "#28352F",
            }}
          >
            {session.id}
          </span>
          <StatusBadge status={session.status} size="md" />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 20,
        }}
      >
        <Stat label="Created"     value={formatDateTime(session.created_at)} />
        <Stat label="Ended"       value={formatDateTime(session.ended_at)} />
        <Stat label="Duration"    value={formatDuration(session.duration_ms)} mono />
        <Stat label="End reason"  value={session.end_reason ?? "—"} />
        <Stat label="Model"       value={session.model ?? "—"} mono />
        <Stat label="Total spend" value={formatSpend(session.spend_usd)} mono />
        <Stat label="Messages"    value={messages} mono />
        <Stat label="File saves"  value={fileSaves} mono />
      </div>
    </section>
  );
}
