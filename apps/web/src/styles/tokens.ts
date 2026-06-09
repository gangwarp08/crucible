// Crucible design tokens — single source of truth for the dark theme.
//
// Every visual primitive (components/ui/*) and every page-level component
// imports from here. Direct hexes in components are a smell — if you find
// yourself writing one, add it as a token first.
//
// Names follow role.variant. Variants are coarse (subtle / default /
// elevated) rather than numbered scales so palette adjustments stay local.

export const color = {
  bg: {
    page:     "#0c0c10",   // app background
    panel:    "#15151b",   // raised surfaces (cards, panes)
    elevated: "#1c1c24",   // panel-on-panel (headers, toolbars, dropdowns)
    input:    "#0f0f14",   // form controls — slightly darker than page for inset feel
    hover:    "#1f1f28",   // hover-row background
    selected: "#22222e",   // selected-row background (paired with accent text)
  },
  border: {
    subtle:  "#1c1c25",    // inset dividers, table row dividers
    default: "#2a2a36",    // panel borders, form-control borders
    strong:  "#3a3a48",    // emphasized borders (active form control)
  },
  text: {
    primary:   "#e6e6ea",  // headings, body
    secondary: "#a0a0ad",  // labels, muted prose
    muted:     "#6a6a78",  // captions, placeholders, disabled
    inverse:   "#0c0c10",  // text on accent backgrounds (rare)
  },
  accent: {
    base:    "#7c7fff",    // primary action, focus ring, active accent
    hover:   "#9396ff",
    soft:    "rgba(124, 127, 255, 0.10)",  // accent-tinted backgrounds (selected tab, accent badge)
    softer:  "rgba(124, 127, 255, 0.05)",
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
  // Persona/role colors for transcript bubbles, sparingly used.
  persona: {
    candidate: "#7c7fff",  // matches accent
    client:    "#56d6a8",  // success-leaning teal — calm/business
    team:      "#e0b66e",  // warn-leaning amber — collaborative/friendly
    system:    "#a0a0ad",  // secondary text
    assistant: "#9b87ff",  // softer purple — AI
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
  sm: "4px",
  md: "6px",
  lg: "10px",
  pill: "999px",
} as const;

export const font = {
  // Loaded once via next/font in app/layout.tsx and exposed as CSS vars.
  sans: "var(--font-sans, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif)",
  mono: "var(--font-mono, ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace)",
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
} as const;

export const motion = {
  fast: "120ms cubic-bezier(0.2, 0, 0.2, 1)",
  med:  "200ms cubic-bezier(0.2, 0, 0.2, 1)",
} as const;

// Score-color helper used by the recruiter scorecard. Single source for the
// 1-5 score → token mapping. (Was duplicated as hexes across review/*.)
export function scoreColor(score: number): string {
  if (score >= 4.5) return color.success.base;
  if (score >= 3.5) return color.accent.base;
  if (score >= 2.5) return color.warn.base;
  return color.error.base;
}
