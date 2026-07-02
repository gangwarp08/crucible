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
      return { label: "Session started", color: "#56d6a8" };
    case "session.ended": {
      const reason = typeof p["endReason"] === "string" ? p["endReason"] : "ended";
      return { label: `Session ended`, detail: reason, color: "#ff7a7a" };
    }
    case "pty.output": {
      const bytes = typeof p["bytes"] === "number" ? p["bytes"] : "?";
      return { label: "Terminal output", detail: `${bytes} bytes`, color: "#7c7fff" };
    }
    case "pty.input": {
      const bytes = typeof p["bytes"] === "number" ? p["bytes"] : "?";
      return { label: "Candidate input", detail: `${bytes} bytes`, color: "#7c7fff" };
    }
    case "file.write": {
      const path = typeof p["path"] === "string" ? p["path"] : "?";
      const action = typeof p["action"] === "string" ? p["action"] : "write";
      return {
        label: `File ${action}`,
        detail: path,
        color: "#e0b66e",
        scrollTo: `file-${path}`,
      };
    }
    case "chat.user": {
      const tid = typeof p["transcript_id"] === "string" ? p["transcript_id"] : null;
      return {
        label: "Candidate message",
        color: "#9b87ff",
        ...(tid ? { scrollTo: `turn-${tid}` } : {}),
      };
    }
    case "chat.assistant": {
      const tid = typeof p["transcript_id"] === "string" ? p["transcript_id"] : null;
      return {
        label: "AI reply",
        color: "#9b87ff",
        ...(tid ? { scrollTo: `turn-${tid}` } : {}),
      };
    }
    default:
      return { label: ev.type, color: "#9999a3" };
  }
}

/** Smooth-scroll to a DOM id and flash a 1.2s blue outline highlight. Used by
 *  Timeline internally for its existing scrollTo behaviour (file.write,
 *  chat.user, chat.assistant rows), and by Scorecard.tsx to jump from an
 *  evidence chip to the underlying event row (`event-${seq}`). Returns true
 *  if the element was found, false if not — Scorecard uses this to grey out
 *  evidence whose seq isn't in the loaded events window. */
export function scrollToHighlight(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const original = el.style.outline;
  el.style.outline = "2px solid #7c7fff";
  el.style.outlineOffset = "2px";
  setTimeout(() => { el.style.outline = original; el.style.outlineOffset = ""; }, 1200);
  return true;
}

// Backwards-compatible alias for the original internal use sites.
const scrollToId = scrollToHighlight;

export default function Timeline({ events, sessionStart }: Props) {
  const startMs = new Date(sessionStart).getTime();

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
      <header
        style={{
          padding: "10px 16px",
          background: "#1c1c24",
          borderBottom: "1px solid #2a2a36",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "#9999a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Timeline
        </span>
        <span style={{ fontSize: 11, color: "#6a6a78" }}>{events.length} events</span>
      </header>

      <div style={{ maxHeight: 560, overflowY: "auto" }}>
        {events.length === 0 ? (
          <div style={{ padding: 24, color: "#6a6a78", fontSize: 13, textAlign: "center" }}>
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
                id={`event-${ev.seq}`}
                onClick={clickable ? () => scrollToId(d.scrollTo!) : undefined}
                style={{
                  padding: "8px 16px",
                  borderBottom: "1px solid #22222b",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: clickable ? "pointer" : "default",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (clickable) (e.currentTarget as HTMLDivElement).style.background = "#1f1f28";
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
                    fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
                    fontSize: 10,
                    color: "#6a6a78",
                    width: 36,
                    flexShrink: 0,
                  }}
                >
                  {formatRelativeMs(tMs)}
                </span>
                <span style={{ fontSize: 12, color: "#e6e6ea", flexShrink: 0 }}>
                  {d.label}
                </span>
                {d.detail && (
                  <span
                    style={{
                      fontSize: 11,
                      color: "#6a6a78",
                      fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
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
