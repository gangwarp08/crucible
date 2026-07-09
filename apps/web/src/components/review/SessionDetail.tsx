"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  getSuspicionReport,
  postEvaluate,
  type ReviewEvent,
  type ReviewSessionDetail,
  type SuspicionReport,
} from "@/lib/api";
import { color, font, radius, scoreColor } from "@/styles/tokens";
import Stat from "@/components/ui/Stat";
import TabStrip, { type TabSpec } from "@/components/ui/TabStrip";
import StatusBadge from "./StatusBadge";
import { asNumber, formatDateTime, formatDuration, formatSpend } from "./format";
import Scorecard from "./Scorecard";
import ShareReportModal from "./ShareReportModal";
import OutcomeInvitePanel from "./OutcomeInvitePanel";
import TranscriptPanel from "./TranscriptPanel";
import PersonaMessagesPanel from "./PersonaMessagesPanel";
import SqlHistoryPanel from "./SqlHistoryPanel";
import FilesDiffPanel from "./FilesDiffPanel";
import Timeline, { REVEAL_EVENT, scrollToHighlight } from "./Timeline";
import CostPanel from "./CostPanel";
import SuspicionPanel, { suspicionColor } from "./SuspicionPanel";

// xterm needs the browser — load client-side only.
const TerminalReplay = dynamic(() => import("./TerminalReplay"), { ssr: false });

interface Props {
  detail: ReviewSessionDetail;
  /** Refetches the full detail (incl. evaluation + new ai.evaluation event)
   *  from the server. Wired from SessionDetailLoader's load() so the
   *  Scorecard's / header's Re-evaluate button can refresh in place. */
  onRefetch: () => Promise<void> | void;
}

// ─── Evidence tabs ───────────────────────────────────────────────────────────

type EvidenceTab = "chat" | "persona" | "sql" | "files" | "terminal";

/** Mirror of PersonaMessagesPanel's parseMessages validity rules so the tab's
 *  badge/disabled state matches exactly what the panel would render. */
function personaMessageCount(events: ReviewEvent[]): number {
  let n = 0;
  for (const e of events) {
    const parts = e.type.split(".");
    if (parts.length !== 3 || parts[0] !== "message") continue;
    if (parts[1] !== "team" && parts[1] !== "client") continue;
    if (parts[2] !== "candidate" && parts[2] !== "persona") continue;
    if (typeof (e.payload ?? {})["text"] !== "string") continue;
    n++;
  }
  return n;
}

/** Mirror of SqlHistoryPanel's parseQueries validity rule (db.query with a
 *  string sql payload). */
function sqlQueryCount(events: ReviewEvent[]): number {
  return events.filter(
    (e) => e.type === "db.query" && typeof (e.payload ?? {})["sql"] === "string",
  ).length;
}

// ─── Layout ──────────────────────────────────────────────────────────────────

/* Inline styles can't express media queries, so the two-column shell uses a
 * scoped <style> block. Below 1100px the right rail collapses to a stacked
 * full-width column under the main content. */
const LAYOUT_CSS = `
.sd-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 400px;
  gap: 16px;
  align-items: start;
}
.sd-rail {
  position: sticky;
  top: 16px;
  /* The rail can outgrow the viewport (suspicion + timeline + cost +
     outcomes); keep it sticky but let it scroll internally. */
  max-height: calc(100vh - 32px);
  overflow-y: auto;
}
@media (max-width: 1100px) {
  .sd-grid { grid-template-columns: minmax(0, 1fr); }
  .sd-rail { position: static; max-height: none; overflow-y: visible; }
}
`;

export default function SessionDetail({ detail, onRefetch }: Props) {
  const [tab, setTab] = useState<EvidenceTab>("chat");
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const messages = detail.transcript.filter((t) => t.role !== "system").length;
  const personaCount = personaMessageCount(detail.events);
  const sqlCount = sqlQueryCount(detail.events);
  const ptyFrames = detail.events.filter((e) => e.type === "pty.output").length;

  // Cross-tab scroll links: Timeline rows and Scorecard evidence chips call
  // scrollToHighlight() whose targets (`turn-*` in the AI-chat transcript,
  // `file-*` in the files panel) may live in a hidden/unmounted tab. The
  // helper announces the target id via REVEAL_EVENT; we switch to the owning
  // tab and retry the scroll once it has rendered.
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  useEffect(() => {
    function onReveal(e: Event) {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id !== "string") return;
      const target: EvidenceTab | null = id.startsWith("turn-")
        ? "chat"
        : id.startsWith("file-")
          ? "files"
          : null; // `event-*` lives in the always-mounted Timeline
      if (target !== null && target !== tabRef.current) {
        setTab(target);
        setPendingScroll(id);
      }
    }
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, []);
  useEffect(() => {
    if (pendingScroll === null) return;
    // One frame after the tab switch committed, the target is visible.
    const raf = requestAnimationFrame(() => {
      scrollToHighlight(pendingScroll);
      setPendingScroll(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingScroll]);

  const tabs: ReadonlyArray<TabSpec<EvidenceTab>> = [
    { id: "chat", label: "AI Chat", badge: messages },
    // Persona/SQL panels render nothing for sessions without that traffic
    // (they read straight from the detail bundle's event list) — surface that
    // as a disabled tab instead of an empty pane.
    { id: "persona", label: "Team/Client", badge: personaCount, disabled: personaCount === 0 },
    { id: "sql", label: "SQL", badge: sqlCount, disabled: sqlCount === 0 },
    { id: "files", label: "Files", badge: detail.fileSnapshots.length },
    { id: "terminal", label: "Terminal", badge: ptyFrames },
  ];

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
      <style>{LAYOUT_CSS}</style>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <OverviewHeader detail={detail} onRefetch={onRefetch} />

        <div className="sd-grid">
          {/* Main column: assessment first, then the heavy evidence panels
              behind tabs. */}
          <div style={{ minWidth: 0 }}>
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

            <div
              style={{
                border: `1px solid ${color.border.default}`,
                borderRadius: radius.md,
                overflow: "hidden",
                marginBottom: 12,
              }}
            >
              <TabStrip tabs={tabs} value={tab} onChange={setTab} />
            </div>

            {/* Mounting policy, per panel:
                - chat / persona / sql / files stay MOUNTED and are hidden with
                  display:none — they hold interactive state worth keeping
                  across tab switches (transcript system-prompt toggle, persona
                  channel selection, expanded SQL rows, files path/step
                  selection) and their DOM anchors (turn-*, file-*) must exist
                  for Timeline / evidence-chip scroll links. Monaco is safe
                  hidden: FilesDiffPanel passes automaticLayout:true, so it
                  re-measures when revealed.
                - terminal mounts ONLY while active: xterm + FitAddon measure
                  the container at mount, and a display:none container measures
                  0×0 (broken glyph grid). The replay is deterministic — the
                  mount effect rewrites every pty.output frame — so remounting
                  loses nothing but scrollback position. */}
            <div id="panel-chat" style={{ display: tab === "chat" ? "block" : "none" }}>
              <TranscriptPanel transcript={detail.transcript} />
            </div>
            <div id="panel-persona" style={{ display: tab === "persona" ? "block" : "none" }}>
              <PersonaMessagesPanel events={detail.events} />
            </div>
            <div id="panel-sql" style={{ display: tab === "sql" ? "block" : "none" }}>
              <SqlHistoryPanel events={detail.events} sessionStart={detail.session.created_at} />
            </div>
            <div id="panel-files" style={{ display: tab === "files" ? "block" : "none" }}>
              <FilesDiffPanel fileSnapshots={detail.fileSnapshots} />
            </div>
            <div id="panel-terminal">
              {tab === "terminal" && <TerminalReplay events={detail.events} />}
            </div>
          </div>

          {/* Right rail: partner feedback first (operator request), then
              integrity, timeline, cost. */}
          <div className="sd-rail">
            <OutcomeInvitePanel
              sessionId={detail.session.id}
              overallScore={
                detail.evaluation && detail.evaluation.status === "complete"
                  ? Number(detail.evaluation.overall_score)
                  : null
              }
            />
            {/* Proctoring v1 — informational integrity signals, never scored.
                Renders nothing on older servers without the suspicion route. */}
            <SuspicionPanel
              sessionId={detail.session.id}
              events={detail.events}
              sessionStart={detail.session.created_at}
            />
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

// ─── Overview header ─────────────────────────────────────────────────────────
// Compact identity + status + headline numbers + primary actions, with the
// full SessionSummary stat grid folded into a collapsible "Details" row so no
// information is lost.

type RunState = { kind: "idle" } | { kind: "running" } | { kind: "error"; message: string };

function OverviewHeader({ detail, onRefetch }: Props) {
  const { session } = detail;
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Header re-evaluate mirrors Scorecard's handler (postEvaluate → onRefetch);
  // both buttons coexist and both refresh the whole detail in place.
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  async function reevaluate() {
    setRun({ kind: "running" });
    try {
      await postEvaluate(session.id);
      await onRefetch();
      setRun({ kind: "idle" });
    } catch (err) {
      setRun({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Suspicion score chip. The suspicion report is not part of the detail
  // bundle (SuspicionPanel fetches its own); this is a second, cheap GET of
  // the same endpoint — null (older server / no report) hides the chip.
  const [suspicion, setSuspicion] = useState<SuspicionReport | null>(null);
  useEffect(() => {
    let alive = true;
    void getSuspicionReport(session.id).then((r) => {
      if (alive) setSuspicion(r);
    });
    return () => {
      alive = false;
    };
  }, [session.id]);

  const overall =
    detail.evaluation && detail.evaluation.status === "complete"
      ? asNumber(detail.evaluation.overall_score)
      : null;

  const messages = detail.transcript.filter((t) => t.role !== "system").length;
  const fileSaves = detail.fileSnapshots.length;

  return (
    <section
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        padding: "12px 16px",
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Link
          href="/review"
          style={{ color: color.accent.base, textDecoration: "none", fontSize: 13, flexShrink: 0 }}
        >
          ← Back
        </Link>
        <span style={{ color: color.text.muted }}>·</span>
        <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text.primary }}>
          {session.id}
        </span>
        <StatusBadge status={session.status} size="md" />

        <span style={{ color: color.text.muted }}>·</span>
        <HeaderStat label="Started" value={formatDateTime(session.created_at)} />
        <HeaderStat label="Duration" value={formatDuration(session.duration_ms)} mono />
        {overall !== null && (
          <Chip label="Score" value={`${overall.toFixed(2)} / 5`} tone={scoreColor(overall)} />
        )}
        {suspicion !== null && (
          <Chip
            label="Suspicion"
            value={`${suspicion.score} / 100`}
            tone={suspicionColor(suspicion.score)}
          />
        )}

        <div style={{ flex: 1 }} />

        <button
          onClick={() => void reevaluate()}
          disabled={run.kind === "running"}
          style={{
            background: run.kind === "running" ? color.bg.elevated : color.accent.base,
            color: run.kind === "running" ? color.text.secondary : color.text.inverse,
            border: "none",
            borderRadius: radius.lg,
            padding: "6px 14px",
            fontSize: 12,
            cursor: run.kind === "running" ? "not-allowed" : "pointer",
          }}
        >
          {run.kind === "running"
            ? "Re-evaluating…"
            : detail.evaluation
              ? "Re-evaluate"
              : "Run evaluation"}
        </button>
        {/* P4.3: tokenized shareable candidate report (external-safe subset). */}
        <ShareReportModal sessionId={session.id} />
        <button
          onClick={() => setDetailsOpen((o) => !o)}
          aria-expanded={detailsOpen}
          style={{
            background: "transparent",
            color: color.text.secondary,
            border: `1px solid ${color.border.default}`,
            borderRadius: radius.lg,
            padding: "6px 12px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Details {detailsOpen ? "▴" : "▾"}
        </button>
      </div>

      {run.kind === "error" && (
        <div
          style={{
            marginTop: 10,
            background: color.error.soft,
            color: color.error.base,
            padding: "8px 12px",
            borderRadius: radius.lg,
            fontSize: 12,
            fontFamily: font.mono,
            wordBreak: "break-word",
          }}
        >
          {run.message}
        </div>
      )}

      {detailsOpen && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 16,
            marginTop: 14,
            paddingTop: 14,
            borderTop: `1px solid ${color.border.subtle}`,
          }}
        >
          {/* Full former-SessionSummary stat grid — nothing dropped. */}
          <Stat label="Created" value={formatDateTime(session.created_at)} />
          <Stat label="Ended" value={formatDateTime(session.ended_at)} />
          {/* P5.1: effective difficulty band stamped at creation */}
          <Stat label="Band" value={session.difficulty_band ?? "—"} />
          <Stat label="Duration" value={formatDuration(session.duration_ms)} />
          <Stat label="End reason" value={session.end_reason ?? "—"} />
          <Stat label="Model" value={session.model ?? "—"} />
          <Stat label="Total spend" value={formatSpend(session.spend_usd)} />
          <Stat label="Messages" value={messages} />
          <Stat label="File saves" value={fileSaves} />
        </div>
      )}
    </section>
  );
}

function HeaderStat({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6, fontSize: 12 }}>
      <span
        style={{
          fontSize: 10,
          color: color.text.secondary,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: color.text.primary,
          fontFamily: mono ? font.mono : "inherit",
          fontVariantNumeric: mono ? "tabular-nums" : "normal",
        }}
      >
        {value}
      </span>
    </span>
  );
}

/** Small colored pill for the headline score / suspicion numbers. */
function Chip({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: radius.pill,
        border: `1px solid ${tone}`,
        fontSize: 11,
      }}
    >
      <span
        style={{
          color: color.text.secondary,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontSize: 10,
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: tone,
          fontWeight: 600,
          fontFamily: font.mono,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </span>
  );
}
