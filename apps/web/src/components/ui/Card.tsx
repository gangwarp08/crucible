"use client";
import type { CSSProperties, ReactNode } from "react";
import { color, radius, space } from "@/styles/tokens";
import SectionLabel from "./SectionLabel";

interface Props {
  header?: ReactNode;          // title or custom header content (left-aligned)
  headerRight?: ReactNode;     // optional right-aligned header content
  padding?: keyof typeof space; // body padding (default 5 = 20px)
  bodyStyle?: CSSProperties;
  children: ReactNode;
  style?: CSSProperties;
  variant?: "default" | "flush";
  /** When true, the card lifts and glows on hover. Use for clickable /
   *  marketing-style cards; leave off for functional panels. */
  interactive?: boolean;
}

/** Surface primitive: a raised panel with optional header strip.
 *  Replaces the 8+ "panel with header" patterns across the codebase. */
export default function Card({
  header, headerRight, padding = 5, bodyStyle, children, style, variant = "default",
  interactive,
}: Props): React.ReactElement {
  return (
    <div
      className={interactive ? "card-fire-interactive" : undefined}
      style={{
        // Subtle top-down gradient on a panel base — matches the design's
        // 180deg fade. Renders almost invisible on near-black but adds depth.
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.012), rgba(255,255,255,0)), " +
          color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        position: interactive ? "relative" : undefined,
        transition: interactive
          ? "border-color 400ms ease, box-shadow 400ms ease, transform 400ms ease, background 400ms ease"
          : undefined,
        ...style,
      }}
    >
      {header && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 16px",
            background: color.bg.elevated,
            borderBottom: `1px solid ${color.border.default}`,
            flexShrink: 0,
          }}
        >
          {typeof header === "string" ? <SectionLabel>{header}</SectionLabel> : header}
          {headerRight}
        </div>
      )}
      <div
        style={{
          padding: variant === "flush" ? 0 : space[padding],
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}
