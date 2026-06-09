"use client";
import type { CSSProperties, ReactNode } from "react";
import { color, font, radius } from "@/styles/tokens";

type Role = "self" | "other" | "system";

interface Props {
  role: Role;
  // Persona-specific accent for the small role label above the bubble.
  // Optional — falls back to the role's default.
  accentColor?: string | undefined;
  label?: string | undefined;
  timestamp?: string | undefined;
  children: ReactNode;
  maxWidth?: number | string;
}

const ROLE_STYLE: Record<Role, { bg: string; corner: string; align: CSSProperties["alignSelf"] }> = {
  self:   { bg: color.accent.soft, corner: "12px 12px 4px 12px",  align: "flex-end"   },
  other:  { bg: color.bg.elevated, corner: "12px 12px 12px 4px",  align: "flex-start" },
  system: { bg: "transparent",     corner: "0",                   align: "center"     },
};

/** Single canonical chat-bubble primitive. Replaces three near-identical
 *  implementations (ChatHUD, Messages, TranscriptPanel). */
export default function Bubble({
  role, accentColor, label, timestamp, children, maxWidth = "85%",
}: Props): React.ReactElement {
  const s = ROLE_STYLE[role];
  const isSystem = role === "system";

  if (isSystem) {
    return (
      <div style={{ alignSelf: "center", maxWidth, padding: "4px 12px" }}>
        <div
          style={{
            fontSize: 11,
            color: color.text.muted,
            fontStyle: "italic",
            textAlign: "center",
            fontFamily: font.sans,
          }}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div style={{ alignSelf: s.align, maxWidth, display: "flex", flexDirection: "column", gap: 4 }}>
      {(label || timestamp) && (
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            fontSize: 10,
            color: color.text.muted,
            paddingLeft: role === "other" ? 4 : 0,
            paddingRight: role === "self" ? 4 : 0,
            flexDirection: role === "self" ? "row-reverse" : "row",
          }}
        >
          {label && (
            <span
              style={{
                fontWeight: 600,
                color: accentColor ?? color.text.secondary,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              {label}
            </span>
          )}
          {timestamp && (
            <span style={{ fontFamily: font.mono, fontVariantNumeric: "tabular-nums" }}>
              {timestamp}
            </span>
          )}
        </div>
      )}
      <div
        style={{
          background: s.bg,
          color: color.text.primary,
          padding: "8px 12px",
          borderRadius: s.corner,
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          border: role === "self" ? `1px solid ${color.accent.base}33` : `1px solid ${color.border.subtle}`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
