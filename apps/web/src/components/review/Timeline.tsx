"use client";
import type { ReviewEvent } from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";
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
      return { label: "Session started", color: color.success.base };
    case "session.ended": {
      const reason = typeof p["endReason"] === "string" ? p["endReason"] : "ended";
      return { label: `Session ended`, detail: reason, color: color.error.base };
    }
    case "pty.output": {
      const bytes = typeof p["bytes"] === "number" ? p["bytes"] : "?";
      return { label: "Terminal output", detail: `${bytes} bytes`, color: color.accent.base };
    }
    case "pty.input": {
      const bytes = typeof p["bytes"] === "number" ? p["bytes"] : "?";
      return { label: "Candidate input", detail: `${bytes} bytes`, color: color.accent.base };
    }
    case "file.write": {
      const path = typeof p["path"] === "string" ? p["path"] : "?";
      const action = typeof p["action"] === "string" ? p["action"] : "write";
      return {
        label: `File ${action}`,
        detail: path,
        color: color.warn.base,
        scrollTo: `file-${path}`,
      };
    }
    case "chat.user": {
      const tid = typeof p["transcript_id"] === "string" ? p["transcript_id"] : null;
      return {
        label: "Candidate message",
        color: color.persona.team,
        ...(tid ? { scrollTo: `turn-${tid}` } : {}),
      };
    }
    case "chat.assistant": {
      const tid = typeof p["transcript_id"] === "string" ? p["transcript_id"] : null;
      return {
        label: "AI reply",
        color: color.persona.team,
        ...(tid ? { scrollTo: `turn-${tid}` } : {}),
      };
    }
    default:
      return { label: ev.type, color: color.text.secondary };
  }
}

/** Smooth-scroll to a DOM id and flash a 1.2s accent outline highlight. Used by
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
  el.style.outline = `2px solid ${color.accent.base}`;
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
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: color.text.secondary, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Timeline
        </span>
        <span style={{ fontSize: 11, color: color.text.muted }}>{events.length} events</span>
      </header>

      <div style={{ maxHeight: 560, overflowY: "auto" }}>
        {events.length === 0 ? (
          <div style={{ padding: 24, color: color.text.muted, fontSize: 13, textAlign: "center" }}>
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
                  borderBottom: `1px solid ${color.border.subtle}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: clickable ? "pointer" : "default",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (clickable) (e.currentTarget as HTMLDivElement).style.background = color.bg.hover;
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
                    fontFamily: font.mono,
                    fontSize: 10,
                    color: color.text.muted,
                    width: 36,
                    flexShrink: 0,
                  }}
                >
                  {formatRelativeMs(tMs)}
                </span>
                <span style={{ fontSize: 12, color: color.text.primary, flexShrink: 0 }}>
                  {d.label}
                </span>
                {d.detail && (
                  <span
                    style={{
                      fontSize: 11,
                      color: color.text.muted,
                      fontFamily: font.mono,
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
