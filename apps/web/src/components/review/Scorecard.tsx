"use client";
import { useMemo, useState, type CSSProperties } from "react";
import {
  postEvaluate,
  postVerificationCap,
  type ReviewEvaluation,
  type ReviewEvaluationItem,
  type ReviewEvent,
} from "@/lib/api";
import { prettyCompetency, asNumber, formatDateTime } from "./format";
import { scrollToHighlight } from "./Timeline";
import { color, radius, font, scoreColor } from "@/styles/tokens";

interface Props {
  evaluation: ReviewEvaluation | null;
  sessionId: string;
  defenseOutcome?: string | null;
  verificationCapStatus?: string | null;
  scorable?: boolean | null;
  exclusionReason?: string | null;
  events: ReviewEvent[];
  onRefetch: () => Promise<void> | void;
}

const EXCLUSION_COPY: Record<string, string> = {
  excluded_infra: "Infrastructure / abnormal termination — not the candidate's signal",
  excluded_abandoned: "Too little engagement to be a real attempt",
  excluded_no_deliverable: "Engaged, but submitted nothing to score",
  excluded_defense_unreachable: "Defense never reached the candidate (verifier / deadline / UI)",
  excluded_insufficient_evidence: "Too few load-bearing competencies were surfaced",
};

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error"; message: string };

export default function Scorecard({
  evaluation,
  sessionId,
  defenseOutcome,
  verificationCapStatus,
  scorable,
  exclusionReason,
  events,
  onRefetch,
}: Props) {
  const [run, setRun] = useState<RunState>({ kind: "idle" });

  // For evidence-chip wiring: build the set of seqs + a seq→event lookup so
  // we can render rich context (actor / type) on the chip itself.
  const eventBySeq = useMemo(() => {
    const m = new Map<number, ReviewEvent>();
    for (const e of events) m.set(e.seq, e);
    return m;
  }, [events]);

  async function reevaluate() {
    setRun({ kind: "running" });
    try {
      await postEvaluate(sessionId);
      await onRefetch();
      setRun({ kind: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRun({ kind: "error", message });
    }
  }

  const [cap, setCap] = useState<RunState>({ kind: "idle" });
  async function resolveCap(decision: "confirm" | "override") {
    setCap({ kind: "running" });
    try {
      await postVerificationCap(sessionId, decision);
      await onRefetch();
      setCap({ kind: "idle" });
    } catch (err) {
      setCap({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const overall = evaluation ? asNumber(evaluation.overall_score) : null;
  const overallColor = overall !== null ? scoreColor(overall) : color.text.muted;

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
      {/* Header */}
      <header
        style={{
          padding: "12px 16px",
          background: color.bg.elevated,
          borderBottom: `1px solid ${color.border.default}`,
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
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
          Assessment
        </span>

        {evaluation && evaluation.status === "complete" && overall !== null && (
          <>
            <span
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: overallColor,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {overall.toFixed(2)}
            </span>
            <span style={{ fontSize: 13, color: color.text.secondary, marginLeft: -10 }}>/ 5.00</span>
            <span style={{ fontSize: 11, color: color.text.muted }}>
              · {evaluation.model ?? "model unknown"}
              · {formatDateTime(evaluation.created_at)}
            </span>
          </>
        )}

        {evaluation && evaluation.status === "error" && (
          <span style={{ fontSize: 12, color: color.error.base, fontWeight: 500 }}>
            Evaluation errored — re-run to retry
          </span>
        )}

        {!evaluation && (
          <span style={{ fontSize: 12, color: color.text.muted, fontStyle: "italic" }}>
            Not yet evaluated
          </span>
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
            : evaluation
              ? "Re-evaluate"
              : "Run evaluation"}
        </button>
      </header>

      {/* Body */}
      <div style={{ padding: 16 }}>
        {run.kind === "error" && (
          <div
            style={{
              background: color.error.soft,
              color: color.error.base,
              padding: "8px 12px",
              borderRadius: radius.lg,
              fontSize: 12,
              marginBottom: 12,
              fontFamily: font.mono,
              wordBreak: "break-word",
            }}
          >
            {run.message}
          </div>
        )}

        {scorable === false && exclusionReason && (
          <div
            style={{
              background: color.accent.soft,
              border: `1px solid ${color.accent.glow}`,
              borderRadius: radius.lg,
              padding: "10px 14px",
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: color.accent.base, letterSpacing: "0.04em" }}>
              EXCLUDED FROM VALIDITY DATASET · {exclusionReason}
            </div>
            <div style={{ fontSize: 11.5, color: color.text.secondary, marginTop: 5, lineHeight: 1.5 }}>
              {EXCLUSION_COPY[exclusionReason] ?? "This session does not meet the scorable floor."}{" "}
              Any score below is informational only — it is NOT counted toward partner-facing
              aggregates and must never be read as &quot;weak candidate.&quot;
            </div>
          </div>
        )}

        {(verificationCapStatus === "advisory_pending" ||
          verificationCapStatus === "confirmed" ||
          verificationCapStatus === "overridden") && (
          <VerificationCapBanner
            status={verificationCapStatus}
            defenseOutcome={defenseOutcome ?? null}
            cap={cap}
            onResolve={(d) => { void resolveCap(d); }}
          />
        )}

        {!evaluation ? (
          <EmptyState />
        ) : evaluation.status === "error" ? (
          <ErrorState summary={evaluation.summary} />
        ) : (
          <CompleteScorecard
            evaluation={evaluation}
            eventBySeq={eventBySeq}
          />
        )}
      </div>
    </section>
  );
}

// ─── Verification advisory cap (RD2, Slice 6.3) ──────────────────────────────

function VerificationCapBanner({
  status,
  defenseOutcome,
  cap,
  onResolve,
}: {
  status: string;
  defenseOutcome: string | null;
  cap: RunState;
  onResolve: (decision: "confirm" | "override") => void;
}) {
  const pending = status === "advisory_pending";
  // warn tone for pending action, neutral once resolved
  const accent = pending ? color.warn.base : status === "confirmed" ? color.error.base : color.text.muted;
  const reason =
    defenseOutcome === "declined"
      ? "The candidate declined to defend their key decisions"
      : "The candidate could not coherently defend their key decisions";

  return (
    <div
      style={{
        background: pending ? color.warn.soft : color.bg.page,
        border: `1px solid ${pending ? color.warn.base : color.border.subtle}`,
        borderRadius: radius.lg,
        padding: "10px 14px",
        marginBottom: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: accent, letterSpacing: "0.04em" }}>
          {pending
            ? "ADVISORY CAP PENDING"
            : status === "confirmed"
              ? "VERIFICATION CAP APPLIED"
              : "VERIFICATION CAP OVERRIDDEN"}
        </span>
        {defenseOutcome && (
          <span style={{ fontSize: 11, color: color.text.secondary }}>defense: {defenseOutcome}</span>
        )}
        <div style={{ flex: 1 }} />
        {pending && (
          <>
            <button
              onClick={() => onResolve("confirm")}
              disabled={cap.kind === "running"}
              style={capBtn(color.error.base, cap.kind === "running")}
            >
              {cap.kind === "running" ? "…" : "Confirm cap (exec → 3)"}
            </button>
            <button
              onClick={() => onResolve("override")}
              disabled={cap.kind === "running"}
              style={capBtn(color.accent.base, cap.kind === "running")}
            >
              Override (keep score)
            </button>
          </>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: color.text.secondary, marginTop: 6, lineHeight: 1.5 }}>
        {pending
          ? `${reason}. The score below is UNCAPPED — confirm to cap execution at 3 and recompute the overall, or override to keep it as judged.`
          : status === "confirmed"
            ? "Execution was capped at 3 and the overall score recomputed."
            : "A reviewer kept the as-judged score despite a weak defense."}
      </div>
      {cap.kind === "error" && (
        <div style={{ fontSize: 11, color: color.error.base, marginTop: 6 }}>{cap.message}</div>
      )}
    </div>
  );
}

function capBtn(bg: string, disabled: boolean): CSSProperties {
  return {
    background: disabled ? color.bg.elevated : bg,
    color: disabled ? color.text.secondary : color.text.inverse,
    border: "none",
    borderRadius: radius.lg,
    padding: "5px 12px",
    fontSize: 11.5,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

// ─── States ────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      style={{
        padding: "32px 16px",
        textAlign: "center",
        color: color.text.secondary,
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      No evaluation has been run for this session yet.
      <br />
      <span style={{ fontSize: 12, color: color.text.muted }}>
        Sessions without a scenario can&apos;t be evaluated.
      </span>
    </div>
  );
}

function ErrorState({ summary }: { summary: string | null }) {
  return (
    <div
      style={{
        padding: 16,
        background: color.error.soft,
        border: `1px solid ${color.error.base}`,
        borderRadius: radius.lg,
        color: color.error.base,
        fontSize: 12,
        lineHeight: 1.55,
        fontFamily: font.mono,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {summary ?? "Evaluation failed without a recorded reason."}
    </div>
  );
}

// ─── Complete scorecard ────────────────────────────────────────────────────

function CompleteScorecard({
  evaluation,
  eventBySeq,
}: {
  evaluation: ReviewEvaluation;
  eventBySeq: Map<number, ReviewEvent>;
}) {
  // Sort items by score × weight (descending) so the most-impactful
  // judgments come first. Recruiters can eyeball the top 3 to see what
  // moved the overall score.
  // Assessed items first (sorted by impact); not_assessed sink to the bottom.
  const sortedItems = useMemo(() => {
    const impact = (it: ReviewEvaluationItem) =>
      it.assessed === false || it.score === null ? -1 : it.score * it.weight;
    return [...evaluation.items].sort((a, b) => impact(b) - impact(a));
  }, [evaluation.items]);

  return (
    <div>
      {evaluation.summary && (
        <p
          style={{
            margin: "0 0 16px",
            padding: "10px 14px",
            background: color.bg.page,
            border: `1px solid ${color.border.subtle}`,
            borderRadius: radius.lg,
            color: color.text.primary,
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          {evaluation.summary}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sortedItems.map((item) => (
          <ItemCard key={item.competency} item={item} eventBySeq={eventBySeq} />
        ))}
      </div>
    </div>
  );
}

function ItemCard({
  item,
  eventBySeq,
}: {
  item: ReviewEvaluationItem;
  eventBySeq: Map<number, ReviewEvent>;
}) {
  const notAssessed = item.assessed === false || item.score === null;
  const itemColor = notAssessed ? color.text.muted : scoreColor(item.score as number);
  const stars = notAssessed
    ? ""
    : "★".repeat(item.score as number) + "☆".repeat(5 - (item.score as number));

  return (
    <div
      style={{
        background: color.bg.page,
        border: `1px solid ${color.border.subtle}`,
        borderRadius: radius.lg,
        padding: "10px 12px",
      }}
    >
      {/* Item header */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: color.text.primary }}>
          {prettyCompetency(item.competency)}
        </span>
        <span
          style={{
            fontSize: notAssessed ? 11 : 14,
            fontWeight: 600,
            color: itemColor,
            fontVariantNumeric: "tabular-nums",
            textTransform: notAssessed ? "uppercase" : "none",
            letterSpacing: notAssessed ? "0.04em" : undefined,
          }}
        >
          {notAssessed ? "Not assessed" : `${item.score}/5`}
        </span>
        {!notAssessed && (
          <span style={{ fontSize: 11, color: itemColor, letterSpacing: 1 }}>{stars}</span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: color.text.muted }}>
          weight × {item.weight.toFixed(2)}
        </span>
      </div>

      {/* Rationale */}
      <div
        style={{
          fontSize: 12,
          color: color.text.primary,
          lineHeight: 1.55,
          marginBottom: item.evidence.length > 0 ? 8 : 0,
        }}
      >
        {item.rationale || "(no rationale)"}
      </div>

      {/* Evidence */}
      {item.evidence.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {item.evidence.map((ev, i) => (
            <EvidenceChip
              key={i}
              eventSeq={ev.event_seq}
              note={ev.note}
              event={eventBySeq.get(ev.event_seq)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EvidenceChip({
  eventSeq,
  note,
  event,
}: {
  eventSeq: number;
  note: string;
  event: ReviewEvent | undefined;
}) {
  const linkable = event !== undefined;
  const summary = event
    ? `${event.actor} · ${event.type}`
    : "not in loaded events";

  return (
    <button
      type="button"
      onClick={linkable ? () => { scrollToHighlight(`event-${eventSeq}`); } : undefined}
      disabled={!linkable}
      title={linkable ? `Scroll to event ${eventSeq} (${summary})` : "Event seq not in loaded window"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: linkable ? color.bg.panel : color.bg.page,
        border: `1px solid ${linkable ? color.border.default : color.border.subtle}`,
        borderRadius: radius.lg,
        padding: "4px 8px",
        fontSize: 11,
        color: linkable ? color.text.primary : color.text.muted,
        cursor: linkable ? "pointer" : "not-allowed",
        opacity: linkable ? 1 : 0.5,
        fontFamily: "inherit",
        textAlign: "left",
        maxWidth: "100%",
      }}
    >
      <span
        style={{
          color: linkable ? color.accent.base : color.text.muted,
          fontFamily: font.mono,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        seq {eventSeq}
      </span>
      <span style={{ color: color.text.muted, flexShrink: 0 }}>·</span>
      <span style={{ color: color.text.muted, fontSize: 10, flexShrink: 0 }}>{summary}</span>
      {note && (
        <>
          <span style={{ color: color.text.muted, flexShrink: 0 }}>·</span>
          <span
            style={{
              color: color.text.primary,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 360,
            }}
          >
            {note}
          </span>
        </>
      )}
    </button>
  );
}
