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
}

/** Surface primitive: a raised panel with optional header strip.
 *  Replaces the 8+ "panel with header" patterns across the codebase. */
export default function Card({
  header, headerRight, padding = 5, bodyStyle, children, style, variant = "default",
}: Props): React.ReactElement {
  return (
    <div
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.subtle}`,
        borderRadius: radius.md,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
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
            borderBottom: `1px solid ${color.border.subtle}`,
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
