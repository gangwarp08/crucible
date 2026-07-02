// asaya design tokens — single source of truth for the warm earthy light UI.
//
// Brand palette: pine #28352F (text / dark surfaces), sage #7FA895 (secondary /
// success), sand #F4ECDE (background), clay #C67C5B (primary accent / CTA),
// gold #DDA75C (highlights).
//
// Every visual primitive (components/ui/*) and every page-level component
// imports from here. Direct hexes in components are a smell — if you find
// yourself writing one, add it as a token first.
//
// Names follow role.variant. Variants are coarse (subtle / default /
// elevated) rather than numbered scales so palette adjustments stay local.

export const color = {
  bg: {
    page:     "#F4ECDE",   // sand — main canvas
    panel:    "#FBF6EA",   // raised surfaces (cards, panes) — warm cream
    elevated: "#FFFDF9",   // panel-on-panel (headers, toolbars, dropdowns) — near white
    input:    "#FFFFFF",   // form controls — white for inset contrast on sand
    hover:    "#EFE6D5",   // hover-row background (slightly deeper sand)
    selected: "#F1E0D4",   // selected-row background (clay-tinted)
  },
  border: {
    subtle:  "rgba(40, 53, 47, 0.08)",   // inset dividers (pine @ low alpha)
    default: "rgba(40, 53, 47, 0.14)",   // panel borders, form-control borders
    strong:  "rgba(40, 53, 47, 0.24)",   // emphasized borders
  },
  text: {
    primary:   "#28352F",   // pine — headings, body
    secondary: "#5E6B64",   // muted pine — labels, muted prose
    muted:     "#8A9389",   // captions, placeholders, disabled
    inverse:   "#FBF6EA",   // cream — text on accent/dark backgrounds (primary CTAs)
  },
  accent: {
    // Primary action color = clay. The warm family below is the semantic set
    // used for gradients, glows, and emphasis.
    base:    "#C67C5B",                       // clay — primary / CTA
    hover:   "#B96C4C",                       // deeper clay for hover
    soft:    "rgba(198, 124, 91, 0.12)",       // accent-tinted backgrounds
    softer:  "rgba(198, 124, 91, 0.06)",
    // Warm family — used for gradient buttons, telemetry bars, emphasis text.
    amber:   "#DDA75C",                        // gold
    yellow:  "#E8C07A",                        // light gold
    ember:   "#B85C3A",                        // deep clay
    // Glow halo used in box-shadows (button/card hover, backdrop).
    glow:    "rgba(198, 124, 91, 0.35)",
  },
  success: {
    base: "#5E9179",                           // sage, deepened for text contrast on light
    soft: "rgba(127, 168, 149, 0.20)",         // sage tint
  },
  warn: {
    base: "#B98330",                           // gold, deepened for text contrast on light
    soft: "rgba(221, 167, 92, 0.20)",          // gold tint
  },
  error: {
    base: "#BC4B3C",                           // warm brick red (fits the earthy palette)
    soft: "rgba(188, 75, 60, 0.12)",
  },
  // Persona/role colors for transcript bubbles — drawn from the brand palette,
  // kept distinguishable from one another.
  persona: {
    candidate: "#28352F",  // the user themselves — pine
    client:    "#C67C5B",  // clay — brand-y stakeholder
    team:      "#B98330",  // gold — internal colleague
    system:    "#8A9389",  // muted — neutral
    assistant: "#5E9179",  // sage — distinct from the clay CTA
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
  // Soft, warm-tinted elevation for a light surface (pine @ low alpha).
  sm: "0 1px 2px rgba(40, 53, 47, 0.10)",
  md: "0 4px 12px rgba(40, 53, 47, 0.12)",
  lg: "0 12px 32px rgba(40, 53, 47, 0.16)",
  // Clay-accent halo — used on primary-button hover, card hover, backdrop.
  glow:       "0 8px 40px -8px rgba(198, 124, 91, 0.35)",
  glowSubtle: "0 0 30px -10px rgba(198, 124, 91, 0.22)",
} as const;

export const motion = {
  fast: "120ms cubic-bezier(0.2, 0, 0.2, 1)",
  med:  "200ms cubic-bezier(0.2, 0, 0.2, 1)",
} as const;

// Gradients used by primary buttons and emphasis headlines. Centralized
// because the same stop order recurs across the design. (Names kept for
// back-compat; palette is now clay → gold.)
export const gradient = {
  fire:     "linear-gradient(100deg, #DDA75C, #C67C5B)",
  fireSoft: "linear-gradient(100deg, #E8C07A, #DDA75C 40%, #C67C5B)",
  // Used by telemetry bar fills.
  bar:      "linear-gradient(90deg, #B85C3A, #C67C5B 45%, #DDA75C 78%, #E8C07A)",
} as const;

// Score-color helper used by the recruiter scorecard. Single source for the
// 1-5 score → token mapping. (Was duplicated as hexes across review/*.)
export function scoreColor(score: number): string {
  if (score >= 4.5) return color.success.base;
  if (score >= 3.5) return color.accent.amber;
  if (score >= 2.5) return color.warn.base;
  return color.error.base;
}
