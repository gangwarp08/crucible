"use client";
import { useSessionStore } from "@/stores/sessionStore";
import { color, radius, shadow, space } from "@/styles/tokens";
import SectionLabel from "@/components/ui/SectionLabel";
import Stat from "@/components/ui/Stat";

function fmtLocalTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Full-screen overlay shown once the session status flips to "ended".
 *  Same overlay regardless of end reason (timer, manual DELETE, server
 *  expiry, budget exhausted). Read-only acknowledgement — no CTA, no link. */
export default function EndScreen() {
  const { sessionId, endedAt } = useSessionStore();
  const shortId = sessionId ? sessionId.slice(0, 8) : "—";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8, 8, 12, 0.85)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: color.bg.panel,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.lg,
          padding: "40px 44px",
          maxWidth: 520,
          width: "calc(100% - 48px)",
          boxShadow: shadow.lg,
        }}
      >
        <SectionLabel>Submitted</SectionLabel>
        <h1
          style={{
            margin: 0,
            marginTop: 8,
            marginBottom: 16,
            fontSize: 22,
            color: color.text.primary,
            fontWeight: 600,
            letterSpacing: "-0.3px",
          }}
        >
          Your work has been submitted
        </h1>
        <p
          style={{
            color: color.text.secondary,
            fontSize: 14,
            lineHeight: 1.6,
            margin: 0,
            marginBottom: 28,
          }}
        >
          Our team will review your session and follow up shortly. You can
          close this tab whenever you&apos;re ready.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: space[4],
            padding: space[4],
            background: color.bg.elevated,
            borderRadius: radius.md,
            border: `1px solid ${color.border.subtle}`,
          }}
        >
          <Stat label="Session" value={shortId} size="sm" />
          <Stat label="Ended at" value={fmtLocalTime(endedAt)} size="sm" />
        </div>
      </div>
    </div>
  );
}
