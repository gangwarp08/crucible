"use client";
// Proctoring v1 review surface: Suspicion Score + factor breakdown + an
// integrity-event mini-timeline. Strictly informational — the integrity
// channel is isolated from competency evidence/evaluations by design, and
// this panel says so prominently.
//
// Zero-impact on older deploys: when the server lacks the suspicion route,
// getSuspicionReport returns null; with no integrity events either, the
// panel renders nothing at all.
import { useEffect, useState } from "react";
import {
  getSuspicionReport,
  type SuspicionReport,
  type IntegrityTimelineEvent,
  type ReviewEvent,
} from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";
import { formatRelativeMs } from "./format";

interface Props {
  sessionId: string;
  /** Full event list from the session detail bundle — integrity.* rows are
   *  filtered out here for the mini-timeline (they're ordinary events rows). */
  events: ReviewEvent[];
  sessionStart: string;
}

// Suspicion is 0–100 where HIGH is bad — the inverse of the 1–5 competency
// scale — so scoreColor() can't be reused directly; same palette, inverted.
function suspicionColor(score: number): string {
  if (score >= 60) return color.error.base;
  if (score >= 30) return color.warn.base;
  if (score >= 10) return color.accent.base;
  return color.success.base;
}

type Fetch =
  | { kind: "loading" }
  | { kind: "loaded"; report: SuspicionReport | null };

export default function SuspicionPanel({ sessionId, events, sessionStart }: Props) {
  const [fetch, setFetch] = useState<Fetch>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setFetch({ kind: "loading" });
    void getSuspicionReport(sessionId).then((report) => {
      if (!cancelled) setFetch({ kind: "loaded", report });
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  if (fetch.kind === "loading") return null;
  const report = fetch.report;

  // Timeline source: the suspicion route's seq-ordered integrity events are
  // authoritative; fall back to filtering the detail bundle's events when the
  // route is absent (older server) but integrity rows already exist.
  const integrityEvents: IntegrityTimelineEvent[] =
    report !== null
      ? report.events
      : events.filter((e) => e.type.startsWith("integrity."));

  // Older server deploy (no route) and nothing recorded → stay invisible.
  if (report === null && integrityEvents.length === 0) return null;

  const score = report !== null ? Math.max(0, Math.min(100, Math.round(report.score))) : null;
  const factors = report?.factors ?? [];
  const startMs = new Date(sessionStart).getTime();

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
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: color.text.secondary, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Proctoring
        </span>
        <span
          style={{
            fontSize: 10,
            fontFamily: font.mono,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: color.warn.base,
            border: `1px solid ${color.warn.base}`,
            borderRadius: radius.sm,
            padding: "2px 8px",
            whiteSpace: "nowrap",
          }}
        >
          integrity signal — informational, not scored
        </span>
      </header>

      {/* Score */}
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${color.border.subtle}`, display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 12, color: color.text.secondary }}>Suspicion Score</span>
        <span
          style={{
            fontSize: 26,
            fontWeight: 700,
            fontFamily: font.mono,
            fontVariantNumeric: "tabular-nums",
            color: score !== null ? suspicionColor(score) : color.text.muted,
          }}
        >
          {score !== null ? score : "—"}
        </span>
        <span style={{ fontSize: 12, color: color.text.muted }}>/ 100</span>
        {report !== null && (
          <span style={{ fontSize: 10, color: color.text.muted, fontFamily: font.mono, marginLeft: "auto" }}>
            detector v{report.version}
          </span>
        )}
      </div>

      {/* Factor breakdown */}
      {factors.length > 0 && (
        <div style={{ borderBottom: `1px solid ${color.border.subtle}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: color.bg.input }}>
                <th style={th}>Factor</th>
                <th style={{ ...th, textAlign: "right" }}>Count</th>
                <th style={{ ...th, textAlign: "right" }}>Contribution</th>
              </tr>
            </thead>
            <tbody>
              {factors.map((f) => (
                <tr key={f.kind} style={{ borderBottom: `1px solid ${color.border.subtle}` }}>
                  <td style={td}>{f.kind}</td>
                  <td style={{ ...td, textAlign: "right" }}>{f.count}</td>
                  <td style={{ ...td, textAlign: "right", color: color.text.primary }}>
                    +{Number(f.contribution).toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Integrity-event mini-timeline (same visual language as Timeline) */}
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {integrityEvents.length === 0 ? (
          <div style={{ padding: 16, color: color.text.muted, fontSize: 12, textAlign: "center" }}>
            No integrity events recorded
          </div>
        ) : (
          integrityEvents.map((ev) => {
            const tMs = new Date(ev.ts).getTime() - startMs;
            return (
              <div
                key={ev.seq}
                style={{
                  padding: "6px 16px",
                  borderBottom: `1px solid ${color.border.subtle}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span style={{ width: 4, height: 4, borderRadius: 2, background: color.warn.base, flexShrink: 0 }} />
                <span style={{ fontFamily: font.mono, fontSize: 10, color: color.text.muted, width: 36, flexShrink: 0 }}>
                  {formatRelativeMs(tMs)}
                </span>
                <span style={{ fontFamily: font.mono, fontSize: 10, color: color.text.muted, width: 34, flexShrink: 0 }}>
                  #{ev.seq}
                </span>
                <span style={{ fontSize: 12, color: color.text.primary }}>
                  {ev.type.replace(/^integrity\./, "")}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: color.text.muted,
                    fontFamily: font.mono,
                    marginLeft: "auto",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 180,
                  }}
                  title={JSON.stringify(ev.payload ?? {})}
                >
                  {summarizePayload(ev.payload ?? {})}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/** Compact one-line payload summary, e.g. "chars=1204 target=editor". */
function summarizePayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
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
};

const td: React.CSSProperties = {
  padding: "6px 12px",
  color: color.text.secondary,
  fontFamily: font.mono,
  fontVariantNumeric: "tabular-nums",
  fontSize: 11,
};
