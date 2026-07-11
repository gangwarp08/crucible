"use client";
import type { CSSProperties, ReactNode } from "react";
import { color, font } from "@/styles/tokens";

interface Props {
  children: ReactNode;
  /** default: secondary muted micro-header.
   *  subtle:  even quieter (very muted).
   *  section: larger, more legible section heading — for the brief/start
   *           panels where these headers are the primary structure a candidate
   *           reads (e.g. "The situation", "What we score"). Same mono/uppercase
   *           look, bumped size with tighter tracking so wide labels don't
   *           overflow narrow panels.
   *  eyebrow: brand "eyebrow" — mono, lime, with a leading rule.
   *           Use above hero headlines and section openers. */
  tone?: "default" | "subtle" | "section" | "eyebrow";
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
  const isSection = tone === "section";
  const styles: CSSProperties = {
    fontFamily: font.mono,
    fontSize: isSection ? 14 : 11,
    fontWeight: isSection ? 600 : 500,
    letterSpacing: isSection ? "0.18em" : "0.22em",
    textTransform: "uppercase",
    color: tone === "subtle" ? color.text.muted : color.text.secondary,
    ...style,
  };
  return <div style={styles}>{children}</div>;
}
