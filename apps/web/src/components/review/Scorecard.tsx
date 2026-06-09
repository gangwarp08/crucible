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
        background: "#15151b",
        border: "1px solid #2a2a36",
        borderRadius: 6,
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: "12px 16px",
          background: "#1c1c24",
          borderBottom: "1px solid #2a2a36",
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
            color: "#9999a3",
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
            <span style={{ fontSize: 13, color: "#9999a3", marginLeft: -10 }}>/ 5.00</span>
            <span style={{ fontSize: 11, color: "#6a6a78" }}>
              · {evaluation.model ?? "model unknown"}
              · {formatDateTime(evaluation.created_at)}
            </span>
          </>
        )}

        {evaluation && evaluation.status === "error" && (
          <span style={{ fontSize: 12, color: "#ff7a7a", fontWeight: 500 }}>
            Evaluation errored — re-run to retry
          </span>
        )}

        {!evaluation && (
          <span style={{ fontSize: 12, color: "#6a6a78", fontStyle: "italic" }}>
            Not yet evaluated
          </span>
        )}

        <div style={{ flex: 1 }} />

        <button
          onClick={() => void reevaluate()}
          disabled={run.kind === "running"}
          style={{
            background: run.kind === "running" ? "#1c1c24" : "#7c7fff",
            color: run.kind === "running" ? "#9999a3" : "#e6e6ea",
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
              background: "rgba(255, 122, 122, 0.10)",
              color: "#ff7a7a",
              padding: "8px 12px",
              borderRadius: 4,
              fontSize: 12,
              marginBottom: 12,
              fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
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
        color: "#9999a3",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      No evaluation has been run for this session yet.
      <br />
      <span style={{ fontSize: 12, color: "#6a6a78" }}>
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
        background: "rgba(255, 122, 122, 0.10)",
        border: "1px solid rgba(255, 122, 122, 0.30)",
        borderRadius: 4,
        color: "#ff7a7a",
        fontSize: 12,
        lineHeight: 1.55,
        fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
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
            background: "#0c0c10",
            border: "1px solid #22222b",
            borderRadius: 4,
            color: "#e6e6ea",
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
        background: "#0c0c10",
        border: "1px solid #22222b",
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
        <span style={{ fontSize: 13, fontWeight: 600, color: "#e6e6ea" }}>
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
        <span style={{ fontSize: 10, color: "#6a6a78" }}>
          weight × {item.weight.toFixed(2)}
        </span>
      </div>

      {/* Rationale */}
      <div
        style={{
          fontSize: 12,
          color: "#e6e6ea",
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
        background: linkable ? "#15151b" : "#0c0c10",
        border: `1px solid ${linkable ? "#2a2a36" : "#1c1c24"}`,
        borderRadius: 4,
        padding: "4px 8px",
        fontSize: 11,
        color: linkable ? "#e6e6ea" : "#6a6a78",
        cursor: linkable ? "pointer" : "not-allowed",
        opacity: linkable ? 1 : 0.5,
        fontFamily: "inherit",
        textAlign: "left",
        maxWidth: "100%",
      }}
    >
      <span
        style={{
          color: linkable ? "#7c7fff" : "#6a6a78",
          fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        seq {eventSeq}
      </span>
      <span style={{ color: "#6a6a78", flexShrink: 0 }}>·</span>
      <span style={{ color: "#6a6a78", fontSize: 10, flexShrink: 0 }}>{summary}</span>
      {note && (
        <>
          <span style={{ color: "#6a6a78", flexShrink: 0 }}>·</span>
          <span
            style={{
              color: "#e6e6ea",
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
