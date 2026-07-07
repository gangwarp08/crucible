"use client";
import dynamic from "next/dynamic";
import type { ReviewSessionDetail } from "@/lib/api";
import { color, font } from "@/styles/tokens";
import SessionSummary from "./SessionSummary";
import Scorecard from "./Scorecard";
import OutcomeInvitePanel from "./OutcomeInvitePanel";
import TranscriptPanel from "./TranscriptPanel";
import FilesDiffPanel from "./FilesDiffPanel";
import Timeline from "./Timeline";
import CostPanel from "./CostPanel";
import SuspicionPanel from "./SuspicionPanel";

// xterm and Monaco need the browser — load these client-side only.
const TerminalReplay = dynamic(() => import("./TerminalReplay"), { ssr: false });

interface Props {
  detail: ReviewSessionDetail;
  /** Refetches the full detail (incl. evaluation + new ai.evaluation event)
   *  from the server. Wired from SessionDetailLoader's load() so the
   *  Scorecard's Re-evaluate button can refresh in place. */
  onRefetch: () => Promise<void> | void;
}

export default function SessionDetail({ detail, onRefetch }: Props) {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: color.bg.page,
        color: color.text.primary,
        fontFamily: font.sans,
        padding: "24px 32px",
      }}
    >
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <SessionSummary detail={detail} />

        <Scorecard
          evaluation={detail.evaluation}
          sessionId={detail.session.id}
          defenseOutcome={detail.session.defense_outcome ?? null}
          verificationCapStatus={detail.session.verification_cap_status ?? null}
          scorable={detail.session.scorable ?? null}
          exclusionReason={detail.session.exclusion_reason ?? null}
          events={detail.events}
          onRefetch={onRefetch}
        />

        {/* Proctoring v1 — informational integrity signals, never scored.
            Renders nothing on older servers without the suspicion route. */}
        <SuspicionPanel
          sessionId={detail.session.id}
          events={detail.events}
          sessionStart={detail.session.created_at}
        />

        <OutcomeInvitePanel
          sessionId={detail.session.id}
          overallScore={
            detail.evaluation && detail.evaluation.status === "complete"
              ? Number(detail.evaluation.overall_score)
              : null
          }
        />

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
