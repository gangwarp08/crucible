"use client";
import { useSessionStore } from "@/stores/sessionStore";

const PANEL  = "#252526";
const BORDER = "#404040";
const TEXT   = "#cccccc";
const MUTED  = "#858585";
const WHITE  = "#ffffff";

function fmtLocalTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Full-screen overlay shown once the session status flips to "ended".
 *  Same overlay regardless of end reason (timer, manual DELETE, server
 *  expiry, budget exhausted). Read-only acknowledgement — no CTA, no
 *  link, no auto-close. */
export default function EndScreen() {
  const { sessionId, endedAt } = useSessionStore();
  const shortId = sessionId ? sessionId.slice(0, 8) : "—";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(30, 30, 30, 0.96)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          background: PANEL,
          border: `1px solid ${BORDER}`,
          borderRadius: 8,
          padding: "36px 40px",
          maxWidth: 480,
          width: "calc(100% - 48px)",
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
          textAlign: "left",
        }}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: MUTED,
            fontWeight: 600,
            marginBottom: 8,
          }}
        >
          Session ended
        </div>
        <h1
          style={{
            margin: 0,
            marginBottom: 16,
            fontSize: 22,
            color: WHITE,
            fontWeight: 600,
            letterSpacing: "-0.3px",
          }}
        >
          Assessment complete
        </h1>
        <p
          style={{
            color: TEXT,
            fontSize: 14,
            lineHeight: 1.55,
            margin: 0,
            marginBottom: 24,
          }}
        >
          Your work has been captured. Our team will review your session and
          follow up shortly. You can close this tab.
        </p>
        <dl
          style={{
            margin: 0,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            rowGap: 6,
            columnGap: 14,
            fontSize: 12,
            color: MUTED,
          }}
        >
          <dt style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>Session</dt>
          <dd style={{ margin: 0, color: TEXT, fontFamily: "'SF Mono', Menlo, Consolas, monospace" }}>
            {shortId}
          </dd>
          <dt style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>Ended</dt>
          <dd style={{ margin: 0, color: TEXT, fontFamily: "'SF Mono', Menlo, Consolas, monospace" }}>
            {fmtLocalTime(endedAt)}
          </dd>
        </dl>
      </div>
    </div>
  );
}
