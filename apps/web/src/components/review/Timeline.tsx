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
      return { label: "Session started", color: "#5E9179" };
    case "session.ended": {
      const reason = typeof p["endReason"] === "string" ? p["endReason"] : "ended";
      return { label: `Session ended`, detail: reason, color: "#BC4B3C" };
    }
    case "pty.output": {
      const bytes = typeof p["bytes"] === "number" ? p["bytes"] : "?";
      return { label: "Terminal output", detail: `${bytes} bytes`, color: "#C67C5B" };
    }
    case "pty.input": {
      const bytes = typeof p["bytes"] === "number" ? p["bytes"] : "?";
      return { label: "Candidate input", detail: `${bytes} bytes`, color: "#C67C5B" };
    }
    case "file.write": {
      const path = typeof p["path"] === "string" ? p["path"] : "?";
      const action = typeof p["action"] === "string" ? p["action"] : "write";
      return {
        label: `File ${action}`,
        detail: path,
        color: "#DDA75C",
        scrollTo: `file-${path}`,
      };
    }
    case "chat.user": {
      const tid = typeof p["transcript_id"] === "string" ? p["transcript_id"] : null;
      return {
        label: "Candidate message",
        color: "#C67C5B",
        ...(tid ? { scrollTo: `turn-${tid}` } : {}),
      };
    }
    case "chat.assistant": {
      const tid = typeof p["transcript_id"] === "string" ? p["transcript_id"] : null;
      return {
        label: "AI reply",
        color: "#C67C5B",
        ...(tid ? { scrollTo: `turn-${tid}` } : {}),
      };
    }
    default:
      return { label: ev.type, color: "#5E6B64" };
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
  el.style.outline = "2px solid #C67C5B";
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
        background: "#FBF6EA",
        border: "1px solid #DED3BF",
        borderRadius: 6,
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          background: "#FFFDF9",
          borderBottom: "1px solid #DED3BF",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "#5E6B64", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Timeline
        </span>
        <span style={{ fontSize: 11, color: "#8A9389" }}>{events.length} events</span>
      </header>

      <div style={{ maxHeight: 560, overflowY: "auto" }}>
        {events.length === 0 ? (
          <div style={{ padding: 24, color: "#8A9389", fontSize: 13, textAlign: "center" }}>
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
                  borderBottom: "1px solid #E5DBC9",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: clickable ? "pointer" : "default",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (clickable) (e.currentTarget as HTMLDivElement).style.background = "#FFFDF9";
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
                    color: "#8A9389",
                    width: 36,
                    flexShrink: 0,
                  }}
                >
                  {formatRelativeMs(tMs)}
                </span>
                <span style={{ fontSize: 12, color: "#28352F", flexShrink: 0 }}>
                  {d.label}
                </span>
                {d.detail && (
                  <span
                    style={{
                      fontSize: 11,
                      color: "#8A9389",
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
