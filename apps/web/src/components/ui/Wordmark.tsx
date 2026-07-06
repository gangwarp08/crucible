"use client";
import { color, font } from "@/styles/tokens";
import CubeFlame from "./CubeFlame";

interface WordmarkProps {
  /** Glyph size in px. The wordmark scales with it. */
  size?: number;
}

/** Brand lockup: the cube-with-flame glyph plus the "asaya" wordmark with a
 *  lime square in place of the trailing period. */
export default function Wordmark({ size = 22 }: WordmarkProps): React.ReactElement {
  const wordSize = Math.round(size * 0.82);
  const dot = Math.max(4, Math.round(wordSize * 0.24));
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.45) }}>
      <CubeFlame size={size} />
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
    </span>
  );
}
