"use client";
import { useId } from "react";
import { color, font } from "@/styles/tokens";

interface CubeProps {
  size?: number;
}

/** Flaming-wireframe-cube glyph. An isometric wireframe cube with a
 *  yellow→orange→red flame rising from the top. The flame uses a CSS
 *  scaleY pulse defined in globals.css (.cru-glyph .flm). */
export function FlamingCube({ size = 22 }: CubeProps): React.ReactElement {
  const rawId = useId();
  const gid = rawId.replace(/:/g, "");
  return (
    <span
      className="cru-glyph"
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: size,
        height: size,
        color: color.text.primary,
      }}
      aria-hidden="true"
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <defs>
          <linearGradient id={`flm-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#DDA75C" />
            <stop offset="0.55" stopColor="#DDA75C" />
            <stop offset="1" stopColor="#B85C3A" />
          </linearGradient>
        </defs>
        <path
          d="M12 6.4 L19.6 10.7 L19.6 17.4 L12 21.7 L4.4 17.4 L4.4 10.7 Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="M12 6.4 L12 14.1 M12 14.1 L19.6 10.7 M12 14.1 L4.4 10.7"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <g className="flm">
          <path
            d="M12 0.7 C13.9 3.2 15.1 4.4 15.1 6.4 C15.1 8.2 13.7 9.4 12 9.4 C10.3 9.4 8.9 8.1 8.9 6.4 C8.9 5.1 9.5 4.3 10.1 3.6 C10.3 4.5 10.7 4.9 11.2 5 C10.8 3.5 11.2 1.9 12 0.7 Z"
            fill={`url(#flm-${gid})`}
          />
          <path
            d="M12 3.9 C12.95 5.1 13.4 5.8 13.4 6.8 C13.4 7.8 12.8 8.4 12 8.4 C11.2 8.4 10.6 7.8 10.6 6.9 C10.6 6.2 10.9 5.8 11.3 5.4 C11.4 6 11.7 6.3 12 6.3 C11.7 5.4 11.7 4.6 12 3.9 Z"
            fill="#E8C07A"
          />
        </g>
      </svg>
    </span>
  );
}

interface WordmarkProps {
  /** Glyph size in px. Word scales with it. */
  size?: number;
}

/** Full lockup: flaming cube + the "asaya." wordmark. The trailing dot
 *  is rendered in the fire accent and is a deliberate piece of the brand. */
export default function Wordmark({ size = 22 }: WordmarkProps): React.ReactElement {
  // Word font-size derived from glyph size so the lockup scales together.
  const wordSize = Math.round(size * 0.78);
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 11 }}>
      <FlamingCube size={size} />
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
        asaya<span style={{ color: color.accent.base }}>.</span>
      </span>
    </div>
  );
}
