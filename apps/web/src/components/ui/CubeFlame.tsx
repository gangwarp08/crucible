"use client";
import { useId } from "react";
import { color } from "@/styles/tokens";

interface Props {
  /** Rendered size in px (square). */
  size?: number;
}

/** Brand glyph: a wireframe isometric cube with a flame burning inside it,
 *  depicting the sandboxed testing environment. The flame renders in the
 *  brand lime family and gently flickers (globals.css .brand-glyph .flame). */
export default function CubeFlame({ size = 22 }: Props): React.ReactElement {
  const rawId = useId();
  const gid = rawId.replace(/:/g, "");
  return (
    <span
      className="brand-glyph"
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
            <stop offset="0" stopColor={color.accent.pale} />
            <stop offset="0.55" stopColor={color.accent.base} />
            <stop offset="1" stopColor={color.accent.deep} />
          </linearGradient>
        </defs>
        {/* cube silhouette */}
        <path
          d="M12 2.2 L20 6.9 L20 16.1 L12 20.8 L4 16.1 L4 6.9 Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        {/* top-face + back edges, faint so the flame reads inside the volume */}
        <path
          d="M4 6.9 L12 11.4 L20 6.9 M12 11.4 L12 20.8"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinejoin="round"
          opacity="0.4"
        />
        {/* flame inside the cube */}
        <g className="flame" transform="translate(12 15.55) scale(0.92) translate(-12 -5.05)">
          <path
            d="M12 0.7 C13.9 3.2 15.1 4.4 15.1 6.4 C15.1 8.2 13.7 9.4 12 9.4 C10.3 9.4 8.9 8.1 8.9 6.4 C8.9 5.1 9.5 4.3 10.1 3.6 C10.3 4.5 10.7 4.9 11.2 5 C10.8 3.5 11.2 1.9 12 0.7 Z"
            fill={`url(#flm-${gid})`}
          />
          <path
            d="M12 3.9 C12.95 5.1 13.4 5.8 13.4 6.8 C13.4 7.8 12.8 8.4 12 8.4 C11.2 8.4 10.6 7.8 10.6 6.9 C10.6 6.2 10.9 5.8 11.3 5.4 C11.4 6 11.7 6.3 12 6.3 C11.7 5.4 11.7 4.6 12 3.9 Z"
            fill="#ecfccb"
          />
        </g>
      </svg>
    </span>
  );
}
