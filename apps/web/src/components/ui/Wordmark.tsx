"use client";
import { color, font } from "@/styles/tokens";

interface WordmarkProps {
  /** Wordmark font size in px. The square dot scales with it. */
  size?: number;
}

/** Brand lockup: the "asaya" wordmark with a lime square in place of the
 *  trailing period. The square is the entire mark — deliberately minimal. */
export default function Wordmark({ size = 22 }: WordmarkProps): React.ReactElement {
  const wordSize = Math.round(size * 0.86);
  const dot = Math.max(4, Math.round(wordSize * 0.24));
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: Math.round(dot * 0.7) }}>
      <span
        style={{
          fontFamily: font.mono,
          fontWeight: 600,
          fontSize: wordSize,
          letterSpacing: "-0.03em",
          color: color.text.primary,
          lineHeight: 1,
        }}
      >
        asaya
      </span>
      <span
        aria-hidden="true"
        style={{
          width: dot,
          height: dot,
          background: color.accent.base,
          flex: "none",
        }}
      />
    </span>
  );
}
