"use client";
import { useMemo, useState } from "react";
import {
  postEvaluate,
  type ReviewEvaluation,
  type ReviewEvaluationItem,
  type ReviewEvent,
} from "@/lib/api";
import { scoreColor, prettyCompetency, asNumber, formatDateTime } from "./format";
import { scrollToHighlight } from "./Timeline";

interface Props {
  evaluation: ReviewEvaluation | null;
  sessionId: string;
  events: ReviewEvent[];
  onRefetch: () => Promise<void> | void;
}

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error"; message: string };

export default function Scorecard({ evaluation, sessionId, events, onRefetch }: Props) {
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

  const overall = evaluation ? asNumber(evaluation.overall_score) : null;
  const overallColor = scoreColor(overall);

  return (
    <section
      style={{
        background: "#252526",
        border: "1px solid #404040",
        borderRadius: 6,
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: "12px 16px",
          background: "#2d2d2d",
          borderBottom: "1px solid #404040",
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
            color: "#858585",
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
            <span style={{ fontSize: 13, color: "#858585", marginLeft: -10 }}>/ 5.00</span>
            <span style={{ fontSize: 11, color: "#666" }}>
              · {evaluation.model ?? "model unknown"}
              · {formatDateTime(evaluation.created_at)}
            </span>
          </>
        )}

        {evaluation && evaluation.status === "error" && (
          <span style={{ fontSize: 12, color: "#f48771", fontWeight: 500 }}>
            Evaluation errored — re-run to retry
          </span>
        )}

        {!evaluation && (
          <span style={{ fontSize: 12, color: "#666", fontStyle: "italic" }}>
            Not yet evaluated
          </span>
        )}

        <div style={{ flex: 1 }} />

        <button
          onClick={() => void reevaluate()}
          disabled={run.kind === "running"}
          style={{
            background: run.kind === "running" ? "#37373d" : "#0e639c",
            color: run.kind === "running" ? "#888" : "#fff",
            border: "none",
            borderRadius: 4,
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
              background: "#3a1e1e",
              color: "#f48771",
              padding: "8px 12px",
              borderRadius: 4,
              fontSize: 12,
              marginBottom: 12,
              fontFamily: "'SF Mono', Menlo, Consolas, monospace",
              wordBreak: "break-word",
            }}
          >
            {run.message}
          </div>
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

// ─── States ────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      style={{
        padding: "32px 16px",
        textAlign: "center",
        color: "#858585",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      No evaluation has been run for this session yet.
      <br />
      <span style={{ fontSize: 12, color: "#666" }}>
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
        background: "#3a1e1e",
        border: "1px solid #5a2828",
        borderRadius: 4,
        color: "#f48771",
        fontSize: 12,
        lineHeight: 1.55,
        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
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
  const sortedItems = useMemo(() => {
    return [...evaluation.items].sort(
      (a, b) => b.score * b.weight - a.score * a.weight,
    );
  }, [evaluation.items]);

  return (
    <div>
      {evaluation.summary && (
        <p
          style={{
            margin: "0 0 16px",
            padding: "10px 14px",
            background: "#1e1e1e",
            border: "1px solid #353535",
            borderRadius: 4,
            color: "#cccccc",
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
  const color = scoreColor(item.score);
  const stars = "★".repeat(item.score) + "☆".repeat(5 - item.score);

  return (
    <div
      style={{
        background: "#1e1e1e",
        border: "1px solid #353535",
        borderRadius: 4,
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
        <span style={{ fontSize: 13, fontWeight: 600, color: "#cccccc" }}>
          {prettyCompetency(item.competency)}
        </span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {item.score}/5
        </span>
        <span style={{ fontSize: 11, color, letterSpacing: 1 }}>{stars}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "#666" }}>
          weight × {item.weight.toFixed(2)}
        </span>
      </div>

      {/* Rationale */}
      <div
        style={{
          fontSize: 12,
          color: "#cccccc",
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
        background: linkable ? "#252526" : "#1e1e1e",
        border: `1px solid ${linkable ? "#404040" : "#2d2d2d"}`,
        borderRadius: 4,
        padding: "4px 8px",
        fontSize: 11,
        color: linkable ? "#cccccc" : "#666",
        cursor: linkable ? "pointer" : "not-allowed",
        opacity: linkable ? 1 : 0.5,
        fontFamily: "inherit",
        textAlign: "left",
        maxWidth: "100%",
      }}
    >
      <span
        style={{
          color: linkable ? "#3794ff" : "#666",
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        seq {eventSeq}
      </span>
      <span style={{ color: "#666", flexShrink: 0 }}>·</span>
      <span style={{ color: "#666", fontSize: 10, flexShrink: 0 }}>{summary}</span>
      {note && (
        <>
          <span style={{ color: "#666", flexShrink: 0 }}>·</span>
          <span
            style={{
              color: "#cccccc",
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
