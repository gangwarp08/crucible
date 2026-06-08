"use client";
import dynamic from "next/dynamic";
import type { ReviewSessionDetail } from "@/lib/api";
import SessionSummary from "./SessionSummary";
import TranscriptPanel from "./TranscriptPanel";
import FilesDiffPanel from "./FilesDiffPanel";
import Timeline from "./Timeline";
import CostPanel from "./CostPanel";

// xterm and Monaco need the browser — load these client-side only.
const TerminalReplay = dynamic(() => import("./TerminalReplay"), { ssr: false });

interface Props {
  detail: ReviewSessionDetail;
}

export default function SessionDetail({ detail }: Props) {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#1e1e1e",
        color: "#cccccc",
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        padding: "24px 32px",
      }}
    >
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <SessionSummary detail={detail} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 420px",
            gap: 16,
            alignItems: "start",
          }}
        >
          {/* Left column: transcript + terminal + files diff */}
          <div style={{ minWidth: 0 }}>
            <TranscriptPanel transcript={detail.transcript} />
            <TerminalReplay events={detail.events} />
            <FilesDiffPanel fileSnapshots={detail.fileSnapshots} />
          </div>

          {/* Right column: timeline (sticky) + cost */}
          <div style={{ position: "sticky", top: 16 }}>
            <Timeline events={detail.events} sessionStart={detail.session.created_at} />
            <CostPanel
              cost={detail.cost}
              totalSpend={detail.session.spend_usd}
              budget={detail.session.budget_usd}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
