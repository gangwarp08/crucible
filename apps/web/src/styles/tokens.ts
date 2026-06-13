// Crucible design tokens — single source of truth for the fire-theme dark UI.
//
// Every visual primitive (components/ui/*) and every page-level component
// imports from here. Direct hexes in components are a smell — if you find
// yourself writing one, add it as a token first.
//
// Names follow role.variant. Variants are coarse (subtle / default /
// elevated) rather than numbered scales so palette adjustments stay local.

export const color = {
  bg: {
    page:     "#000000",   // true black canvas — matches the design's --bg
    panel:    "#0a0908",   // raised surfaces (cards, panes) — design --panel-solid
    elevated: "#0d0b09",   // panel-on-panel (headers, toolbars, dropdowns)
    input:    "#060504",   // form controls — deepest panel for inset feel
    hover:    "#100e0b",   // hover-row background (warm-tinted)
    selected: "#15110d",   // selected-row background (paired with accent text)
  },
  border: {
    subtle:  "rgba(245, 242, 238, 0.08)",   // inset dividers, table row dividers
    default: "rgba(245, 242, 238, 0.10)",   // panel borders, form-control borders — design --line
    strong:  "rgba(245, 242, 238, 0.20)",   // emphasized borders — design --line-strong
  },
  text: {
    primary:   "#f4f2ee",   // headings, body — design --white (warm off-white)
    secondary: "#928c86",   // labels, muted prose — design --muted
    muted:     "#5c5752",   // captions, placeholders, disabled — design --muted-2
    inverse:   "#140a00",   // text on accent backgrounds (primary CTAs)
  },
  accent: {
    // Primary action color = fire orange. The fire palette below is the
    // semantic family used for gradients, glows, and emphasis.
    base:    "#ff6a00",                       // design --orange / --accent
    hover:   "#ff9500",                       // design --amber / --accent-2
    soft:    "rgba(255, 106, 0, 0.10)",        // accent-tinted backgrounds
    softer:  "rgba(255, 106, 0, 0.05)",
    // Fire family — used for gradient buttons, telemetry bars, fire-text.
    amber:   "#ff9500",
    yellow:  "#ffcc00",
    ember:   "#ff3d00",
    // Glow halo used in box-shadows (button hover, card hover, cube backdrop).
    glow:    "rgba(255, 106, 0, 0.45)",
  },
  success: {
    base: "#56d6a8",
    soft: "rgba(86, 214, 168, 0.12)",
  },
  warn: {
    base: "#e0b66e",
    soft: "rgba(224, 182, 110, 0.12)",
  },
  error: {
    base: "#ff7a7a",
    soft: "rgba(255, 122, 122, 0.10)",
  },
  // Persona/role colors for transcript bubbles. Warm-tinted to fit the fire
  // theme while staying distinguishable from one another.
  persona: {
    candidate: "#f4f2ee",  // the user themselves — off-white
    client:    "#ff9500",  // amber — brand-y stakeholder
    team:      "#ffcc00",  // yellow — internal colleague
    system:    "#928c86",  // muted gray — neutral
    assistant: "#ff8a3d",  // warm coral — distinct from CTA orange
  },
} as const;

export const space = {
  0: "0",
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  7: "32px",
  8: "40px",
  9: "48px",
  10: "64px",
} as const;

export const radius = {
  // The fire theme runs tight, square-ish corners.
  sm: "2px",
  md: "3px",
  lg: "4px",
  pill: "999px",
} as const;

export const font = {
  // Loaded once via next/font in app/layout.tsx and exposed as CSS vars.
  // The design system uses IBM Plex Mono for headlines/labels/data and IBM
  // Plex Sans for body — terminal/IDE energy that fits the product.
  sans: "var(--font-sans, 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif)",
  mono: "var(--font-mono, 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
} as const;

export const size = {
  // Type scale. ui-* values are line-height-paired in components.
  uiXs: "10px",
  uiSm: "11px",
  ui:   "13px",
  uiMd: "14px",
  uiLg: "16px",
  uiXl: "20px",
  h3:   "16px",
  h2:   "20px",
  h1:   "26px",
  display: "32px",
} as const;

export const shadow = {
  none: "none",
  sm: "0 1px 2px rgba(0, 0, 0, 0.35)",
  md: "0 4px 12px rgba(0, 0, 0, 0.40)",
  lg: "0 12px 32px rgba(0, 0, 0, 0.50)",
  // Fire-accent halo — used on primary-button hover, card hover, hero
  // backdrop. The design's recurring "glow" treatment.
  glow:       "0 8px 40px -8px rgba(255, 106, 0, 0.45)",
  glowSubtle: "0 0 30px -10px rgba(255, 106, 0, 0.30)",
} as const;

export const motion = {
  fast: "120ms cubic-bezier(0.2, 0, 0.2, 1)",
  med:  "200ms cubic-bezier(0.2, 0, 0.2, 1)",
} as const;

// Gradients used by primary buttons and fire-text headlines. Centralized
// because the same stop order recurs across the design.
export const gradient = {
  fire:     "linear-gradient(100deg, #ff9500, #ff6a00)",
  fireSoft: "linear-gradient(100deg, #ffcc00, #ff9500 40%, #ff6a00)",
  // Used by telemetry bar fills.
  bar:      "linear-gradient(90deg, #ff3d00, #ff6a00 45%, #ff9500 78%, #ffcc00)",
} as const;

// Score-color helper used by the recruiter scorecard. Single source for the
// 1-5 score → token mapping. (Was duplicated as hexes across review/*.)
export function scoreColor(score: number): string {
  if (score >= 4.5) return color.success.base;
  if (score >= 3.5) return color.accent.amber;
  if (score >= 2.5) return color.warn.base;
  return color.error.base;
}
