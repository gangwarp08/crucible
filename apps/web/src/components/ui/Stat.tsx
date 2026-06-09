"use client";
import type { CSSProperties, ReactNode } from "react";
import { color, font } from "@/styles/tokens";

interface Props {
  label: ReactNode;
  value: ReactNode;
  denominator?: ReactNode;        // e.g. "/ 200,000"
  tone?: "default" | "warn" | "error" | "success" | "muted";
  size?: "sm" | "md" | "lg";
  align?: "left" | "center";
  style?: CSSProperties;
}

const VALUE_COLOR: Record<NonNullable<Props["tone"]>, string> = {
  default: color.text.primary,
  warn:    color.warn.base,
  error:   color.error.base,
  success: color.success.base,
  muted:   color.text.muted,
};

const VALUE_SIZE: Record<NonNullable<Props["size"]>, number> = {
  sm: 12,
  md: 14,
  lg: 18,
};

/** Label-over-value cell. Replaces ConstraintHUD's Indicator, BriefPanel's
 *  Cell, StartScreen's ConstraintCell, SessionSummary's Stat. */
export default function Stat({
  label, value, denominator, tone = "default", size = "md", align = "left", style,
}: Props): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        alignItems: align === "center" ? "center" : "flex-start",
        minWidth: 0,
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: color.text.muted,
          fontWeight: 600,
          lineHeight: 1.2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 4,
          fontFamily: font.mono,
          fontVariantNumeric: "tabular-nums",
          color: VALUE_COLOR[tone],
          fontSize: VALUE_SIZE[size],
          fontWeight: 500,
          lineHeight: 1.1,
          whiteSpace: "nowrap",
        }}
      >
        <span>{value}</span>
        {denominator && (
          <span style={{ fontSize: VALUE_SIZE[size] - 4, color: color.text.muted, fontWeight: 400 }}>
            {denominator}
          </span>
        )}
      </div>
    </div>
  );
}
