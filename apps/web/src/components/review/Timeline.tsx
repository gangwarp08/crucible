"use client";
import type { ReviewEvent } from "@/lib/api";
import { formatRelativeMs } from "./format";

interface Props {
  events: ReviewEvent[];
  sessionStart: string;
}

interface EventDescriptor {
  label: string;
  detail?: string;
  color: string;
  scrollTo?: string;
}

function describe(ev: ReviewEvent): EventDescriptor {
  const p = ev.payload;
  switch (ev.type) {
    case "session.created":
      return { label: "Session started", color: "#4ec9b0" };
    case "session.ended": {
      const reason = typeof p["endReason"] === "string" ? p["endReason"] : "ended";
      return { label: `Session ended`, detail: reason, color: "#f48771" };
    }
    case "pty.output": {
      const bytes = typeof p["bytes"] === "number" ? p["bytes"] : "?";
      return { label: "Terminal output", detail: `${bytes} bytes`, color: "#3794ff" };
    }
    case "pty.input": {
      const bytes = typeof p["bytes"] === "number" ? p["bytes"] : "?";
      return { label: "Candidate input", detail: `${bytes} bytes`, color: "#3794ff" };
    }
    case "file.write": {
      const path = typeof p["path"] === "string" ? p["path"] : "?";
      const action = typeof p["action"] === "string" ? p["action"] : "write";
      return {
        label: `File ${action}`,
        detail: path,
        color: "#dcb67a",
        scrollTo: `file-${path}`,
      };
    }
    case "chat.user": {
      const tid = typeof p["transcript_id"] === "string" ? p["transcript_id"] : null;
      return {
        label: "Candidate message",
        color: "#bb86fc",
        ...(tid ? { scrollTo: `turn-${tid}` } : {}),
      };
    }
    case "chat.assistant": {
      const tid = typeof p["transcript_id"] === "string" ? p["transcript_id"] : null;
      return {
        label: "AI reply",
        color: "#bb86fc",
        ...(tid ? { scrollTo: `turn-${tid}` } : {}),
      };
    }
    default:
      return { label: ev.type, color: "#858585" };
  }
}

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // Brief highlight to show what was just navigated to.
  const original = el.style.outline;
  el.style.outline = "2px solid #3794ff";
  el.style.outlineOffset = "2px";
  setTimeout(() => { el.style.outline = original; el.style.outlineOffset = ""; }, 1200);
}

export default function Timeline({ events, sessionStart }: Props) {
  const startMs = new Date(sessionStart).getTime();

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
      <header
        style={{
          padding: "10px 16px",
          background: "#2d2d2d",
          borderBottom: "1px solid #404040",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "#858585", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Timeline
        </span>
        <span style={{ fontSize: 11, color: "#666" }}>{events.length} events</span>
      </header>

      <div style={{ maxHeight: 560, overflowY: "auto" }}>
        {events.length === 0 ? (
          <div style={{ padding: 24, color: "#666", fontSize: 13, textAlign: "center" }}>
            No events
          </div>
        ) : (
          events.map((ev) => {
            const d = describe(ev);
            const tMs = new Date(ev.ts).getTime() - startMs;
            const clickable = d.scrollTo !== undefined;
            return (
              <div
                key={ev.id}
                onClick={clickable ? () => scrollToId(d.scrollTo!) : undefined}
                style={{
                  padding: "8px 16px",
                  borderBottom: "1px solid #353535",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: clickable ? "pointer" : "default",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (clickable) (e.currentTarget as HTMLDivElement).style.background = "#2a2d2e";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "transparent";
                }}
              >
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: 2,
                    background: d.color,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontFamily: "monospace",
                    fontSize: 10,
                    color: "#666",
                    width: 36,
                    flexShrink: 0,
                  }}
                >
                  {formatRelativeMs(tMs)}
                </span>
                <span style={{ fontSize: 12, color: "#cccccc", flexShrink: 0 }}>
                  {d.label}
                </span>
                {d.detail && (
                  <span
                    style={{
                      fontSize: 11,
                      color: "#666",
                      fontFamily: "monospace",
                      marginLeft: "auto",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 200,
                    }}
                    title={d.detail}
                  >
                    {d.detail}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
