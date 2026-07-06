"use client";
import type { CSSProperties, ReactNode } from "react";
import { color, font } from "@/styles/tokens";

interface Props {
  children: ReactNode;
  /** default: secondary muted micro-header.
   *  subtle:  even quieter (very muted).
   *  eyebrow: brand "eyebrow" — mono, lime, with a leading rule.
   *           Use above hero headlines and section openers. */
  tone?: "default" | "subtle" | "eyebrow";
  style?: CSSProperties;
}

/** Canonical uppercase-letter-spaced micro-header used as a section divider
 *  (and, with tone="eyebrow", as a brand eyebrow above hero headlines). */
export default function SectionLabel({
  children, tone = "default", style,
}: Props): React.ReactElement {
  if (tone === "eyebrow") {
    return (
      <span
        style={{
          fontFamily: font.mono,
          fontSize: 11.5,
          fontWeight: 500,
          letterSpacing: "0.28em",
          textTransform: "uppercase",
          color: color.accent.base,
          display: "inline-flex",
          alignItems: "center",
          gap: 12,
          ...style,
        }}
      >
        <span
          style={{
            width: 22,
            height: 1,
            background: color.accent.base,
            flex: "none",
          }}
        />
        {children}
      </span>
    );
  }
  const styles: CSSProperties = {
    fontFamily: font.mono,
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: tone === "subtle" ? color.text.muted : color.text.secondary,
    ...style,
  };
  return <div style={styles}>{children}</div>;
}
