"use client";
import type { CSSProperties, ReactNode } from "react";
import { color } from "@/styles/tokens";

interface Props {
  children: ReactNode;
  tone?: "default" | "subtle";
  style?: CSSProperties;
}

/** Canonical uppercase-letter-spaced micro-header used as a section divider.
 *  Replaces 20+ variants of this pattern with inconsistent letter-spacing,
 *  font-size, and color. */
export default function SectionLabel({
  children, tone = "default", style,
}: Props): React.ReactElement {
  const styles: CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: tone === "subtle" ? color.text.muted : color.text.secondary,
    ...style,
  };
  return <div style={styles}>{children}</div>;
}
