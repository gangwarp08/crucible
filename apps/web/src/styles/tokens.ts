// asaya design tokens — single source of truth for the brand dark UI.
//
// Palette follows the asaya brand system: a near-black green-charcoal
// canvas, warm off-white type, and a single lime accent. One accent,
// used sparingly — everything else is neutral.
//
// Every visual primitive (components/ui/*) and every page-level component
// imports from here. Direct hexes in components are a smell — if you find
// yourself writing one, add it as a token first.
//
// Names follow role.variant. Variants are coarse (subtle / default /
// elevated) rather than numbered scales so palette adjustments stay local.

export const color = {
  bg: {
    page:     "#0f1310",   // green-charcoal canvas — brand --bg
    panel:    "#151a16",   // raised surfaces (cards, panes)
    elevated: "#1a201b",   // panel-on-panel (headers, toolbars, dropdowns)
    input:    "#0b0e0c",   // form controls — deepest panel for inset feel
    hover:    "#1b211c",   // hover-row background
    selected: "#212823",   // selected-row background (paired with accent text)
  },
  border: {
    subtle:  "rgba(236, 238, 233, 0.08)",   // inset dividers, table row dividers
    default: "rgba(236, 238, 233, 0.11)",   // panel borders, form-control borders
    strong:  "rgba(236, 238, 233, 0.22)",   // emphasized borders
  },
  text: {
    primary:   "#eceee9",   // headings, body — warm off-white
    secondary: "#9aa094",   // labels, muted prose
    muted:     "#5f665c",   // captions, placeholders, disabled
    inverse:   "#10140a",   // text on accent backgrounds (primary CTAs)
  },
  accent: {
    // Primary action color = brand lime. The lime family below is the
    // semantic family used for emphasis, fills, and data viz.
    base:    "#a3e635",                        // brand lime — the accent
    hover:   "#bef264",                        // lighter lime for hover states
    soft:    "rgba(163, 230, 53, 0.10)",       // accent-tinted backgrounds
    softer:  "rgba(163, 230, 53, 0.05)",
    // Lime family — used for emphasis text, telemetry bars, spectrum fills.
    bright:  "#bef264",
    pale:    "#d9f99d",
    deep:    "#65a30d",
    // Halo used in box-shadows (button hover, card hover). Kept subtle.
    glow:    "rgba(163, 230, 53, 0.30)",
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
  // Persona/role colors for transcript bubbles. One brand accent plus
  // neutrals and a single auxiliary teal so roles stay distinguishable
  // without breaking the minimal palette.
  persona: {
    candidate: "#eceee9",  // the user themselves — off-white
    client:    "#a3e635",  // lime — brand-y stakeholder
    team:      "#6fc7b2",  // teal — internal colleague
    system:    "#9aa094",  // muted gray — neutral
    assistant: "#d9f99d",  // pale lime — the AI, adjacent to brand
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
  // The brand runs tight, square-ish corners.
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
  // Accent halo — used sparingly on primary-button hover.
  glow:       "0 8px 40px -8px rgba(163, 230, 53, 0.30)",
  glowSubtle: "0 0 30px -10px rgba(163, 230, 53, 0.20)",
} as const;

export const motion = {
  fast: "120ms cubic-bezier(0.2, 0, 0.2, 1)",
  med:  "200ms cubic-bezier(0.2, 0, 0.2, 1)",
} as const;

// Accent gradients — kept close to flat; the brand look is a solid lime
// with only the gentlest ramp for large fills and data bars.
export const gradient = {
  accent:     "linear-gradient(100deg, #bef264, #a3e635)",
  accentSoft: "linear-gradient(100deg, #d9f99d, #bef264 40%, #a3e635)",
  // Used by telemetry bar fills — deep→bright lime.
  bar:        "linear-gradient(90deg, #4d7c0f, #65a30d 45%, #a3e635 78%, #bef264)",
} as const;

// Score-color helper used by the recruiter scorecard. Single source for the
// 1-5 score → token mapping. (Was duplicated as hexes across review/*.)
export function scoreColor(score: number): string {
  if (score >= 4.5) return color.success.base;
  if (score >= 3.5) return color.accent.base;
  if (score >= 2.5) return color.warn.base;
  return color.error.base;
}
