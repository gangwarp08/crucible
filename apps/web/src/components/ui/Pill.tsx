"use client";
import type { CSSProperties, ReactNode } from "react";
import { color, radius, font } from "@/styles/tokens";

export type PillTone = "neutral" | "accent" | "success" | "warn" | "error";

interface Props {
  tone?: PillTone;
  size?: "sm" | "md";
  variant?: "soft" | "outline";
  children: ReactNode;
  style?: CSSProperties;
}

function toneColor(tone: PillTone): { fg: string; bg: string; border: string } {
  switch (tone) {
    case "accent":  return { fg: color.accent.base,  bg: color.accent.soft,  border: color.accent.base };
    case "success": return { fg: color.success.base, bg: color.success.soft, border: color.success.base };
    case "warn":    return { fg: color.warn.base,    bg: color.warn.soft,    border: color.warn.base };
    case "error":   return { fg: color.error.base,   bg: color.error.soft,   border: color.error.base };
    case "neutral":
    default:        return { fg: color.text.secondary, bg: color.bg.elevated, border: color.border.default };
  }
}

export default function Pill({
  tone = "neutral", size = "sm", variant = "soft", children, style,
}: Props): React.ReactElement {
  const c = toneColor(tone);
  const styles: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontFamily: font.mono,
    fontSize: size === "sm" ? 10 : 11,
    fontWeight: 500,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: c.fg,
    background: variant === "soft" ? c.bg : "transparent",
    border: `1px solid ${variant === "soft" ? "transparent" : c.border}`,
    borderRadius: radius.pill,
    padding: size === "sm" ? "2px 8px" : "3px 10px",
    whiteSpace: "nowrap",
    ...style,
  };
  return <span style={styles}>{children}</span>;
}
